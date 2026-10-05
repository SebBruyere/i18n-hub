/**
 * Single Vercel function serving every /api/* route (vercel.json rewrites
 * /api/(.*) here). One function keeps cold starts shared and stays far under
 * the Hobby plan's function limit.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { checkPassword, clearedCookie, hasPullToken, hasSession, sessionCookie } from './_lib/auth.js'
import { getSql, type Row, type Sql } from './_lib/db.js'
import { triggerTarget, validateTarget, type TargetConfig, type TargetType } from './_lib/deploy.js'
import { nest, sortFlat, type Flat, type Snapshot } from './_lib/format.js'
import { formsForLanguages, parsePluralKey, pluralKey, type PluralType } from './_lib/plurals.js'
import {
  HttpError,
  LANG_RE,
  SLUG_RE,
  optIds,
  optString,
  parseCookies,
  readBody,
  reqString,
  send,
  validateKey,
  type Ctx,
} from './_lib/http.js'

type Access = 'public' | 'session' | 'pull'
type Handler = (ctx: Ctx) => Promise<unknown>
interface Route {
  method: string
  re: RegExp
  names: string[]
  access: Access
  handler: Handler
}

const routes: Route[] = []
function on(method: string, pattern: string, access: Access, handler: Handler) {
  const names: string[] = []
  const source = pattern.replace(/:(\w+)/g, (_, name: string) => {
    names.push(name)
    return '([^/]+)'
  })
  routes.push({ method, re: new RegExp(`^${source}/?$`), names, access, handler })
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const method = (req.method ?? 'GET').toUpperCase()
  try {
    let pathMatched = false
    for (const route of routes) {
      const match = route.re.exec(url.pathname)
      if (!match) continue
      pathMatched = true
      if (route.method !== method) continue

      const cookies = parseCookies(req.headers.cookie)
      if (route.access === 'session' && !hasSession(cookies)) throw new HttpError(401, 'Sign in to continue')
      if (route.access === 'pull' && !hasPullToken(req) && !hasSession(cookies)) {
        throw new HttpError(401, 'Send the PULL_TOKEN as "Authorization: Bearer <token>"')
      }

      const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(match[i + 1])]))
      const body = method === 'GET' ? {} : await readBody(req)
      const result = await route.handler({ req, res, params, query: url.searchParams, body })
      if (!res.writableEnded) send(res, 200, result ?? { ok: true })
      return
    }
    throw pathMatched ? new HttpError(405, 'Method not allowed') : new HttpError(404, 'No such endpoint')
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message })
    if ((err as { code?: string }).code === '23505') return send(res, 409, { error: 'That name is already taken' })
    console.error(err)
    send(res, 500, { error: 'The server hit an unexpected error. Check the function logs on Vercel.' })
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

// A plural key counts once, as in the Strings tab: items_one + items_other are one key.
const PLURAL_SUFFIX_RE = '_(ordinal_)?(zero|one|two|few|many|other)$'

interface ProjectRow {
  id: number
  slug: string
  name: string
  base_language: string
  languages: string[]
  current_version: number | null
  content_updated_at: string
  published_at: string | null
  created_at: string
  key_count?: number
  latest_version?: number | null
}

function toProject(p: ProjectRow) {
  const latest = p.latest_version ?? null
  const hasUnpublished =
    p.published_at === null
      ? (p.key_count ?? 0) > 0
      : new Date(p.content_updated_at) > new Date(p.published_at) || (latest !== null && latest !== p.current_version)
  return {
    slug: p.slug,
    name: p.name,
    baseLanguage: p.base_language,
    languages: p.languages,
    currentVersion: p.current_version,
    latestVersion: latest,
    keyCount: p.key_count ?? 0,
    hasUnpublished,
    publishedAt: p.published_at,
    createdAt: p.created_at,
  }
}

async function loadProject(sql: Sql, slug: string): Promise<ProjectRow> {
  const [p] = await sql<ProjectRow>`
    SELECT p.*,
      (SELECT count(DISTINCT regexp_replace(k.key, ${PLURAL_SUFFIX_RE}, ''))::int FROM translation_keys k WHERE k.project_id = p.id) AS key_count,
      (SELECT max(version) FROM releases r WHERE r.project_id = p.id) AS latest_version
    FROM projects p WHERE p.slug = ${slug}`
  if (!p) throw new HttpError(404, `No project called "${slug}"`)
  return p
}

function parseLanguages(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, 'Add at least one language')
  const langs = [...new Set(value.map((v) => String(v).trim()))]
  for (const l of langs) {
    if (!LANG_RE.test(l)) throw new HttpError(400, `"${l}" is not a language code like en, fr or pt-BR`)
  }
  return langs
}

function assertLanguage(p: ProjectRow, lang: unknown): string {
  if (typeof lang !== 'string' || !p.languages.includes(lang)) {
    throw new HttpError(400, `"${String(lang)}" is not a language of this project`)
  }
  return lang
}

async function draftSnapshot(sql: Sql, projectId: number): Promise<Snapshot> {
  const rows = await sql<{ language: string; key: string; value: string }>`
    SELECT t.language, k.key, t.value
    FROM translations t JOIN translation_keys k ON k.id = t.key_id
    WHERE k.project_id = ${projectId}`
  const snap: Snapshot = {}
  for (const r of rows) (snap[r.language] ??= {})[r.key] = r.value
  return snap
}

/** The keys that make up a plural key: `base_one`, `base_other`… (or `base_ordinal_…`). */
async function pluralMembers(sql: Sql, projectId: number, base: string, type: PluralType) {
  const rows = await sql<{ id: number; key: string }>`
    SELECT id, key FROM translation_keys WHERE project_id = ${projectId} AND starts_with(key, ${base + '_'})`
  return rows.flatMap((r) => {
    const parsed = parsePluralKey(r.key)
    return parsed && parsed.base === base && parsed.type === type ? [{ id: r.id, key: r.key, form: parsed.form }] : []
  })
}

