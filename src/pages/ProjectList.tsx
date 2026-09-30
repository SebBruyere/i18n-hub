import { useEffect, useState, type FormEvent } from 'react'
import { Button, Dialog, Empty, Field, Input, LangTag, Select, Spinner } from '../components/ui'
import { useToast } from '../components/Toasts'
import { api, errorMessage } from '../lib/api'
import { linkHandler, navigate } from '../lib/router'
import type { Project } from '../lib/types'

export function ProjectList() {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [creating, setCreating] = useState(false)
  const toast = useToast()

  useEffect(() => {
    api<{ projects: Project[] }>('/projects')
      .then((r) => setProjects(r.projects))
      .catch((err) => toast(errorMessage(err), 'error'))
  }, [toast])

  return (
    <div className="mx-auto max-w-5xl px-5 py-10">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-muted">Each project is one app’s set of strings and the releases its builds pull.</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          New project
        </Button>
      </div>

      {projects === null ? (
        <div className="py-16 text-muted">
          <Spinner />
        </div>
      ) : projects.length === 0 ? (
        <Empty
          title="No projects yet"
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              Create the first project
            </Button>
          }
        >
          Create a project for each app, then drop in the JSON files you currently pull from Lokalise. Keys and
          languages are picked up from the files.
        </Empty>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {projects.map((p) => (
            <li key={p.slug}>
              <a
                href={`/p/${p.slug}`}
                onClick={linkHandler(`/p/${p.slug}`)}
                className="grid grid-cols-1 gap-3 px-5 py-4 hover:bg-sunken sm:grid-cols-[1fr_auto_8rem] sm:items-center"
              >
                <div className="min-w-0">
                  <div className="font-semibold">{p.name}</div>
                  <div className="font-mono text-[13px] text-muted">{p.slug}</div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {p.languages.map((l) => (
                    <LangTag key={l} lang={l} base={l === p.baseLanguage} />
                  ))}
                </div>
                <div className="text-sm sm:text-right">
                  <div>{p.currentVersion ? `v${p.currentVersion} live` : 'Not published'}</div>
                  <div className={p.hasUnpublished ? 'text-cobalt' : 'text-muted'}>
                    {p.hasUnpublished ? 'Unpublished edits' : `${p.keyCount} keys`}
                  </div>
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}

      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </div>
  )
}

const toSlug = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)

export const parseLangList = (value: string) =>
  [...new Set(value.split(/[\s,;]+/).map((l) => l.trim()).filter(Boolean))]

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [langs, setLangs] = useState('en, fr')
  const [base, setBase] = useState('en')
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const languages = parseLangList(langs)
  const effectiveBase = languages.includes(base) ? base : (languages[0] ?? '')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const r = await api<{ project: Project }>('/projects', {
        method: 'POST',
        body: { name, slug, languages, baseLanguage: effectiveBase },
      })
      toast(`Created ${r.project.name}`)
      navigate(`/p/${r.project.slug}`)
    } catch (err) {
      toast(errorMessage(err), 'error')
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="New project"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="new-project" busy={busy} disabled={!name || !slug || languages.length === 0}>
            Create project
          </Button>
        </>
      }
    >
      <form id="new-project" onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name">
          {(id) => (
            <Input
              id={id}
              autoFocus
              value={name}
              placeholder="Dashboard"
              onChange={(e) => {
                setName(e.target.value)
                if (!slugTouched) setSlug(toSlug(e.target.value))
              }}
            />
          )}
        </Field>
        <Field label="Slug" hint="Used in the pull URL and by the pull script. Changing it later breaks existing builds.">
          {(id) => (
            <Input
              id={id}
              className="font-mono"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true)
                setSlug(toSlug(e.target.value))
              }}
            />
          )}
        </Field>
        <div className="grid grid-cols-[1fr_9rem] gap-3">
          <Field label="Languages" hint="Codes like en, fr, pt-BR, separated by commas.">
            {(id) => <Input id={id} className="font-mono" value={langs} onChange={(e) => setLangs(e.target.value)} />}
          </Field>
          <Field label="Base language">
            {(id) => (
              <Select id={id} value={effectiveBase} onChange={(e) => setBase(e.target.value)}>
                {languages.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </form>
    </Dialog>
  )
}
