import { neon } from '@neondatabase/serverless'
import { HttpError } from './http.js'
import { SCHEMA } from './schema.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>

export interface Sql {
  <T = Row>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>
}

let client: Sql | null = null
let ready: Promise<void> | null = null

function connect(): Sql {
  // `npm run dev:local` puts an embedded Postgres here (see vite.config.ts).
  const local = (globalThis as { __i18nHubSql?: Sql }).__i18nHubSql
  if (local) return local
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL
  if (!url) {
    throw new HttpError(500, 'DATABASE_URL is not set. Connect a Neon database to the Vercel project, then run `vercel env pull .env.local` for local dev.')
  }
  const n = neon(url)
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    n(strings, ...values) as Promise<Row[]>) as Sql
  sql.query = (text, params = []) => n.query(text, params) as unknown as Promise<never>
  return sql
}

async function migrate(sql: Sql) {
  for (const statement of SCHEMA) {
    try {
      await sql.query(statement)
    } catch (err) {
      // Two cold starts racing on CREATE ... IF NOT EXISTS can collide; the other one won.
      const code = (err as { code?: string }).code
      if (code !== '23505' && code !== '42P07') throw err
    }
  }
}

export async function getSql(): Promise<Sql> {
  client ??= connect()
  const sql = client
  ready ??= migrate(sql).catch((err) => {
    ready = null
    throw err
  })
  await ready
  return sql
}

/** Used by the local test harness to swap in an in-memory Postgres. */
export function setSql(sql: Sql) {
  client = sql
  ready = null
}