interface TargetRow {
  id: number
  name: string
  type: TargetType
  config: TargetConfig
  auto_on_publish: boolean
}

function toTarget(t: TargetRow) {
  return { id: t.id, name: t.name, type: t.type, config: t.config, autoOnPublish: t.auto_on_publish }
}

async function runTargets(sql: Sql, p: ProjectRow, ids: number[], version: number | null) {
  if (ids.length === 0) return []
  const targets = await sql<TargetRow>`
    SELECT * FROM deploy_targets
    WHERE project_id = ${p.id} AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::int)`
  const results = await Promise.all(
    targets.map(async (t) => ({ target: t, result: await triggerTarget(t, { project: p.slug, version }) })),
  )
  for (const { target, result } of results) {
    await sql`
      INSERT INTO deploy_logs (project_id, target_id, target_name, version, ok, status, message)
      VALUES (${p.id}, ${target.id}, ${target.name}, ${version}, ${result.ok}, ${result.status}, ${result.message})`
  }
  return results.map(({ target, result }) => ({ targetId: target.id, name: target.name, ...result }))
}

function touch(sql: Sql, projectId: number) {
  return sql`UPDATE projects SET content_updated_at = now() WHERE id = ${projectId}`
}

/* ------------------------------------------------------------------ */
/* auth                                                                */
/* ------------------------------------------------------------------ */

on('GET', '/api/auth/me', 'public', async ({ req }) => ({
  authenticated: hasSession(parseCookies(req.headers.cookie)),
}))

on('POST', '/api/auth/login', 'public', async ({ req, res, body }) => {
  if (!checkPassword(body.password)) throw new HttpError(401, 'That password is not right')
  res.setHeader('Set-Cookie', sessionCookie(req))
  return { authenticated: true }
})

on('POST', '/api/auth/logout', 'public', async ({ req, res }) => {
  res.setHeader('Set-Cookie', clearedCookie(req))
  return { authenticated: false }
})

/* ------------------------------------------------------------------ */
/* projects                                                            */
/* ------------------------------------------------------------------ */

on('GET', '/api/projects', 'session', async () => {
  const sql = await getSql()
  const rows = await sql<ProjectRow>`
    SELECT p.*,
      (SELECT count(DISTINCT regexp_replace(k.key, ${PLURAL_SUFFIX_RE}, ''))::int FROM translation_keys k WHERE k.project_id = p.id) AS key_count,
      (SELECT max(version) FROM releases r WHERE r.project_id = p.id) AS latest_version
    FROM projects p ORDER BY lower(p.name)`
  return { projects: rows.map(toProject) }
})

on('POST', '/api/projects', 'session', async ({ body }) => {
  const sql = await getSql()
  const name = reqString(body, 'name', 120).trim()
  const slug = reqString(body, 'slug', 63).trim()
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'Use lowercase letters, numbers and dashes for the slug')
  const languages = parseLanguages(body.languages)
  const base = typeof body.baseLanguage === 'string' ? body.baseLanguage : languages[0]
  if (!languages.includes(base)) languages.unshift(base)
  const [p] = await sql<ProjectRow>`
    INSERT INTO projects (slug, name, base_language, languages)
    VALUES (${slug}, ${name}, ${base}, ${JSON.stringify(languages)}::jsonb)
    RETURNING *`
  return { project: toProject(p) }
})

