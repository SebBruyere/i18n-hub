import { HttpError } from './http.js'

export type TargetType = 'vercel_hook' | 'github_workflow' | 'webhook'

export interface TargetConfig {
  url?: string
  secret?: string
  owner?: string
  repo?: string
  workflow?: string
  ref?: string
  tokenEnv?: string
}

export interface TriggerResult {
  ok: boolean
  status: number | null
  message: string
}

const TYPES: TargetType[] = ['vercel_hook', 'github_workflow', 'webhook']
const TOKEN_ENV_RE = /^GITHUB_[A-Z0-9_]*$/

function httpsUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${label} is required`)
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new HttpError(400, `${label} is not a valid URL`)
  }
  if (url.protocol !== 'https:') throw new HttpError(400, `${label} must start with https://`)
  return url.toString()
}

function field(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${label} is required`)
  return value.trim()
}

export function validateTarget(type: unknown, raw: unknown): { type: TargetType; config: TargetConfig } {
  if (!TYPES.includes(type as TargetType)) throw new HttpError(400, 'Unknown deploy type')
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  switch (type as TargetType) {
    case 'vercel_hook': {
      const url = httpsUrl(c.url, 'Deploy hook URL')
      if (new URL(url).hostname !== 'api.vercel.com') {
        throw new HttpError(400, 'Vercel deploy hooks live on api.vercel.com. Copy the URL from Project settings > Git > Deploy Hooks.')
      }
      return { type: 'vercel_hook', config: { url } }
    }
    case 'github_workflow': {
      const tokenEnv = typeof c.tokenEnv === 'string' && c.tokenEnv.trim() ? c.tokenEnv.trim() : 'GITHUB_TOKEN'
      if (!TOKEN_ENV_RE.test(tokenEnv)) throw new HttpError(400, 'Token variable must start with GITHUB_, for example GITHUB_TOKEN')
      return {
        type: 'github_workflow',
        config: {
          owner: field(c.owner, 'Owner'),
          repo: field(c.repo, 'Repository'),
          workflow: field(c.workflow, 'Workflow file'),
          ref: typeof c.ref === 'string' && c.ref.trim() ? c.ref.trim() : 'main',
          tokenEnv,
        },
      }
    }
    case 'webhook': {
      const secret = typeof c.secret === 'string' && c.secret ? c.secret : undefined
      return { type: 'webhook', config: { url: httpsUrl(c.url, 'Webhook URL'), secret } }
    }
  }
}

async function readText(res: Response) {
  try {
    return (await res.text()).slice(0, 300)
  } catch {
    return ''
  }
}

export async function triggerTarget(
  target: { type: TargetType; config: TargetConfig },
  info: { project: string; version: number | null },
): Promise<TriggerResult> {
  const signal = AbortSignal.timeout(10_000)
  const { config } = target
  try {
    if (target.type === 'vercel_hook') {
      const res = await fetch(config.url!, { method: 'POST', signal })
      if (!res.ok) return { ok: false, status: res.status, message: await readText(res) }
      const data = (await res.json().catch(() => ({}))) as { job?: { id?: string; state?: string } }
      return { ok: true, status: res.status, message: data.job?.id ? `Build queued (job ${data.job.id})` : 'Build queued' }
    }

    if (target.type === 'github_workflow') {
      const token = process.env[config.tokenEnv ?? 'GITHUB_TOKEN']
      if (!token) return { ok: false, status: null, message: `${config.tokenEnv} is not set on the i18n Hub deployment` }
      const url = `https://api.github.com/repos/${encodeURIComponent(config.owner!)}/${encodeURIComponent(config.repo!)}/actions/workflows/${encodeURIComponent(config.workflow!)}/dispatches`
      const res = await fetch(url, {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'i18n-hub',
        },
        body: JSON.stringify({ ref: config.ref, inputs: { version: info.version === null ? '' : String(info.version) } }),
      })
      if (!res.ok) return { ok: false, status: res.status, message: await readText(res) }
      return { ok: true, status: res.status, message: `Started ${config.workflow} on ${config.ref}` }
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'i18n-hub' }
    if (config.secret) headers['X-I18n-Secret'] = config.secret
    const res = await fetch(config.url!, {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify({ event: 'i18n.release', project: info.project, version: info.version }),
    })
    if (!res.ok) return { ok: false, status: res.status, message: await readText(res) }
    return { ok: true, status: res.status, message: 'Webhook delivered' }
  } catch (err) {
    const name = (err as Error).name
    return { ok: false, status: null, message: name === 'TimeoutError' ? 'No response after 10 seconds' : (err as Error).message }
  }
}
