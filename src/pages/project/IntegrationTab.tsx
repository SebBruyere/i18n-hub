import { CodeBlock } from '../../components/ui'
import type { Project } from '../../lib/types'

const OPTIONS: [string, string][] = [
  ['--out <dir>', 'Folder to write into. Default: src/locales'],
  ['--pattern <path>', 'File name inside it. Default: {lang}.json. Use {lang}/translation.json for i18next folders.'],
  ['--format nested', 'Write nested objects instead of flat dotted keys.'],
  ['--version <v>', 'current (default), latest, draft, or a number such as 12.'],
  ['--fallback', 'Fill missing translations with the base language.'],
  ['--soft', 'Warn instead of failing the build when i18n Hub is unreachable.'],
]

export function IntegrationTab({ project }: { project: Project }) {
  const origin = location.origin
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-5 py-8">
      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold">Pull at build time</h2>
          <p className="mt-1 text-sm text-ink-soft">
            The app fetches the live release every time it builds, so a deploy always ships the strings you published.
            Developers run the same command locally.
          </p>
        </div>
        <ol className="flex list-decimal flex-col gap-5 pl-5 text-sm marker:font-semibold marker:text-muted">
          <li className="flex flex-col gap-2 pl-1">
            <span>Add the pull script to the app. It has no dependencies and needs Node 20 or newer.</span>
            <CodeBlock label="Terminal" code={`mkdir -p scripts && curl -o scripts/i18n-pull.mjs ${origin}/i18n-pull.mjs`} />
          </li>
          <li className="flex flex-col gap-2 pl-1">
            <span>
              Set these variables in the app’s Vercel project, and in its <code className="font-mono">.env.local</code>{' '}
              for local work. The token is the <code className="font-mono">PULL_TOKEN</code> of this i18n Hub deployment.
            </span>
            <CodeBlock label=".env.local" code={`I18N_API_URL=${origin}\nI18N_PROJECT=${project.slug}\nI18N_TOKEN=`} />
          </li>
          <li className="flex flex-col gap-2 pl-1">
            <span>Run it before every build.</span>
            <CodeBlock
              label="package.json"
              code={`"scripts": {\n  "i18n:pull": "node scripts/i18n-pull.mjs --out src/locales",\n  "prebuild": "npm run i18n:pull"\n}`}
            />
          </li>
          <li className="pl-1">
            Once builds pull reliably, add the locale folder to <code className="font-mono">.gitignore</code> so strings stop
            showing up in code reviews. Keep them committed with <code className="font-mono">--soft</code> if you want a
            fallback when i18n Hub is down.
          </li>
        </ol>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Pull script options</h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border border-line bg-surface px-5 py-4 text-sm sm:grid-cols-[11rem_1fr]">
          {OPTIONS.map(([flag, text]) => (
            <div key={flag} className="contents">
              <dt className="font-mono text-[13px] text-ink">{flag}</dt>
              <dd className="text-ink-soft">{text}</dd>
            </div>
          ))}
        </dl>
        <p className="text-sm text-muted">
          Every flag also reads from an environment variable: I18N_OUT_DIR, I18N_PATTERN, I18N_FORMAT, I18N_VERSION,
          I18N_FALLBACK and I18N_SOFT_FAIL.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Apps that commit their locale files</h2>
        <p className="text-sm text-ink-soft">
          For mobile apps or anything built outside Vercel, add this workflow to the repo, set the{' '}
          <code className="font-mono">I18N_API_URL</code> variable and <code className="font-mono">I18N_TOKEN</code> secret
          in GitHub, then add a GitHub Actions target on the Deploys tab. Each publish opens a pull request with the new
          files.
        </p>
        <CodeBlock
          label="Terminal"
          code={`mkdir -p .github/workflows && curl -o .github/workflows/i18n-sync.yml ${origin}/i18n-sync.yml`}
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Raw endpoint</h2>
        <CodeBlock
          label="Terminal"
          code={`curl -H "Authorization: Bearer $I18N_TOKEN" \\\n  "${origin}/api/pull/${project.slug}?lang=${project.baseLanguage}&format=nested"`}
        />
      </section>
    </div>
  )
}