on('GET', '/api/projects/:slug', 'session', async ({ params }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  const [keys, live, targets] = await Promise.all([
    sql<{ key: string; description: string; values: Flat }>`
      SELECT k.key, k.description,
        coalesce(jsonb_object_agg(t.language, t.value) FILTER (WHERE t.language IS NOT NULL), '{}'::jsonb) AS values
      FROM translation_keys k LEFT JOIN translations t ON t.key_id = k.id
      WHERE k.project_id = ${p.id}
      GROUP BY k.id ORDER BY k.key`,
    p.current_version === null
      ? Promise.resolve([])
      : sql<{ version: number; snapshot: Snapshot; created_at: string }>`
          SELECT version, snapshot, created_at FROM releases
          WHERE project_id = ${p.id} AND version = ${p.current_version}`,
    sql<TargetRow>`SELECT * FROM deploy_targets WHERE project_id = ${p.id} ORDER BY created_at`,
  ])
  return {
    project: toProject(p),
    keys,
    live: live[0] ? { version: live[0].version, snapshot: live[0].snapshot, createdAt: live[0].created_at } : null,
    targets: targets.map(toTarget),
  }
})

on('PATCH', '/api/projects/:slug', 'session', async ({ params, body }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  const name = optString(body, 'name', 120)?.trim() || p.name
  const languages = body.languages === undefined ? p.languages : parseLanguages(body.languages)
  const base = typeof body.baseLanguage === 'string' ? body.baseLanguage : p.base_language
  if (!languages.includes(base)) throw new HttpError(400, 'The base language must be one of the project languages')
  const langsJson = JSON.stringify(languages)
  await sql`
    WITH removed AS (
      DELETE FROM translations t USING translation_keys k
      WHERE t.key_id = k.id AND k.project_id = ${p.id} AND NOT (${langsJson}::jsonb ? t.language)
    )
    UPDATE projects SET name = ${name}, base_language = ${base}, languages = ${langsJson}::jsonb,
      content_updated_at = now()
    WHERE id = ${p.id}`
  return { project: toProject(await loadProject(sql, p.slug)) }
})

on('DELETE', '/api/projects/:slug', 'session', async ({ params }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  await sql`DELETE FROM projects WHERE id = ${p.id}`
  return { deleted: true }
})

/* ------------------------------------------------------------------ */
/* keys & translations (keys travel in the body: they contain dots)    */
/* ------------------------------------------------------------------ */

on('POST', '/api/projects/:slug/keys', 'session', async ({ params, body }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  const key = validateKey(reqString(body, 'key', 255))
  const description = optString(body, 'description') ?? ''
  // A plural key is stored the way the files hold it: one key per form (items_one, items_other…),
  // with every form any project language needs, plus `zero` when asked (i18next uses key_zero
  // for a count of 0 in every language). Its values come as { lang: { form: text } }.
  const forms = body.plural === true ? formsForLanguages(p.languages, 'cardinal', body.zero === true) : null
  const keys = forms ? forms.map((f) => pluralKey(key, 'cardinal', f)) : [key]
  const values: { key: string; language: string; value: string }[] = []
  if (body.values && typeof body.values === 'object') {
    for (const [lang, value] of Object.entries(body.values as Record<string, unknown>)) {
      const language = assertLanguage(p, lang)
      if (!forms) {
        if (typeof value === 'string' && value !== '') values.push({ key, language, value })
        continue
      }
      for (const form of forms) {
        const text = (value as Record<string, unknown> | null)?.[form]
        if (typeof text === 'string' && text !== '') values.push({ key: pluralKey(key, 'cardinal', form), language, value: text })
      }
    }
  }
  if (forms) {
    const [clash] = await sql<{ key: string }>`
      SELECT key FROM translation_keys WHERE project_id = ${p.id}
        AND (key = ${key} OR key IN (SELECT jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb)))`
    if (clash) throw new HttpError(409, `"${clash.key}" already exists`)
  }
  await sql`
    WITH k AS (
      INSERT INTO translation_keys (project_id, key, description)
      SELECT ${p.id}, value, ${description} FROM jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb)
      RETURNING id, key
    ), t AS (
      INSERT INTO translations (key_id, language, value)
      SELECT k.id, x.language, x.value
      FROM k JOIN jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS x(key text, language text, value text) ON x.key = k.key
      RETURNING key_id, language, value
    ), history AS (
      INSERT INTO translation_history (key_id, language, value, previous, source)
      SELECT key_id, language, value, NULL, 'add' FROM t
    )
    UPDATE projects SET content_updated_at = now() WHERE id = ${p.id}`
  return { key: { key, description, forms } }
})

