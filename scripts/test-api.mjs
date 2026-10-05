/**
 * End-to-end API check against an in-memory Postgres (PGlite) — no Neon needed.
 *   npm run test:api
 */
import { PGlite } from '@electric-sql/pglite'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createViteServer } from 'vite'

process.env.APP_PASSWORD = 'test-password'
process.env.PULL_TOKEN = 'test-pull-token'

const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const { setSql } = await vite.ssrLoadModule('/api/_lib/db.ts')
const { default: handler } = await vite.ssrLoadModule('/api/index.ts')

const pg = new PGlite()
const sql = (strings, ...values) => {
  let text = strings[0]
  values.forEach((_, i) => (text += `$${i + 1}${strings[i + 1]}`))
  return pg.query(text, values).then((r) => r.rows)
}
sql.query = (text, params = []) => pg.query(text, params).then((r) => r.rows)
setSql(sql)

const server = createHttpServer((req, res) => handler(req, res))
await new Promise((r) => server.listen(0, r))
const base = `http://localhost:${server.address().port}`
let cookie = ''

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  return { status: res.status, data: await res.json() }
}

let step = 0
const ok = (label) => console.log(`  ✓ ${String(++step).padStart(2)} ${label}`)

let r = await call('GET', '/api/auth/me')
assert.equal(r.data.authenticated, false)
r = await call('GET', '/api/projects')
assert.equal(r.status, 401)
r = await call('POST', '/api/auth/login', { password: 'nope' })
assert.equal(r.status, 401)
r = await call('POST', '/api/auth/login', { password: 'test-password' })
assert.equal(r.status, 200)
assert.ok(cookie.startsWith('i18n_hub_session='))
ok('auth: login required, wrong password rejected, session cookie set')

r = await call('POST', '/api/projects', { name: 'Web app', slug: 'web-app', languages: ['en', 'fr'], baseLanguage: 'en' })
assert.equal(r.status, 200, JSON.stringify(r.data))
r = await call('POST', '/api/projects', { name: 'Dup', slug: 'web-app', languages: ['en'] })
assert.equal(r.status, 409)
r = await call('POST', '/api/projects', { name: 'Bad', slug: 'Bad Slug', languages: ['en'] })
assert.equal(r.status, 400)
ok('projects: create, duplicate slug → 409, invalid slug → 400')

r = await call('POST', '/api/projects/web-app/import', {
  language: 'en',
  entries: { 'home.title': 'Hello', 'home.cta': 'Start', footer: 'Bye', empty: '' },
})
assert.deepEqual(r.data, { newKeys: 3, created: 3, updated: 0, unchanged: 0 })
r = await call('POST', '/api/projects/web-app/import', { language: 'fr', entries: { 'home.title': 'Bonjour' } })
assert.deepEqual(r.data, { newKeys: 0, created: 1, updated: 0, unchanged: 0 })
r = await call('POST', '/api/projects/web-app/import', { language: 'en', entries: { 'home.title': 'Hey', 'home.cta': 'Start' } })
assert.deepEqual(r.data, { newKeys: 0, created: 0, updated: 0, unchanged: 2 })
r = await call('POST', '/api/projects/web-app/import', { language: 'en', entries: { 'home.cta': 'Go', footer: 'Bye' }, overwrite: true })
assert.deepEqual(r.data, { newKeys: 0, created: 0, updated: 1, unchanged: 1 })
r = await call('POST', '/api/projects/web-app/import', { language: 'de', entries: { a: 'b' } })
assert.equal(r.status, 400)
ok('import: new keys, fill-only mode, overwrite mode, unknown language rejected')

r = await call('PUT', '/api/projects/web-app/translations', { key: 'home.cta', language: 'fr', value: 'Commencer' })
assert.equal(r.status, 200)
r = await call('PUT', '/api/projects/web-app/translations', { key: 'nope', language: 'fr', value: 'x' })
assert.equal(r.status, 404)
r = await call('POST', '/api/projects/web-app/keys', { key: 'nav.about', description: 'Top nav', values: { en: 'About', fr: '' } })
assert.equal(r.status, 200)
r = await call('POST', '/api/projects/web-app/keys', { key: 'nav.about' })
assert.equal(r.status, 409)
ok('edit: cell upsert, unknown key → 404, add key with values, duplicate key → 409')

