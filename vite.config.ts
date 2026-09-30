import { mkdirSync } from 'node:fs'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

/**
 * `npm run dev:local` (vite --mode embedded): embedded Postgres (PGlite) stored in
 * .data/, so you can try the app without Neon or Vercel.
 */
async function useEmbeddedPostgres() {
  const { PGlite } = await import('@electric-sql/pglite')
  mkdirSync('.data', { recursive: true })
  const pg = new PGlite('./.data/pglite')
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0]
    values.forEach((_, i) => (text += `$${i + 1}${strings[i + 1]}`))
    return pg.query(text, values).then((r) => r.rows)
  }
  sql.query = (text: string, params: unknown[] = []) => pg.query(text, params).then((r) => r.rows)
  ;(globalThis as { __i18nHubSql?: unknown }).__i18nHubSql = sql
  process.env.APP_PASSWORD ||= 'local'
  process.env.PULL_TOKEN ||= 'local'
  console.log('\n  i18n Hub is using the embedded database in .data/pglite')
  console.log(`  Sign in with APP_PASSWORD (${process.env.APP_PASSWORD === 'local' ? '"local"' : 'from your .env'}), pull with PULL_TOKEN.\n`)
}

/**
 * Serves /api/* from api/index.ts during `npm run dev`, so local work needs
 * no `vercel dev`. On Vercel the same file runs as a Node function.
 */
function localApi(): Plugin {
  return {
    name: 'i18n-hub-local-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        // /api/_lib/* are source modules the web app imports (format.ts), not endpoints.
        if (!req.url?.startsWith('/api/') || req.url.startsWith('/api/_lib/')) return next()
        try {
          const mod = await server.ssrLoadModule('/api/index.ts')
          await mod.default(req, res)
        } catch (err) {
          server.ssrFixStacktrace(err as Error)
          next(err)
        }
      })
    },
  }
}

export default defineConfig(async ({ mode, command }) => {
  // Make .env / .env.local (from `vercel env pull .env.local`) visible to the API code.
  for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), ''))) {
    process.env[key] ??= value
  }
  if (command === 'serve' && mode === 'embedded') await useEmbeddedPostgres()
  return { plugins: [react(), tailwindcss(), localApi()] }
})