on('PATCH', '/api/projects/:slug/keys', 'session', async ({ params, body }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  const key = reqString(body, 'key', 255)
  const newKey = body.newKey === undefined ? null : validateKey(reqString(body, 'newKey', 255))
  const description = optString(body, 'description') ?? null
  if (body.plural === true) {
    // Every form moves with the key: items_one, items_other… become stock_one, stock_other…
    const type: PluralType = body.type === 'ordinal' ? 'ordinal' : 'cardinal'
    const members = await pluralMembers(sql, p.id, key, type)
    if (members.length === 0) throw new HttpError(404, `Plural key "${key}" does not exist`)
    const renames = members.map((m) => ({ id: m.id, key: newKey ? pluralKey(newKey, type, m.form) : m.key }))
    await sql`
      UPDATE translation_keys t SET key = x.key, description = coalesce(${description}::text, t.description)
      FROM jsonb_to_recordset(${JSON.stringify(renames)}::jsonb) AS x(id int, key text)
      WHERE t.id = x.id`
    if (newKey && newKey !== key) await touch(sql, p.id)
    return { key: { key: newKey ?? key, description } }
  }
  const rows = await sql`
    UPDATE translation_keys
    SET key = coalesce(${newKey}::text, key), description = coalesce(${description}::text, description)
    WHERE project_id = ${p.id} AND key = ${key}
    RETURNING key, description`
  if (!rows[0]) throw new HttpError(404, `Key "${key}" does not exist`)
  if (newKey && newKey !== key) await touch(sql, p.id)
  return { key: rows[0] }
})

/** Turns a key into a plural key (items → items_one, items_other…) or back (items_other → items). */
on('POST', '/api/projects/:slug/keys/plural', 'session', async ({ params, body }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  const key = reqString(body, 'key', 255)
  if (body.plural === true) {
    const [row] = await sql<{ id: number; description: string }>`
      SELECT id, description FROM translation_keys WHERE project_id = ${p.id} AND key = ${key}`
    if (!row) throw new HttpError(404, `Key "${key}" does not exist`)
    const forms = formsForLanguages(p.languages)
    const added = forms.filter((f) => f !== 'other').map((f) => pluralKey(key, 'cardinal', f))
    const [clash] = await sql<{ key: string }>`
      SELECT key FROM translation_keys WHERE project_id = ${p.id}
        AND key IN (SELECT jsonb_array_elements_text(${JSON.stringify([pluralKey(key, 'cardinal', 'other'), ...added])}::jsonb))`
    if (clash) throw new HttpError(409, `"${clash.key}" already exists`)
    // The current text becomes the "other" form, the one i18next falls back to.
    await sql`
      WITH renamed AS (UPDATE translation_keys SET key = ${pluralKey(key, 'cardinal', 'other')} WHERE id = ${row.id}),
      added AS (
        INSERT INTO translation_keys (project_id, key, description)
        SELECT ${p.id}, value, ${row.description} FROM jsonb_array_elements_text(${JSON.stringify(added)}::jsonb)
      )
      UPDATE projects SET content_updated_at = now() WHERE id = ${p.id}`
    return { key, plural: true, forms }
  }
  const type: PluralType = body.type === 'ordinal' ? 'ordinal' : 'cardinal'
  const members = await pluralMembers(sql, p.id, key, type)
  const other = members.find((m) => m.form === 'other')
  if (!other) throw new HttpError(404, `Plural key "${key}" does not exist`)
  const dropped = members.filter((m) => m !== other).map((m) => m.id)
  // The "other" form becomes the key; the other forms and their translations go.
  await sql`
    WITH dropped AS (
      DELETE FROM translation_keys WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(dropped)}::jsonb)::int)
    ), renamed AS (UPDATE translation_keys SET key = ${key} WHERE id = ${other.id})
    UPDATE projects SET content_updated_at = now() WHERE id = ${p.id}`
  return { key, plural: false }
})