r = await call('GET', '/api/projects/web-app')
assert.equal(r.data.keys.length, 4)
assert.deepEqual(r.data.keys.find((k) => k.key === 'home.cta').values, { en: 'Go', fr: 'Commencer' })
assert.deepEqual(r.data.keys.find((k) => k.key === 'nav.about').values, { en: 'About' })
assert.equal(r.data.live, null)
assert.equal(r.data.project.hasUnpublished, true)
ok('project detail: keys aggregated per language, nothing live yet')

r = await call('GET', '/api/pull/web-app', undefined, { authorization: 'Bearer test-pull-token', cookie: '' })
assert.equal(r.status, 404)
r = await call('GET', '/api/pull/web-app?version=draft&format=nested&fallback=1', undefined, { authorization: 'Bearer test-pull-token', cookie: '' })
assert.deepEqual(r.data.languages.fr, { footer: 'Bye', home: { cta: 'Commencer', title: 'Bonjour' }, nav: { about: 'About' } })
r = await call('GET', '/api/pull/web-app?version=draft', undefined, { authorization: 'Bearer wrong', cookie: '' })
assert.equal(r.status, 401)
ok('pull: 404 before publish, draft nested with base fallback, bad token → 401')

r = await call('POST', '/api/projects/web-app/releases', { note: 'First release' })
assert.equal(r.data.release.version, 1)
r = await call('GET', '/api/projects')
assert.equal(r.data.projects[0].hasUnpublished, false)
assert.equal(r.data.projects[0].currentVersion, 1)
await new Promise((res) => setTimeout(res, 5))
await call('PUT', '/api/projects/web-app/translations', { key: 'home.title', language: 'en', value: 'Hi there' })
r = await call('GET', '/api/projects')
assert.equal(r.data.projects[0].hasUnpublished, true)
r = await call('POST', '/api/projects/web-app/releases', { note: 'Copy tweak' })
assert.equal(r.data.release.version, 2)
ok('releases: publish v1, edit flags unpublished changes, publish v2')

r = await call('GET', '/api/pull/web-app?lang=en', undefined, { authorization: 'Bearer test-pull-token', cookie: '' })
assert.deepEqual(r.data, { footer: 'Bye', 'home.cta': 'Go', 'home.title': 'Hi there', 'nav.about': 'About' })
assert.deepEqual(Object.keys(r.data), ['footer', 'home.cta', 'home.title', 'nav.about'])
r = await call('POST', '/api/projects/web-app/releases/1/activate', {})
assert.equal(r.data.currentVersion, 1)
r = await call('GET', '/api/pull/web-app?lang=en', undefined, { authorization: 'Bearer test-pull-token', cookie: '' })
assert.equal(r.data['home.title'], 'Hello')
r = await call('GET', '/api/pull/web-app?version=latest&lang=en', undefined, { authorization: 'Bearer test-pull-token', cookie: '' })
assert.equal(r.data['home.title'], 'Hi there')
r = await call('GET', '/api/projects')
assert.equal(r.data.projects[0].hasUnpublished, true, 'rolled back → live differs from latest')
ok('rollback: make v1 live, pull follows it, latest still reachable, sorted keys')

await call('POST', '/api/projects/web-app/keys', { key: 'home', values: { en: 'Home' } })
r = await call('GET', '/api/pull/web-app?version=draft&format=nested', undefined, { authorization: 'Bearer test-pull-token', cookie: '' })
assert.equal(r.status, 422)
r = await call('PATCH', '/api/projects/web-app/keys', { key: 'home', newKey: 'nav.home', description: 'Link' })
assert.deepEqual(r.data.key, { key: 'nav.home', description: 'Link' })
r = await call('GET', '/api/pull/web-app?version=draft&format=nested', undefined, { authorization: 'Bearer test-pull-token', cookie: '' })
assert.equal(r.status, 200)
ok('keys: nested collision → 422 with message, rename fixes it')

