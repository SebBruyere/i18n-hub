# i18n Hub

A small, self-hosted replacement for the part of Lokalise we actually use: key/value strings per language, per project, with apps pulling them at build time instead of committing them by hand.

React + Tailwind + Vite for the editor, one Vercel Node function for the API, Neon Postgres (Vercel Marketplace) for storage.

## How it works

```
 edit in the UI ──► draft (Postgres) ──► Publish ──► release vN (frozen JSON) ──► "live" pointer
                                                                     │
                     app build:  node scripts/i18n-pull.mjs  ◄───────┘  GET /api/pull/:project
                                                                     │
                     deploy targets (optional, per project) ◄────────┘  Vercel hook / GitHub workflow / webhook
```

- **Draft vs release.** Edits are saved to the draft immediately but never reach an app until you publish. Publishing snapshots every string into an immutable release (v1, v2…) and makes it live. An unrelated deploy of an app can never ship half-finished copy.
- **Rollback.** "Make live" on any older release points builds back at it without touching the draft.
- **Pull at build.** Each app runs a zero-dependency script in `prebuild` that writes `src/locales/{lang}.json` from the live release. Developers run the same script locally, optionally with `--version draft` to see unpublished strings.
- **Deploy from the app.** Each project has its own deploy targets, so each app ships its own way:
  - *Vercel deploy hook*: rebuilds a Vercel app, whose build pulls the new release.
  - *GitHub Actions workflow*: runs a `workflow_dispatch` workflow with a `version` input. The included `i18n-sync.yml` pulls, commits and opens a PR, for apps that must keep locale files in Git (mobile, non-Vercel).
  - *Webhook*: POSTs `{ "event": "i18n.release", "project", "version" }` anywhere, including GitLab pipeline trigger URLs.

Why Postgres rather than JSON files or Edge Config: concurrent edits from several people need row-level writes, releases need history, and Edge Config's size limits are too small for real translation sets. Neon's HTTP driver fits serverless functions (no connection pool to manage).

## Try it locally without any setup

```bash
npm install
npm run dev:local   # embedded Postgres in .data/, password "local", pull token "local"
```

The UI is built with Bodyguard's design system (`@bodyguard-ai/design-system`, on GitHub's npm registry) and Font Awesome Pro, so `npm install` needs the same two tokens as the dashboard in your shell: `NPM_TOKEN` and `FONTAWESOME_NPM_AUTH_TOKEN` (`.npmrc` reads them).

## Deploy

1. Push this folder to a Git repo and import it in Vercel (framework preset: Vite, detected automatically).
2. In the Vercel project, go to **Storage** and connect a **Neon** database. That sets `DATABASE_URL`. Tables are created automatically on the first request.
3. Add environment variables:
   - `NPM_TOKEN` and `FONTAWESOME_NPM_AUTH_TOKEN`: the build installs the design system and Font Awesome Pro from private registries, like the dashboard's.
   - `APP_PASSWORD`: the team password for the editor.
   - `PULL_TOKEN`: what app builds use to pull. Generate one with `openssl rand -hex 32`.
   - `GITHUB_TOKEN` (optional): a fine-grained token with **Actions: Read and write** on repos you want to trigger workflows in. For another org, add e.g. `GITHUB_TOKEN_MOBILE` and set it as the target's token variable.
   - `SESSION_SECRET` (optional): otherwise sessions are signed with a key derived from `APP_PASSWORD`, so changing the password signs everyone out.
4. Redeploy so the variables apply.

Local development against the real database:

```bash
vercel link
vercel env pull .env.local
npm run dev          # Vite serves the UI and /api from the same process
```

If Neon **Preview Branching** is enabled, preview deployments of i18n Hub get their own database branch. Apps should always pull from the production URL.

## Moving over from Lokalise

1. Create a project per app with the same language codes.
2. Export JSON from Lokalise (one file per language, nested or flat), or just take the files already committed in each repo.
3. On the Strings tab, choose **Import** and drop all files at once. The language is guessed from the file name (`en.json`, `fr-FR.json`, `translation.fr.json`) and a Lokalise `{ "fr": { … } }` wrapper is unwrapped.
4. Publish v1, wire up the app (below), then remove the Lokalise pull from that repo.

## Key actions and history

Under each key: **Edit**, **Copy** (the key name, as your code uses it), **Duplicate** (to `key_copy`, every form of a plural key included), **History** and **Delete** (two clicks).

Every change to a translation is recorded with the text it replaced: edits, imports, new keys and duplicates. **History** shows each language's earlier texts, newest first, with the releases they were live in, plus the values older releases published from before recording started. **Restore** puts an earlier text back, as a new change. Changes are recorded from the moment this version is deployed; there's no author, since everyone shares the team password.

## Plural keys

Plurals are stored the way i18next reads them: one key per form (`items_one`, `items_other`, `items_few`…, ordinals as `place_ordinal_two`), so imports and the files builds pull are plain i18next JSON. The Strings tab groups the forms into one plural key and asks each language only for the forms its plural rules use for everyday numbers: English one and other, Japanese only other, Russian one, few, many and other. Each form shows the counts that pick it (Russian one: 1, 21, 31…).

