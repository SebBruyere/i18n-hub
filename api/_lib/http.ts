import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  params: Record<string, string>
  query: URLSearchParams
  body: Record<string, unknown>
}

const MAX_BODY = 4 * 1024 * 1024

/**
 * Works both on Vercel (which pre-parses `req.body`) and in the local Vite
 * dev middleware (plain Node request stream).
 */
export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw: unknown
  try {
    raw = (req as IncomingMessage & { body?: unknown }).body
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON')
  }
  if (raw === undefined) {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY) throw new HttpError(413, 'Request body is larger than 4 MB')
      chunks.push(chunk as Buffer)
    }
    raw = Buffer.concat(chunks).toString('utf8')
  }
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8')
  if (typeof raw === 'string') {
    if (!raw.trim()) return {}
    try {
      raw = JSON.parse(raw)
    } catch {
      throw new HttpError(400, 'Request body is not valid JSON')
    }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'Request body must be a JSON object')
  }
  return raw as Record<string, unknown>
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const name = part.slice(0, i).trim()
    const value = part.slice(i + 1).trim()
    try {
      out[name] = decodeURIComponent(value)
    } catch {
      out[name] = value
    }
  }
  return out
}

export function send(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(data))
}

/* ---------- tiny validators ---------- */

export function reqString(body: Record<string, unknown>, field: string, max = 500): string {
  const v = body[field]
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `"${field}" is required`)
  if (v.length > max) throw new HttpError(400, `"${field}" is longer than ${max} characters`)
  return v
}

export function optString(body: Record<string, unknown>, field: string, max = 2000): string | undefined {
  const v = body[field]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new HttpError(400, `"${field}" must be a string`)
  if (v.length > max) throw new HttpError(400, `"${field}" is longer than ${max} characters`)
  return v
}

export function optIds(body: Record<string, unknown>, field: string): number[] {
  const v = body[field]
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || !v.every((x) => Number.isInteger(x))) {
    throw new HttpError(400, `"${field}" must be a list of ids`)
  }
  return v as number[]
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
export const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

export function validateKey(key: string): string {
  if (key !== key.trim()) throw new HttpError(400, 'Keys cannot start or end with spaces')
  if (key.length > 255) throw new HttpError(400, 'Keys are limited to 255 characters')
  return key
}
