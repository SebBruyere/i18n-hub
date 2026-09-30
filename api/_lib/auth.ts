import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { HttpError } from './http.js'

const COOKIE = 'i18n_hub_session'
const MAX_AGE = 60 * 60 * 24 * 30 // 30 days

function sha256(value: string) {
  return createHash('sha256').update(value).digest()
}

function safeEqual(a: string, b: string) {
  return timingSafeEqual(sha256(a), sha256(b))
}

function password(): string {
  const pw = process.env.APP_PASSWORD
  if (!pw) throw new HttpError(500, 'APP_PASSWORD is not set on the server')
  return pw
}

function secret(): string {
  // Deriving from the password means rotating APP_PASSWORD signs everyone out.
  return process.env.SESSION_SECRET || sha256(`i18n-hub-session:${password()}`).toString('hex')
}

function sign(value: string) {
  return createHmac('sha256', secret()).update(value).digest('base64url')
}

function isLocal(req: IncomingMessage) {
  const host = req.headers.host ?? ''
  return host.startsWith('localhost') || host.startsWith('127.0.0.1')
}

export function checkPassword(candidate: unknown): boolean {
  return typeof candidate === 'string' && safeEqual(candidate, password())
}

export function sessionCookie(req: IncomingMessage): string {
  const expires = String(Date.now() + MAX_AGE * 1000)
  const value = `${expires}.${sign(expires)}`
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${isLocal(req) ? '' : '; Secure'}`
}

export function clearedCookie(req: IncomingMessage): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isLocal(req) ? '' : '; Secure'}`
}

export function hasSession(cookies: Record<string, string>): boolean {
  const raw = cookies[COOKIE]
  if (!raw) return false
  const [expires, signature] = raw.split('.')
  if (!expires || !signature || Number(expires) < Date.now()) return false
  return safeEqual(signature, sign(expires))
}

export function hasPullToken(req: IncomingMessage): boolean {
  const token = process.env.PULL_TOKEN
  const header = req.headers.authorization
  if (!token || !header?.startsWith('Bearer ')) return false
  return safeEqual(header.slice(7).trim(), token)
}