/** Copies a key (all forms of a plural key) to `key_copy`, or `key_copy2`… when that's taken. */
on('POST', '/api/projects/:slug/keys/duplicate', 'session', async ({ params, body }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  const key = reqString(body, 'key', 255)
  const type: PluralType = body.type === 'ordinal' ? 'ordinal' : 'cardinal'
  const members =
    body.plural === true
      ? await pluralMembers(sql, p.id, key, type)
      : (await sql<{ id: number; key: string }>`
          SELECT id, key FROM translation_keys WHERE project_id = ${p.id} AND key = ${key}`).map((r) => ({ ...r, form: null }))
  if (members.length === 0) throw new HttpError(404, `Key "${key}" does not exist`)

  const nearby = new Set(
    (await sql<{ key: string }>`
      SELECT key FROM translation_keys WHERE project_id = ${p.id} AND starts_with(key, ${key + '_copy'})`).map((r) => r.key),
  )
  const taken = (name: string) => nearby.has(name) || [...nearby].some((k) => parsePluralKey(k)?.base === name)
  let name = `${key}_copy`
  for (let n = 2; taken(name); n++) name = `${key}_copy${n}`
  const copies = members.map((m) => ({ source_id: m.id, key: validateKey(m.form ? pluralKey(name, type, m.form) : name) }))

  await sql`
    WITH src AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(copies)}::jsonb) AS x(source_id int, key text)),
    k AS (
      INSERT INTO translation_keys (project_id, key, description)
      SELECT ${p.id}, src.key, tk.description FROM src JOIN translation_keys tk ON tk.id = src.source_id
      RETURNING id, key
    ), t AS (
      INSERT INTO translations (key_id, language, value)
      SELECT k.id, tr.language, tr.value FROM k JOIN src ON src.key = k.key JOIN translations tr ON tr.key_id = src.source_id
      RETURNING key_id, language, value
    ), history AS (
      INSERT INTO translation_history (key_id, language, value, previous, source)
      SELECT key_id, language, value, NULL, 'duplicate' FROM t
    )
    UPDATE projects SET content_updated_at = now() WHERE id = ${p.id}`
  return { key: name }
})

/**
 * Earlier values of some keys (a key, or every form of a plural key): recorded changes,
 * newest first, and the value each release published.
 */
on('POST', '/api/projects/:slug/keys/history', 'session', async ({ params, body }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  const keys = body.keys
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 20 || !keys.every((k) => typeof k === 'string')) {
    throw new HttpError(400, '"keys" must be a list of up to 20 keys')
  }
  const list = JSON.stringify(keys)
  const [edits, releases] = await Promise.all([
    sql<{ key: string; language: string; value: string | null; previous: string | null; source: string; changed_at: string }>`
      SELECT k.key, h.language, h.value, h.previous, h.source, h.changed_at
      FROM translation_history h JOIN translation_keys k ON k.id = h.key_id
      WHERE k.project_id = ${p.id} AND k.key IN (SELECT jsonb_array_elements_text(${list}::jsonb))
      ORDER BY h.changed_at DESC, h.id DESC LIMIT 300`,
    sql<{ version: number; created_at: string; language: string; key: string; value: string }>`
      SELECT r.version, r.created_at, l.key AS language, k.key, l.value ->> k.key AS value
      FROM releases r
      CROSS JOIN jsonb_each(r.snapshot) l
      CROSS JOIN jsonb_array_elements_text(${list}::jsonb) AS k(key)
      WHERE r.project_id = ${p.id} AND l.value ? k.key
      ORDER BY r.version DESC LIMIT 500`,
  ])
  return {
    edits: edits.map((e) => ({ key: e.key, language: e.language, value: e.value, previous: e.previous, source: e.source, changedAt: e.changed_at })),
    releases: releases.map((r) => ({ version: r.version, createdAt: r.created_at, language: r.language, key: r.key, value: r.value })),
  }
})

on('DELETE', '/api/projects/:slug/keys', 'session', async ({ params, body }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  const keys = body.keys
  if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string')) {
    throw new HttpError(400, '"keys" must be a list of keys')
  }
  const [r] = await sql<{ deleted: number }>`
    WITH d AS (
      DELETE FROM translation_keys
      WHERE project_id = ${p.id} AND key IN (SELECT jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb))
      RETURNING 1
    ), bump AS (
      UPDATE projects SET content_updated_at = now() WHERE id = ${p.id}
    )
    SELECT count(*)::int AS deleted FROM d`
  return r
})

