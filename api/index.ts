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
      (SELECT count(*)::int FROM translation_keys k WHERE k.project_id = p.id) AS key_count,
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
      (SELECT count(*)::int FROM translation_keys k WHERE k.project_id = p.id) AS key_count,
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
  const values: Flat = {}
  if (body.values && typeof body.values === 'object') {
    for (const [lang, value] of Object.entries(body.values as Record<string, unknown>)) {
      if (typeof value === 'string' && value !== '') values[assertLanguage(p, lang)] = value
    }
  }
  await sql`
    WITH k AS (
      INSERT INTO translation_keys (project_id, key, description)
      VALUES (${p.id}, ${key}, ${description}) RETURNING id
    ), t AS (
      INSERT INTO translations (key_id, language, value)
      SELECT k.id, x.key, x.value FROM k, jsonb_each_text(${JSON.stringify(values)}::jsonb) x
    )
    UPDATE projects SET content_updated_at = now() WHERE id = ${p.id}`
  return { key: { key, description, values } }
})

on('PATCH', '/api/projects/:slug/keys', 'session', async ({ params, body }) => {
  const sql = await getSql()
  const p = await loadProject(sql, params.slug)
  const key = reqString(body, 'key', 255)
  const newKey = body.newKey === undefined ? null : validateKey(reqString(body, 'newKey', 255))
  const description = optString(body, 'description') ?? null
  const rows = await sql`
    UPDATE translation_keys
    SET key = coalesce(${newKey}::text, key), description = coalesce(${description}::text, description)
    WHERE project_id = ${p.id} AND key = ${key}
    RETURNING key, description`
  if (!rows[0]) throw new HttpError(404, `Key "${key}" does not exist`)
  if (newKey && newKey !== key) await touch(sql, p.id)
  return { key: rows[0] }
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

  const [r] =
    value === ''
      ? await sql<{ found: boolean }>`
          WITH k AS (SELECT id FROM translation_keys WHERE project_id = ${p.id} AND key = ${key}),
          d AS (DELETE FROM translations WHERE key_id IN (SELECT id FROM k) AND language = ${language}),
          bump AS (UPDATE projects SET content_updated_at = now() WHERE id = ${p.id} AND EXISTS (SELECT 1 FROM k))
          SELECT EXISTS (SELECT 1 FROM k) AS found`
      : await sql<{ found: boolean }>`
          WITH k AS (SELECT id FROM translation_keys WHERE project_id = ${p.id} AND key = ${key}),
          up AS (
            INSERT INTO translations (key_id, language, value)
            SELECT id, ${language}, ${value} FROM k
            ON CONFLICT (key_id, language) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
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
    ), upserted AS (
      INSERT INTO translations (key_id, language, value)
      SELECT a.id, ${language}, i.value FROM all_keys a JOIN input i ON i.key = a.key
      ON CONFLICT (key_id, language) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        WHERE ${overwrite}::boolean AND translations.value IS DISTINCT FROM EXCLUDED.value
      RETURNING (xmax = 0) AS inserted
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