- A key with `_other` and at least one more form is plural. A lone `gender_other` stays an ordinary key.
- **Add key → Plural** creates every form the project's languages need. **Edit key → Make plural** turns the current text into the `other` form; **Make singular** keeps `other` and removes the rest.
- A form no language had yet (adding Russian to an English project) becomes a key the first time someone writes it.
- **A different text for 0** ("Aucun message" next to "1 message"): i18next reads `key_zero` for a count of 0 in every language, before the language's own form. Use **+ Text for 0** under a language in the editor, or **Separate text for 0** when adding the key. It's per language and optional: French can have one while English keeps "0 messages", and 0 uses the language's own form (French one, English other) where there's none. **×** on a language's zero row removes it there; the last one removes the `_zero` key. Edit key → **Remove everywhere** clears it in every language. Languages whose rules have a real zero form (Arabic, Welsh) always get it, as a required form.
- French, Spanish, Italian and Portuguese also have a `many` form in CLDR that only millions use (1 000 000 de…). It isn't required and isn't offered; a `many` text that's already there (from an import) is still shown, like any form a language doesn't need but has text for.

## Wiring up an app

The **Integration** tab of each project shows these commands with the right URL and slug filled in.

```bash
mkdir -p scripts && curl -o scripts/i18n-pull.mjs https://<your-hub>.vercel.app/i18n-pull.mjs
```

```bash
# App's Vercel env vars, and .env.local for local work
I18N_API_URL=https://<your-hub>.vercel.app
I18N_PROJECT=dashboard
I18N_TOKEN=<PULL_TOKEN>
```

```json
"scripts": {
  "i18n:pull": "node scripts/i18n-pull.mjs --out src/locales",
  "prebuild": "npm run i18n:pull"
}
```

| Flag | Env var | Default | |
| --- | --- | --- | --- |
| `--out` | `I18N_OUT_DIR` | `src/locales` | Output folder |
| `--pattern` | `I18N_PATTERN` | `{lang}.json` | e.g. `{lang}/translation.json` for i18next |
| `--format` | `I18N_FORMAT` | `flat` | `nested` builds objects from dotted keys |
| `--version` | `I18N_VERSION` | `current` | `current`, `latest`, `draft`, or a number |
| `--fallback` | `I18N_FALLBACK` | off | Fill missing strings from the base language |
| `--soft` | `I18N_SOFT_FAIL` | off | Warn instead of failing the build if the hub is unreachable |

Once builds pull reliably, gitignore the locale folder. Keep it committed plus `--soft` if you want a safety net.

For apps that commit locale files, copy `public/i18n-sync.yml` into `.github/workflows/`, set the `I18N_API_URL` repo variable and `I18N_TOKEN` secret, allow Actions to create pull requests, then add a GitHub Actions deploy target pointing at it.

## API

All routes are under `/api`. Everything except auth and pull needs the session cookie.

| Method | Path | |
| --- | --- | --- |
| GET | `/pull/:slug?version=&format=&lang=&fallback=` | Bearer `PULL_TOKEN` (or session). Without `lang`: `{ project, version, publishedAt, baseLanguage, languages }`. With `lang`: that language's object only. |
| POST | `/auth/login` `{ password }`, `/auth/logout`; GET `/auth/me` | |
| GET, POST | `/projects` | |
| GET, PATCH, DELETE | `/projects/:slug` | PATCH `{ name, languages, baseLanguage }`; removing a language deletes its draft strings |
| POST, PATCH, DELETE | `/projects/:slug/keys` | Key in the body: `{ key, description, values }`, `{ key, newKey, description }`, `{ keys: [] }`. With `plural: true`, POST creates every form (`values: { lang: { form: text } }`) and PATCH renames all of them |
| POST | `/projects/:slug/keys/plural` | `{ key, plural }`: makes a key plural (its text becomes `other`) or singular (keeps `other`) |
| POST | `/projects/:slug/keys/duplicate` | `{ key, plural?, type? }`: copies the key (every form of a plural key) to `key_copy`, `key_copy2`… |
| POST | `/projects/:slug/keys/history` | `{ keys }` (up to 20): recorded changes, newest first, and the value each release published |
| PUT | `/projects/:slug/translations` | `{ key, language, value, create }`; empty value deletes, `create` adds a missing plural form |
| POST | `/projects/:slug/import` | `{ language, entries: { flat }, overwrite }` |
| GET, POST | `/projects/:slug/releases` | POST `{ note, targetIds }` publishes and deploys |
| GET | `/projects/:slug/releases/:version` | Snapshot |
| POST | `/projects/:slug/releases/:version/activate` | `{ targetIds }` rollback |
| POST, PATCH, DELETE | `/projects/:slug/targets[/:id]` | `{ name, type, config, autoOnPublish }` |
| POST | `/projects/:slug/targets/:id/trigger` | Deploys the live version |
| GET | `/projects/:slug/deploys` | Last 40 runs |

## Tests

```bash
npm run test:api   # full API flow against in-memory Postgres (PGlite)
npm run typecheck
```

## Known limits and next steps

- One shared password, no per-person history. Next step: Google/GitHub sign-in and an `updated_by` column, or Vercel Deployment Protection in front of the UI.
- Last write wins if two people edit the same cell at the same moment.
- Request bodies are capped at 4.5 MB by Vercel, so very large imports should be split per language (the import dialog already sends one request per file).
- Plurals and ICU messages are stored as plain strings, exactly as your i18n library expects them.
