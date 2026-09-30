#!/usr/bin/env node
/**
 * i18n-pull: writes one JSON file per language from i18n Hub.
 * Zero dependencies, Node 20+.
 *
 *   node scripts/i18n-pull.mjs [--project slug] [--out src/locales] [--pattern "{lang}.json"]
 *                             [--format flat|nested] [--version current|latest|draft|<n>]
 *                             [--fallback] [--soft]
 *
 * Environment (flags win): I18N_API_URL, I18N_TOKEN, I18N_PROJECT, I18N_OUT_DIR, I18N_PATTERN,
 * I18N_FORMAT, I18N_VERSION, I18N_FALLBACK, I18N_SOFT_FAIL. Missing variables are read from
 * .env.local and .env in the current directory, so local pulls work without extra setup.
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { parseArgs } from 'node:util'

for (const file of ['.env.local', '.env']) {
  if (!existsSync(file)) continue
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || m[1] in process.env) continue
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
}

const { values: flags } = parseArgs({
  options: {
    project: { type: 'string' },
    out: { type: 'string' },
    pattern: { type: 'string' },
    format: { type: 'string' },
    version: { type: 'string' },
    fallback: { type: 'boolean' },
    soft: { type: 'boolean' },
  },
})

const env = process.env
const truthy = (v) => ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase())
const config = {
  api: (env.I18N_API_URL ?? '').replace(/\/+$/, ''),
  token: env.I18N_TOKEN ?? '',
  project: flags.project ?? env.I18N_PROJECT ?? '',
  out: flags.out ?? env.I18N_OUT_DIR ?? 'src/locales',
  pattern: flags.pattern ?? env.I18N_PATTERN ?? '{lang}.json',
  format: flags.format ?? env.I18N_FORMAT ?? 'flat',
  version: flags.version || env.I18N_VERSION || 'current',
  fallback: flags.fallback ?? truthy(env.I18N_FALLBACK),
  soft: flags.soft ?? truthy(env.I18N_SOFT_FAIL),
}

function fail(message) {
  if (config.soft) {
    console.warn(`i18n: ${message}\ni18n: --soft is set, keeping the existing locale files.`)
    process.exit(0)
  }
  console.error(`i18n: ${message}`)
  process.exit(1)
}

if (!config.api) fail('I18N_API_URL is not set (for example https://i18n-hub.vercel.app)')
if (!config.token) fail('I18N_TOKEN is not set (the PULL_TOKEN of your i18n Hub deployment)')
if (!config.project) fail('Set I18N_PROJECT or pass --project <slug>')
if (!config.pattern.includes('{lang}')) fail('--pattern must contain {lang}')

const params = new URLSearchParams({ version: config.version, format: config.format })
if (config.fallback) params.set('fallback', '1')
const url = `${config.api}/api/pull/${encodeURIComponent(config.project)}?${params}`

let data
try {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) fail(`${res.status} from ${config.api}: ${body?.error ?? res.statusText}`)
  data = body
} catch (err) {
  fail(`could not reach ${config.api} (${err.name === 'TimeoutError' ? 'timed out' : err.message})`)
}

const written = []
for (const [lang, strings] of Object.entries(data.languages)) {
  const file = join(config.out, config.pattern.replaceAll('{lang}', lang))
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(strings, null, 2)}\n`)
  written.push(lang)
}

const where = relative(process.cwd(), config.out) || '.'
const label = data.version === 'draft' ? `the unpublished draft of ${data.project}` : `${data.project} v${data.version}`
console.log(`i18n: pulled ${label} (${written.join(', ')}) into ${where}`)