on('PUT', '/api/projects/:slug/translations', 'session', async ({ params, body }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  const key = reqString(body, 'key', 255)
  const language = assertLanguage(p, body.language)
  if (typeof body.value !== 'string') throw new HttpError(400, '"value" must be a string')
  const value = body.value
  if (value.length > 20_000) throw new HttpError(400, 'Translations are limited to 20,000 characters')
  if (body.create === true && value !== '') {
    // A plural form a language needs but no other language had yet (Russian "few" next to
    // English one/other) only becomes a key once someone writes it. It shares the group's description.
    const form = parsePluralKey(validateKey(key))
    if (!form) throw new HttpError(400, `"${key}" is not a plural form`)
    await sql`
      INSERT INTO translation_keys (project_id, key, description)
      SELECT ${p.id}, ${key}, coalesce((
        SELECT description FROM translation_keys
        WHERE project_id = ${p.id} AND key = ${pluralKey(form.base, form.type, 'other')}
      ), '')
      ON CONFLICT (project_id, key) DO NOTHING`
  }

  // `old` reads the value before this statement changes it, so the history row knows what it replaced.
  const [r] =
    value === ''
      ? await sql<{ found: boolean }>`
          WITH k AS (SELECT id FROM translation_keys WHERE project_id = ${p.id} AND key = ${key}),
          old AS (SELECT t.key_id, t.value FROM translations t JOIN k ON k.id = t.key_id WHERE t.language = ${language}),
          d AS (DELETE FROM translations WHERE key_id IN (SELECT id FROM k) AND language = ${language}),
          history AS (
            INSERT INTO translation_history (key_id, language, value, previous, source)
            SELECT key_id, ${language}::text, NULL, value, 'edit' FROM old
          ),
          bump AS (UPDATE projects SET content_updated_at = now() WHERE id = ${p.id} AND EXISTS (SELECT 1 FROM k))
          SELECT EXISTS (SELECT 1 FROM k) AS found`
      : await sql<{ found: boolean }>`
          WITH k AS (SELECT id FROM translation_keys WHERE project_id = ${p.id} AND key = ${key}),
          old AS (SELECT t.value FROM translations t JOIN k ON k.id = t.key_id WHERE t.language = ${language}),
          up AS (
            INSERT INTO translations (key_id, language, value)
            SELECT id, ${language}, ${value} FROM k
            ON CONFLICT (key_id, language) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
          ),
          history AS (
            INSERT INTO translation_history (key_id, language, value, previous, source)
            SELECT k.id, ${language}::text, ${value}::text, (SELECT value FROM old), 'edit' FROM k
            WHERE (SELECT value FROM old) IS DISTINCT FROM ${value}::text
          ),
          bump AS (UPDATE projects SET content_updated_at = now() WHERE id = ${p.id} AND EXISTS (SELECT 1 FROM k))
          SELECT EXISTS (SELECT 1 FROM k) AS found`
  if (!r?.found) throw new HttpError(404, `Key "${key}" does not exist`)
  return { key, language, value }
})

on('POST', '/api/projects/:slug/import', 'session', async ({ params, body }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  const language = assertLanguage(p, body.language)
  const overwrite = body.overwrite === true
  const entries = body.entries
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new HttpError(400, '"entries" must be an object of key: value')
  }
  const list: { key: string; value: string }[] = []
  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof value !== 'string' || value === '') continue
    list.push({ key: validateKey(key.trim()), value })
  }
  if (list.length > 25_000) throw new HttpError(400, 'Import at most 25,000 keys at a time')
  if (list.length === 0) return { newKeys: 0, created: 0, updated: 0, unchanged: 0 }

  const [r] = await sql<{ new_keys: number; created: number; updated: number }>`
    WITH input AS (
      SELECT DISTINCT ON (key) key, value FROM jsonb_to_recordset(${JSON.stringify(list)}::jsonb) AS x(key text, value text)
    ), new_keys AS (
      INSERT INTO translation_keys (project_id, key)
      SELECT ${p.id}, key FROM input
      ON CONFLICT (project_id, key) DO NOTHING
      RETURNING id, key
    ), all_keys AS (
      SELECT id, key FROM new_keys
      UNION ALL
      SELECT k.id, k.key FROM translation_keys k JOIN input i ON i.key = k.key WHERE k.project_id = ${p.id}
    ), previous AS (
      SELECT t.key_id, t.value FROM translations t JOIN all_keys a ON a.id = t.key_id WHERE t.language = ${language}
    ), upserted AS (
      INSERT INTO translations (key_id, language, value)
      SELECT a.id, ${language}, i.value FROM all_keys a JOIN input i ON i.key = a.key
      ON CONFLICT (key_id, language) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        WHERE ${overwrite}::boolean AND translations.value IS DISTINCT FROM EXCLUDED.value
      RETURNING key_id, value, (xmax = 0) AS inserted
    ), history AS (
      INSERT INTO translation_history (key_id, language, value, previous, source)
      SELECT u.key_id, ${language}::text, u.value, pv.value, 'import'
      FROM upserted u LEFT JOIN previous pv ON pv.key_id = u.key_id
    ), bump AS (
      UPDATE projects SET content_updated_at = now() WHERE id = ${p.id}
    )
    SELECT
      (SELECT count(*)::int FROM new_keys) AS new_keys,
      (SELECT count(*)::int FROM upserted WHERE inserted) AS created,
      (SELECT count(*)::int FROM upserted WHERE NOT inserted) AS updated`
  return {
    newKeys: r.new_keys,
    created: r.created,
    updated: r.updated,
    unchanged: list.length - r.created - r.updated,
  }
})

