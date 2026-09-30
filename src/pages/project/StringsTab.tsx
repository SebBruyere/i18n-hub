import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { Button, Dialog, Empty, Field, Input, LangTag, Select, Spinner, Textarea, cx } from '../../components/ui'
import { useToast } from '../../components/Toasts'
import { api, errorMessage } from '../../lib/api'
import { cellId, type Diff } from '../../lib/diff'
import type { KeyRow, ProjectDetail, Snapshot } from '../../lib/types'
import { ImportDialog } from './ImportDialog'

const PAGE_SIZE = 100

type SaveCell = (key: string, lang: string, value: string) => Promise<void>

interface Props {
  detail: ProjectDetail
  diff: Diff
  setKeys: (update: (keys: KeyRow[]) => KeyRow[]) => void
  reload: () => Promise<void>
}

export function StringsTab({ detail, diff, setKeys, reload }: Props) {
  const { project, keys, live } = detail
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [page, setPage] = useState(0)
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState(false)
  const [editing, setEditing] = useState<KeyRow | null>(null)
  const query = useDeferredValue(search)
  const toast = useToast()
  const slug = encodeURIComponent(project.slug)

  const langs = useMemo(
    () => [project.baseLanguage, ...project.languages.filter((l) => l !== project.baseLanguage)],
    [project.baseLanguage, project.languages],
  )

  const missingCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const l of langs) counts[l] = keys.filter((k) => k.values[l] === undefined).length
    return counts
  }, [keys, langs])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return keys.filter((row) => {
      if (filter === 'missing' && langs.every((l) => row.values[l] !== undefined)) return false
      if (filter.startsWith('missing:') && row.values[filter.slice(8)] !== undefined) return false
      if (filter === 'changed' && !langs.some((l) => diff.changedCells.has(cellId(row.key, l)))) return false
      if (!q) return true
      return (
        row.key.toLowerCase().includes(q) ||
        row.description.toLowerCase().includes(q) ||
        Object.values(row.values).some((v) => v.toLowerCase().includes(q))
      )
    })
  }, [keys, query, filter, langs, diff])

  useEffect(() => setPage(0), [query, filter])

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const visible = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const saveCell = useCallback<SaveCell>(
    async (key, lang, value) => {
      try {
        await api(`/projects/${slug}/translations`, { method: 'PUT', body: { key, language: lang, value } })
      } catch (err) {
        toast(`${key} (${lang}): ${errorMessage(err)}`, 'error')
        throw err
      }
      setKeys((ks) =>
        ks.map((k) => {
          if (k.key !== key) return k
          const values = { ...k.values }
          if (value === '') delete values[lang]
          else values[lang] = value
          return { ...k, values }
        }),
      )
    },
    [slug, setKeys, toast],
  )

  if (keys.length === 0) {
    return (
      <div className="mx-auto w-full max-w-5xl px-5 py-10">
        <Empty
          title="This project has no strings yet"
          action={
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => setImporting(true)}>
                Import JSON files
              </Button>
              <Button onClick={() => setAdding(true)}>Add a key</Button>
            </div>
          }
        >
          Import the locale files your app already has (for example <code className="font-mono">en.json</code> and{' '}
          <code className="font-mono">fr.json</code> from your last Lokalise pull). Nested and flat files both work.
        </Empty>
        {importing && <ImportDialog detail={detail} onClose={() => setImporting(false)} onImported={reload} />}
        {adding && <AddKeyDialog detail={detail} langs={langs} onClose={() => setAdding(false)} onAdded={reload} />}
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-sunken px-5 py-3">
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search keys and text"
          aria-label="Search keys and text"
          className="h-9 w-full sm:w-72"
        />
        <Select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter" className="h-9 w-auto">
          <option value="all">All keys ({keys.length})</option>
          <option value="changed">Changed since live ({diff.added.length + diff.changed.length})</option>
          <option value="missing">Missing a translation</option>
          {langs.map((l) => (
            <option key={l} value={`missing:${l}`}>
              Missing in {l} ({missingCounts[l]})
            </option>
          ))}
        </Select>
        <div className="ml-auto flex gap-2">
          <Button size="sm" onClick={() => setImporting(true)}>
            Import
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            Add key
          </Button>
        </div>
      </div>

      <div className="max-h-[calc(100dvh-15rem)] min-h-[24rem] overflow-auto bg-surface">
        <table className="w-full border-separate border-spacing-0 text-[15px]">
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-20 w-[22rem] min-w-[11rem] sm:min-w-[15rem] border-r border-b border-line bg-surface px-4 py-2.5 text-left text-sm font-semibold">
                Key
              </th>
              {langs.map((l) => (
                <th key={l} className="sticky top-0 z-10 min-w-[16rem] border-r border-b border-line bg-surface px-3 py-2.5 text-left">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <LangTag lang={l} base={l === project.baseLanguage} />
                    {missingCounts[l] > 0 ? (
                      <button
                        onClick={() => setFilter(`missing:${l}`)}
                        className="font-normal text-rust hover:underline"
                        title={`Show keys missing in ${l}`}
                      >
                        {missingCounts[l]} missing
                      </button>
                    ) : (
                      <span className="font-normal text-moss">Complete</span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <Row
                key={row.key}
                row={row}
                langs={langs}
                changedLangs={langs.filter((l) => diff.changedCells.has(cellId(row.key, l))).join(',')}
                live={live?.snapshot ?? null}
                hasLive={live !== null}
                onSave={saveCell}
                onEdit={setEditing}
              />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="px-5 py-10 text-sm text-muted">No keys match this search and filter.</p>}
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-line bg-sunken px-5 py-2.5 text-sm text-muted">
        <span>
          {rows.length === keys.length ? `${keys.length} keys` : `${rows.length} of ${keys.length} keys`}
          {diff.changedCells.size > 0 && (
            <span className="ml-4 inline-flex items-center gap-1.5 text-cobalt">
              <span className="inline-block h-3.5 w-[3px] rounded-full bg-cobalt" /> changed since the live release
            </span>
          )}
        </span>
        {pageCount > 1 && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <span>
              Page {page + 1} of {pageCount}
            </span>
            <Button size="sm" variant="ghost" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        )}
      </div>

      {importing && <ImportDialog detail={detail} onClose={() => setImporting(false)} onImported={reload} />}
      {adding && <AddKeyDialog detail={detail} langs={langs} onClose={() => setAdding(false)} onAdded={reload} />}
      {editing && <EditKeyDialog detail={detail} row={editing} onClose={() => setEditing(null)} onChanged={reload} />}
    </div>
  )
}

/* ------------------------------------------------------------------ */

const Row = memo(function Row({
  row,
  langs,
  changedLangs,
  live,
  hasLive,
  onSave,
  onEdit,
}: {
  row: KeyRow
  langs: string[]
  changedLangs: string
  live: Snapshot | null
  hasLive: boolean
  onSave: SaveCell
  onEdit: (row: KeyRow) => void
}) {
  const changed = changedLangs ? changedLangs.split(',') : []
  return (
    <tr>
      <th scope="row" className="sticky left-0 z-[1] border-r border-b border-line bg-surface px-4 py-2.5 text-left align-top font-normal">
        <button
          onClick={() => onEdit(row)}
          className="text-left font-mono text-[13.5px] leading-snug break-all text-ink hover:text-cobalt"
          title="Rename, describe or delete this key"
        >
          {row.key}
        </button>
        {row.description && <p className="mt-1 text-[13px] leading-snug text-muted">{row.description}</p>}
      </th>
      {langs.map((lang) => (
        <Cell
          key={lang}
          rowKey={row.key}
          lang={lang}
          value={row.values[lang]}
          liveValue={live?.[lang]?.[row.key]}
          changed={hasLive ? changed.includes(lang) : row.values[lang] !== undefined}
          onSave={onSave}
        />
      ))}
    </tr>
  )
})

function Cell({
  rowKey,
  lang,
  value,
  liveValue,
  changed,
  onSave,
}: {
  rowKey: string
  lang: string
  value: string | undefined
  liveValue: string | undefined
  changed: boolean
  onSave: SaveCell
}) {
  const [text, setText] = useState(value ?? '')
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => setText(value ?? ''), [value])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  const commit = async () => {
    if (text === (value ?? '')) return
    setStatus('saving')
    try {
      await onSave(rowKey, lang, text)
      setStatus('idle')
    } catch {
      setStatus('error')
    }
  }

  const missing = value === undefined && text === ''
  const title = changed
    ? liveValue === undefined
      ? 'Not in the live release yet'
      : `Live: ${liveValue}`
    : undefined

  return (
    <td
      className={cx(
        'relative border-r border-b border-line p-0 align-top',
        missing && 'bg-rust-soft/50',
        changed && 'shadow-[inset_3px_0_0_var(--color-cobalt)]',
        status === 'error' && 'shadow-[inset_0_0_0_2px_var(--color-rust)]',
      )}
      title={title}
    >
      <textarea
        ref={ref}
        rows={1}
        value={text}
        lang={lang}
        spellCheck
        aria-label={`${rowKey} in ${lang}`}
        placeholder="Missing"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            e.currentTarget.blur()
          }
          if (e.key === 'Escape') {
            setText(value ?? '')
            requestAnimationFrame(() => ref.current?.blur())
          }
        }}
        className="block w-full resize-none overflow-hidden bg-transparent px-3 py-2.5 leading-snug text-ink placeholder:text-rust/60 placeholder:italic focus:bg-surface focus:shadow-[inset_0_0_0_2px_var(--color-cobalt)] focus:outline-none"
      />
      {status === 'saving' && <Spinner className="absolute top-2.5 right-2 size-3.5 text-muted" />}
    </td>
  )
}