// Plurals are stored as i18next writes them (one key per form); the API keeps the forms together.
await call('POST', '/api/projects', { name: 'Plurals', slug: 'plurals', languages: ['en', 'ru', 'ja'], baseLanguage: 'en' })
r = await call('POST', '/api/projects/plurals/keys', {
  key: 'inbox.count',
  plural: true,
  description: 'Unread',
  values: { en: { one: '{{count}} message', other: '{{count}} messages' }, ja: { other: '{{count}}件' } },
})
assert.deepEqual(r.data.key.forms, ['one', 'few', 'many', 'other'], 'every form a project language needs (Russian few, many)')
const pluralKeys = async () => (await call('GET', '/api/projects/plurals')).data.keys
let keys = await pluralKeys()
assert.deepEqual(keys.map((k) => k.key), ['inbox.count_few', 'inbox.count_many', 'inbox.count_one', 'inbox.count_other'])
assert.ok(keys.every((k) => k.description === 'Unread'))
assert.deepEqual(keys.find((k) => k.key === 'inbox.count_other').values, { en: '{{count}} messages', ja: '{{count}}件' })
r = await call('POST', '/api/projects/plurals/keys', { key: 'inbox.count', plural: true })
assert.equal(r.status, 409)
r = await call('GET', '/api/pull/plurals?version=draft&lang=ja', undefined, { authorization: 'Bearer test-pull-token', cookie: '' })
assert.deepEqual(r.data, { 'inbox.count_other': '{{count}}件' }, 'builds still get i18next suffixed keys')
r = await call('POST', '/api/projects/plurals/keys', { key: 'inbox.empty', plural: true, zero: true, values: { en: { zero: 'No messages' } } })
assert.deepEqual(r.data.key.forms, ['zero', 'one', 'few', 'many', 'other'], 'zero on request, though none of en, ru, ja has a zero form')
assert.deepEqual((await pluralKeys()).find((k) => k.key === 'inbox.empty_zero').values, { en: 'No messages' })
await call('DELETE', '/api/projects/plurals/keys', { keys: ['inbox.empty_zero', 'inbox.empty_one', 'inbox.empty_few', 'inbox.empty_many', 'inbox.empty_other'] })

r = await call('PATCH', '/api/projects/plurals/keys', { key: 'inbox.count', newKey: 'inbox.unread', description: 'Unread messages', plural: true })
assert.equal(r.status, 200)
keys = await pluralKeys()
assert.deepEqual(keys.map((k) => k.key), ['inbox.unread_few', 'inbox.unread_many', 'inbox.unread_one', 'inbox.unread_other'])
assert.ok(keys.every((k) => k.description === 'Unread messages'))

r = await call('POST', '/api/projects/plurals/keys/plural', { key: 'inbox.unread', plural: false })
assert.equal(r.status, 200)
keys = await pluralKeys()
assert.deepEqual(keys.map((k) => [k.key, k.values]), [['inbox.unread', { en: '{{count}} messages', ja: '{{count}}件' }]], 'the other form becomes the key')

r = await call('POST', '/api/projects/plurals/keys/plural', { key: 'inbox.unread', plural: true })
assert.deepEqual(r.data.forms, ['one', 'few', 'many', 'other'])
keys = await pluralKeys()
assert.deepEqual(keys.find((k) => k.key === 'inbox.unread_other').values, { en: '{{count}} messages', ja: '{{count}}件' })
assert.equal(keys.length, 4)

await call('PATCH', '/api/projects/plurals', { languages: ['en', 'ru', 'ja', 'ar'] })
r = await call('PUT', '/api/projects/plurals/translations', { key: 'inbox.unread_two', language: 'ar', value: 'رسالتان' })
assert.equal(r.status, 404, 'no key without create')
r = await call('PUT', '/api/projects/plurals/translations', { key: 'inbox.unread_two', language: 'ar', value: 'رسالتان', create: true })
assert.equal(r.status, 200)
r = await call('PUT', '/api/projects/plurals/translations', { key: 'home.title', language: 'ar', value: 'x', create: true })
assert.equal(r.status, 400, 'create is only for plural forms')
keys = await pluralKeys()
assert.deepEqual(keys.find((k) => k.key === 'inbox.unread_two'), { key: 'inbox.unread_two', description: 'Unread messages', values: { ar: 'رسالتان' } })
await call('DELETE', '/api/projects/plurals')
ok('plurals: one key per form, group rename, make singular and plural again, new forms created on first save')

// Every change is recorded with what it replaced; releases add the values they published.
await call('POST', '/api/projects', { name: 'History', slug: 'hist', languages: ['en', 'fr'], baseLanguage: 'en' })
await call('POST', '/api/projects/hist/keys', { key: 'cta', description: 'Button', values: { en: 'Start' } })
await call('POST', '/api/projects/hist/releases', { note: 'v1' })
await call('PUT', '/api/projects/hist/translations', { key: 'cta', language: 'en', value: 'Begin' })
await call('PUT', '/api/projects/hist/translations', { key: 'cta', language: 'en', value: 'Begin' })
await call('POST', '/api/projects/hist/import', { language: 'fr', entries: { cta: 'Commencer' } })
await call('PUT', '/api/projects/hist/translations', { key: 'cta', language: 'fr', value: '' })
r = await call('POST', '/api/projects/hist/keys/history', { keys: ['cta'] })
assert.deepEqual(
  r.data.edits.map((e) => [e.language, e.source, e.previous, e.value]),
  [
    ['fr', 'edit', 'Commencer', null],
    ['fr', 'import', null, 'Commencer'],
    ['en', 'edit', 'Start', 'Begin'],
    ['en', 'add', null, 'Start'],
  ],
  'saving the same text twice records one change',
)
assert.deepEqual(r.data.releases.map((x) => [x.version, x.language, x.key, x.value]), [[1, 'en', 'cta', 'Start']])

