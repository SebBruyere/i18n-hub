import { useState, type DragEvent } from 'react'
import { flatten, type Flat } from '../../../api/_lib/format'
import { Button, Checkbox, Dialog, Select, Textarea, cx } from '../../components/ui'
import { useToast } from '../../components/Toasts'
import { api, errorMessage } from '../../lib/api'
import type { ProjectDetail } from '../../lib/types'

interface Pending {
  id: number
  name: string
  language: string
  entries: Flat
  error?: string
}

interface ImportResult {
  newKeys: number
  created: number
  updated: number
  unchanged: number
}

/** "fr.json", "fr-FR.json", "translation.fr.json", "fr_FR.json" → a declared language, if any. */
function guessLanguage(fileName: string, languages: string[]): string {
  const stem = fileName.replace(/\.json$/i, '')
  const candidates = [stem, ...stem.split(/[._\s/]/)].map((c) => c.replace('_', '-'))
  for (const c of candidates) {
    const hit = languages.find((l) => l.toLowerCase() === c.toLowerCase())
    if (hit) return hit
  }
  for (const c of candidates) {
    const hit = languages.find((l) => l.split('-')[0].toLowerCase() === c.split('-')[0].toLowerCase())
    if (hit) return hit
  }
  return ''
}

function parse(text: string, languages: string[], fallbackLang: string): { language: string; entries: Flat } {
  let data: unknown = JSON.parse(text)
  let language = fallbackLang
  // Lokalise can wrap everything in the language code: { "fr": { ... } }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const top = Object.keys(data)
    if (top.length === 1 && languages.includes(top[0])) {
      const inner = (data as Record<string, unknown>)[top[0]]
      if (inner && typeof inner === 'object') {
        language = top[0]
        data = inner
      }
    }
  }
  return { language, entries: flatten(data) }
}

export function ImportDialog({
  detail,
  onClose,
  onImported,
}: {
  detail: ProjectDetail
  onClose: () => void
  onImported: () => Promise<void>
}) {
  const { project, keys } = detail
  const [pending, setPending] = useState<Pending[]>([])
  const [pasted, setPasted] = useState('')
  const [pasteLang, setPasteLang] = useState(project.baseLanguage)
  const [overwrite, setOverwrite] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const existing = new Map(keys.map((k) => [k.key, k.values]))

  const addFiles = async (files: FileList | File[]) => {
    const next: Pending[] = []
    for (const file of Array.from(files)) {
      const id = Date.now() + Math.random()
      try {
        const { language, entries } = parse(await file.text(), project.languages, guessLanguage(file.name, project.languages))
        next.push({ id, name: file.name, language, entries })
      } catch {
        next.push({ id, name: file.name, language: '', entries: {}, error: 'Not valid JSON' })
      }
    }
    setPending((p) => [...p, ...next])
  }

  const addPasted = () => {
    try {
      const { language, entries } = parse(pasted, project.languages, pasteLang)
      setPending((p) => [...p, { id: Date.now(), name: 'Pasted JSON', language, entries }])
      setPasted('')
    } catch {
      toast('The pasted text is not valid JSON', 'error')
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
  }

  const preview = (p: Pending) => {
    let fresh = 0
    let filled = 0
    let replaced = 0
    for (const [key, value] of Object.entries(p.entries)) {
      if (value === '') continue
      const current = existing.get(key)
      if (!current) fresh++
      else if (current[p.language] === undefined) filled++
      else if (current[p.language] !== value) replaced++
    }
    return { fresh, filled, replaced }
  }

  const ready = pending.length > 0 && pending.every((p) => !p.error && p.language)

  const run = async () => {
    setBusy(true)
    const totals: ImportResult = { newKeys: 0, created: 0, updated: 0, unchanged: 0 }
    try {
      for (const p of pending) {
        const r = await api<ImportResult>(`/projects/${encodeURIComponent(project.slug)}/import`, {
          method: 'POST',
          body: { language: p.language, entries: p.entries, overwrite },
        })
        totals.newKeys += r.newKeys
        totals.created += r.created
        totals.updated += r.updated
        totals.unchanged += r.unchanged
      }
      await onImported()
      toast(`Imported ${totals.newKeys} new keys, ${totals.created} new translations, ${totals.updated} replaced`)
      onClose()
    } catch (err) {
      toast(errorMessage(err), 'error')
      await onImported()
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Import JSON"
      wide
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={run} busy={busy} disabled={!ready}>
            Import {pending.length > 1 ? `${pending.length} files` : ''}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <label
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cx(
            'flex cursor-pointer flex-col items-center gap-1 rounded-lg border-2 border-dashed px-6 py-8 text-center',
            dragging ? 'border-cobalt bg-cobalt-soft' : 'border-line-strong hover:border-ink-soft',
          )}
        >
          <span className="font-semibold">Drop locale files here, or choose files</span>
          <span className="text-sm text-muted">
            One file per language, named like <code className="font-mono">en.json</code> or{' '}
            <code className="font-mono">fr-FR.json</code>. Nested objects become dotted keys.
          </span>
          <input
            type="file"
            accept=".json,application/json"
            multiple
            className="sr-only"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </label>

        <details className="rounded-lg border border-line px-4 py-3">
          <summary className="cursor-pointer text-sm font-semibold">Paste JSON instead</summary>
          <div className="mt-3 flex flex-col gap-2">
            <Textarea rows={5} className="font-mono text-[13px]" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder='{ "home": { "title": "Hello" } }' />
            <div className="flex gap-2">
              <Select value={pasteLang} onChange={(e) => setPasteLang(e.target.value)} className="h-8 w-auto text-sm" aria-label="Language of pasted JSON">
                {project.languages.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </Select>
              <Button size="sm" onClick={addPasted} disabled={!pasted.trim()}>
                Add to import
              </Button>
            </div>
          </div>
        </details>

        {pending.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="bg-sunken text-left">
                <tr>
                  <th className="px-3 py-2 font-semibold">File</th>
                  <th className="px-3 py-2 font-semibold">Language</th>
                  <th className="px-3 py-2 font-semibold">What happens</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pending.map((p) => {
                  const s = preview(p)
                  return (
                    <tr key={p.id} className="border-t border-line">
                      <td className="px-3 py-2 font-mono text-[13px]">{p.name}</td>
                      <td className="px-3 py-2">
                        {p.error ? (
                          <span className="text-rust">{p.error}</span>
                        ) : (
                          <Select
                            value={p.language}
                            onChange={(e) => setPending((all) => all.map((x) => (x.id === p.id ? { ...x, language: e.target.value } : x)))}
                            className={cx('h-8 w-auto text-sm', !p.language && 'border-rust')}
                            aria-label={`Language for ${p.name}`}
                          >
                            <option value="">Choose</option>
                            {project.languages.map((l) => (
                              <option key={l}>{l}</option>
                            ))}
                          </Select>
                        )}
                      </td>
                      <td className="px-3 py-2 text-ink-soft">
                        {!p.error &&
                          p.language &&
                          `${s.fresh} new keys, ${s.filled} filled in, ${overwrite ? `${s.replaced} replaced` : `${s.replaced} left as they are`}`}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button className="text-muted hover:text-rust" onClick={() => setPending((all) => all.filter((x) => x.id !== p.id))}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <Checkbox checked={overwrite} onChange={setOverwrite}>
          Replace translations that already exist
          <span className="block text-[13px] text-muted">Off: only empty cells and new keys are filled in.</span>
        </Checkbox>
      </div>
    </Dialog>
  )
}