/* ------------------------------------------------------------------ */

function AddKeyDialog({
  detail,
  langs,
  onClose,
  onAdded,
}: {
  detail: ProjectDetail
  langs: string[]
  onClose: () => void
  onAdded: () => Promise<void>
}) {
  const [key, setKey] = useState('')
  const [description, setDescription] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const exists = detail.keys.some((k) => k.key === key.trim())

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api(`/projects/${encodeURIComponent(detail.project.slug)}/keys`, {
        method: 'POST',
        body: { key: key.trim(), description, values },
      })
      await onAdded()
      toast(`Added ${key.trim()}`)
      onClose()
    } catch (err) {
      toast(errorMessage(err), 'error')
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Add key"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="add-key" variant="primary" busy={busy} disabled={!key.trim() || exists}>
            Add key
          </Button>
        </>
      }
    >
      <form id="add-key" onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Key" hint={exists ? <span className="text-rust">This key already exists.</span> : 'Dots create groups in nested files, like settings.profile.title.'}>
          {(id) => <Input id={id} autoFocus className="font-mono" value={key} onChange={(e) => setKey(e.target.value)} />}
        </Field>
        <Field label="Description" hint="Optional context for whoever translates it.">
          {(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        {langs.map((l) => (
          <Field key={l} label={l === detail.project.baseLanguage ? `${l} (base)` : l}>
            {(id) => (
              <Textarea id={id} rows={2} lang={l} value={values[l] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [l]: e.target.value }))} />
            )}
          </Field>
        ))}
      </form>
    </Dialog>
  )
}

