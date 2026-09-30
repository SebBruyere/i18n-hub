import { useState, type FormEvent } from 'react'
import { Button, Field, Input, Select } from '../../components/ui'
import { useToast } from '../../components/Toasts'
import { api, errorMessage } from '../../lib/api'
import { navigate } from '../../lib/router'
import type { Project } from '../../lib/types'
import { parseLangList } from '../ProjectList'

export function SettingsTab({ project, reload }: { project: Project; reload: () => Promise<void> }) {
  const [name, setName] = useState(project.name)
  const [langs, setLangs] = useState(project.languages.join(', '))
  const [base, setBase] = useState(project.baseLanguage)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState('')
  const toast = useToast()
  const slug = encodeURIComponent(project.slug)

  const languages = parseLangList(langs)
  const removed = project.languages.filter((l) => !languages.includes(l))

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (removed.length && !window.confirm(`Delete every ${removed.join(', ')} translation? Past releases keep them.`)) return
    setBusy(true)
    try {
      await api(`/projects/${slug}`, { method: 'PATCH', body: { name, languages, baseLanguage: base } })
      await reload()
      toast('Saved settings')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await api(`/projects/${slug}`, { method: 'DELETE' })
      toast(`Deleted ${project.name}`)
      navigate('/')
    } catch (err) {
      toast(errorMessage(err), 'error')
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-10 px-5 py-8">
      <form onSubmit={save} className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Project</h2>
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field
          label="Languages"
          hint={
            removed.length ? (
              <span className="text-rust">Saving deletes the {removed.join(', ')} translations from the draft.</span>
            ) : (
              'Add a code to start translating into it. New languages start empty.'
            )
          }
        >
          {(id) => <Input id={id} className="font-mono" value={langs} onChange={(e) => setLangs(e.target.value)} />}
        </Field>
        <Field label="Base language" hint="The source language. It comes first in the editor and is the fallback with --fallback.">
          {(id) => (
            <Select id={id} value={languages.includes(base) ? base : ''} onChange={(e) => setBase(e.target.value)}>
              {!languages.includes(base) && <option value="">Choose</option>}
              {languages.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </Select>
          )}
        </Field>
        <div>
          <Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || !languages.includes(base)}>
            Save settings
          </Button>
        </div>
      </form>

      <section className="flex flex-col gap-3 rounded-lg border border-rust/30 bg-rust-soft/40 px-5 py-4">
        <h2 className="font-semibold text-rust">Delete project</h2>
        <p className="text-sm text-ink-soft">
          Removes every key, translation, release and deploy target. Builds that pull{' '}
          <span className="font-mono">{project.slug}</span> will start failing.
        </p>
        <Field label={`Type ${project.slug} to confirm`}>
          {(id) => <Input id={id} className="font-mono" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
        </Field>
        <div>
          <Button variant="danger" disabled={confirm !== project.slug} busy={busy} onClick={remove}>
            Delete project
          </Button>
        </div>
      </section>
    </div>
  )
}