/* ------------------------------------------------------------------ */
/* releases                                                            */
/* ------------------------------------------------------------------ */

on('GET', '/api/projects/:slug/releases', 'session', async ({ params }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  const rows = await sql<{ version: number; note: string; key_count: number; created_at: string }>`
    SELECT version, note, key_count, created_at FROM releases
    WHERE project_id = ${p.id} ORDER BY version DESC LIMIT 200`
  return {
    releases: rows.map((r) => ({
      version: r.version,
      note: r.note,
      keyCount: r.key_count,
      createdAt: r.created_at,
      isLive: r.version === p.current_version,
    })),
  }
})

on('POST', '/api/projects/:slug/releases', 'session', async ({ params, body }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  const note = optString(body, 'note', 500)?.trim() ?? ''
  const targetIds = optIds(body, 'targetIds')
  // Snapshot, version bump and "live" pointer in one statement so they can't drift apart.
  const [release] = await sql<{ version: number; note: string; key_count: number; created_at: string }>`
    WITH draft AS (
      SELECT t.language, jsonb_object_agg(k.key, t.value) AS entries
      FROM translation_keys k JOIN translations t ON t.key_id = k.id
      WHERE k.project_id = ${p.id} GROUP BY t.language
    ), snap AS (
      SELECT coalesce(jsonb_object_agg(language, entries), '{}'::jsonb) AS snapshot FROM draft
    ), next AS (
      SELECT coalesce(max(version), 0) + 1 AS v FROM releases WHERE project_id = ${p.id}
    ), ins AS (
      INSERT INTO releases (project_id, version, note, snapshot, key_count)
      SELECT ${p.id}, next.v, ${note}, snap.snapshot,
        (SELECT count(*) FROM translation_keys WHERE project_id = ${p.id})
      FROM next, snap
      RETURNING version, note, key_count, created_at
    ), live AS (
      UPDATE projects SET current_version = (SELECT version FROM ins), published_at = now() WHERE id = ${p.id}
    )
    SELECT * FROM ins`
  const deploys = await runTargets(sql, p, targetIds, release.version)
  return {
    release: { version: release.version, note: release.note, keyCount: release.key_count, createdAt: release.created_at, isLive: true },
    deploys,
  }
})

on('GET', '/api/projects/:slug/releases/:version', 'session', async ({ params }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  const [r] = await sql`
    SELECT version, note, snapshot, created_at FROM releases
    WHERE project_id = ${p.id} AND version = ${Number(params.version)}`
  if (!r) throw new HttpError(404, `Release v${params.version} does not exist`)
  return { version: r.version, note: r.note, createdAt: r.created_at, snapshot: r.snapshot }
})

on('POST', '/api/projects/:slug/releases/:version/activate', 'session', async ({ params, body }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  const version = Number(params.version)
  const rows = await sql`
    UPDATE projects SET current_version = ${version}
    WHERE id = ${p.id} AND EXISTS (SELECT 1 FROM releases WHERE project_id = ${p.id} AND version = ${version})
    RETURNING id`
  if (!rows[0]) throw new HttpError(404, `Release v${version} does not exist`)
  const deploys = await runTargets(sql, p, optIds(body, 'targetIds'), version)
  return { currentVersion: version, deploys }
})

/* ------------------------------------------------------------------ */
/* deploy targets                                                      */
/* ------------------------------------------------------------------ */

on('POST', '/api/projects/:slug/targets', 'session', async ({ params, body }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  const name = reqString(body, 'name', 80).trim()
  const { type, config } = validateTarget(body.type, body.config)
  const auto = body.autoOnPublish !== false
  const [t] = await sql<TargetRow>`
    INSERT INTO deploy_targets (project_id, name, type, config, auto_on_publish)
    VALUES (${p.id}, ${name}, ${type}, ${JSON.stringify(config)}::jsonb, ${auto})
    RETURNING *`
  return { target: toTarget(t) }
})