r = await call('POST', '/api/projects/hist/keys/duplicate', { key: 'cta' })
assert.equal(r.data.key, 'cta_copy')
r = await call('POST', '/api/projects/hist/keys/duplicate', { key: 'cta' })
assert.equal(r.data.key, 'cta_copy2', 'the next free name')
await call('POST', '/api/projects/hist/keys', { key: 'items', plural: true, values: { en: { one: '1 item', other: '{{count}} items' } } })
r = await call('POST', '/api/projects/hist/keys/duplicate', { key: 'items', plural: true })
assert.equal(r.data.key, 'items_copy')
keys = (await call('GET', '/api/projects/hist')).data.keys
assert.deepEqual(keys.find((k) => k.key === 'cta_copy'), { key: 'cta_copy', description: 'Button', values: { en: 'Begin' } })
assert.deepEqual(
  keys.filter((k) => k.key.startsWith('items_copy')).map((k) => [k.key, k.values.en ?? null]),
  [['items_copy_one', '1 item'], ['items_copy_other', '{{count}} items']],
)
await call('DELETE', '/api/projects/hist')
ok('history & duplicate: changes recorded with what they replaced, release values, key_copy / key_copy2, plural copies')

r = await call('POST', '/api/projects/web-app/targets', { name: 'Prod', type: 'vercel_hook', config: { url: 'https://example.com/hook' } })
assert.equal(r.status, 400)
r = await call('POST', '/api/projects/web-app/targets', { name: 'Prod', type: 'vercel_hook', config: { url: 'https://api.vercel.com/v1/integrations/deploy/prj_x/abc' } })
assert.equal(r.status, 200)
const targetId = r.data.target.id
r = await call('POST', '/api/projects/web-app/targets', { name: 'Mobile', type: 'github_workflow', config: { owner: 'acme', repo: 'app', workflow: 'i18n-sync.yml' }, autoOnPublish: false })
assert.equal(r.data.target.config.ref, 'main')
r = await call('POST', '/api/projects/web-app/releases', { note: 'With deploy', targetIds: [targetId, r.data.target.id] })
assert.equal(r.data.release.version, 3)
assert.equal(r.data.deploys.length, 2)
const gh = r.data.deploys.find((d) => d.name === 'Mobile')
assert.equal(gh.ok, false)
assert.match(gh.message, /GITHUB_TOKEN is not set/)
r = await call('GET', '/api/projects/web-app/deploys')
assert.equal(r.data.deploys.length, 2)
r = await call('PATCH', `/api/projects/web-app/targets/${targetId}`, { autoOnPublish: false })
assert.equal(r.data.target.autoOnPublish, false)
ok('deploys: hook URL validated, publish triggers targets, failures logged with reason')

r = await call('PATCH', '/api/projects/web-app', { languages: ['en', 'es'], baseLanguage: 'en' })
assert.deepEqual(r.data.project.languages, ['en', 'es'])
r = await call('GET', '/api/projects/web-app')
assert.ok(r.data.keys.every((k) => !('fr' in k.values)))
r = await call('DELETE', '/api/projects/web-app/keys', { keys: ['footer', 'nav.home'] })
assert.equal(r.data.deleted, 2)
r = await call('GET', '/api/projects/web-app/releases')
assert.deepEqual(r.data.releases.map((x) => [x.version, x.isLive]), [[3, true], [2, false], [1, false]])
r = await call('GET', '/api/projects/web-app/releases/1')
assert.equal(r.data.snapshot.fr['home.title'], 'Bonjour', 'old releases keep removed languages')
ok('settings: languages swapped (fr values removed), bulk delete, release history intact')

r = await call('DELETE', '/api/projects/web-app')
assert.equal(r.status, 200)
r = await call('GET', '/api/projects')
assert.equal(r.data.projects.length, 0)
r = await call('POST', '/api/auth/logout')
r = await call('GET', '/api/projects')
assert.equal(r.status, 401)
ok('cleanup: project deleted with cascade, logout ends session')

console.log(`\nAll ${step} API checks passed.`)
server.close()
await vite.close()
await pg.close()