function EditKeyDialog({
  detail,
  row,
  onClose,
  onChanged,
}: {
  detail: ProjectDetail
  row: KeyRow
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const [key, setKey] = useState(row.key)
  const [description, setDescription] = useState(row.description)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const toast = useToast()
  const slug = encodeURIComponent(detail.project.slug)
  const taken = key.trim() !== row.key && detail.keys.some((k) => k.key === key.trim())

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api(`/projects/${slug}/keys`, {
        method: 'PATCH',
        body: { key: row.key, newKey: key.trim() === row.key ? undefined : key.trim(), description },
      })
      await onChanged()
      toast('Saved key')
      onClose()
    } catch (err) {
      toast(errorMessage(err), 'error')
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!confirmDelete) return setConfirmDelete(true)
    setBusy(true)
    try {
      await api(`/projects/${slug}/keys`, { method: 'DELETE', body: { keys: [row.key] } })
      await onChanged()
      toast(`Deleted ${row.key}`)
      onClose()
    } catch (err) {
      toast(errorMessage(err), 'error')
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Edit key"
      onClose={onClose}
      footer={
        <>
          <Button variant="danger" onClick={remove} busy={busy && confirmDelete} className="mr-auto">
            {confirmDelete ? 'Click again to delete' : 'Delete key'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="edit-key" variant="primary" busy={busy && !confirmDelete} disabled={!key.trim() || taken}>
            Save key
          </Button>
        </>
      }
    >
      <form id="edit-key" onSubmit={save} className="flex flex-col gap-4">
        <Field
          label="Key"
          hint={
            taken ? (
              <span className="text-rust">Another key already uses this name.</span>
            ) : (
              'Renaming changes what your code has to reference once the next release is live.'
            )
          }
        >
          {(id) => <Input id={id} autoFocus className="font-mono" value={key} onChange={(e) => setKey(e.target.value)} />}
        </Field>
        <Field label="Description">
          {(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  )
}