on('PATCH', '/api/projects/:slug/targets/:id', 'session', async ({ params, body }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  const [existing] = await sql<TargetRow>`
    SELECT * FROM deploy_targets WHERE id = ${Number(params.id)} AND project_id = ${p.id}`
  if (!existing) throw new HttpError(404, 'That deploy target does not exist')
  const name = optString(body, 'name', 80)?.trim() || existing.name
  const { type, config } = validateTarget(body.type ?? existing.type, body.config ?? existing.config)
  const auto = typeof body.autoOnPublish === 'boolean' ? body.autoOnPublish : existing.auto_on_publish
  const [t] = await sql<TargetRow>`
    UPDATE deploy_targets
    SET name = ${name}, type = ${type}, config = ${JSON.stringify(config)}::jsonb, auto_on_publish = ${auto}
    WHERE id = ${existing.id} RETURNING *`
  return { target: toTarget(t) }
})

on('DELETE', '/api/projects/:slug/targets/:id', 'session', async ({ params }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  await sql`DELETE FROM deploy_targets WHERE id = ${Number(params.id)} AND project_id = ${p.id}`
  return { deleted: true }
})

on('POST', '/api/projects/:slug/targets/:id/trigger', 'session', async ({ params }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  const [result] = await runTargets(sql, p, [Number(params.id)], p.current_version)
  if (!result) throw new HttpError(404, 'That deploy target does not exist')
  return { deploy: result }
})

on('GET', '/api/projects/:slug/deploys', 'session', async ({ params }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  const rows = await sql`
    SELECT id, target_id, target_name, version, ok, status, message, created_at
    FROM deploy_logs WHERE project_id = ${p.id} ORDER BY created_at DESC LIMIT 40`
  return {
    deploys: rows.map((r: Row) => ({
      id: r.id,
      targetId: r.target_id,
      name: r.target_name,
      version: r.version,
      ok: r.ok,
      status: r.status,
      message: r.message,
      createdAt: r.created_at,
    })),
  }
})

/* ------------------------------------------------------------------ */
/* pull — what builds and `i18n-pull.mjs` call                         */
/* ------------------------------------------------------------------ */

on('GET', '/api/pull/:slug', 'pull', async ({ params, query }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  const requested = query.get('version') || 'current'
  const format = query.get('format') === 'nested' ? 'nested' : 'flat'
  const fallback = ['1', 'true'].includes(query.get('fallback') ?? '')
  const onlyLang = query.get('lang')

  let version: number | 'draft'
  let publishedAt: string | null = null
  let snapshot: Snapshot
  if (requested === 'draft') {
    version = 'draft'
    snapshot = await draftSnapshot(sql, p.id)
  } else {
    const wanted =
      requested === 'current' ? p.current_version : requested === 'latest' ? (p.latest_version ?? null) : Number(requested)
    if (wanted === null) {
      throw new HttpError(404, `Nothing is published for "${p.slug}" yet. Publish a release, or pull with version=draft.`)
    }
    if (!Number.isInteger(wanted)) throw new HttpError(400, 'version must be current, latest, draft or a number')
    const [r] = await sql<{ version: number; snapshot: Snapshot; created_at: string }>`
      SELECT version, snapshot, created_at FROM releases WHERE project_id = ${p.id} AND version = ${wanted}`
    if (!r) throw new HttpError(404, `Release v${wanted} does not exist`)
    version = r.version
    publishedAt = r.created_at
    snapshot = r.snapshot
  }

  const languages: Record<string, unknown> = {}
  const base = snapshot[p.base_language] ?? {}
  for (const lang of p.languages) {
    let flat: Flat = snapshot[lang] ?? {}
    if (fallback && lang !== p.base_language) flat = { ...base, ...flat }
    flat = sortFlat(flat)
    try {
      languages[lang] = format === 'nested' ? nest(flat) : flat
    } catch (err) {
      throw new HttpError(422, `${lang}: ${(err as Error).message}. Pull with format=flat or rename the key.`)
    }
  }

  if (onlyLang) {
    if (!(onlyLang in languages)) throw new HttpError(404, `"${onlyLang}" is not a language of this project`)
    return languages[onlyLang]
  }
  return { project: p.slug, version, publishedAt, baseLanguage: p.base_language, languages }
})
