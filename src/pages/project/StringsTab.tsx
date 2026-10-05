import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { faClockRotateLeft, faClone, faCopy, faPen, faTrashCan, faXmark, type IconDefinition } from '@fortawesome/pro-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Button, Checkbox, Code, Dialog, Empty, Field, Input, LangTag, Select, Spinner, Textarea, codeQuoted, cx, formatDate, languageName } from '../../components/ui'
import { useToast } from '../../components/Toasts'
import { api, errorMessage } from '../../lib/api'
import { cellId, type Diff } from '../../lib/diff'
import {
  PLURAL_FORMS,
  canAddZero,
  formExamples,
  formStatus,
  groupDescription,
  groupFlatKeys,
  groupKeys,
  isChanged,
  isMissing,
  matchesSearch,
  nameTaken,
  parsePluralKey,
  pluralForms,
  pluralKey,
  shownForms,
  zeroFallback,
  type Group,
  type PluralForm,
  type PluralGroup,
} from '../../lib/keyGroups'
import { splitTokens, tokenParts, type Segment } from '../../lib/placeholders'
import type { HistoryEdit, HistoryRelease, KeyRow, ProjectDetail, Snapshot } from '../../lib/types'
import { ImportDialog } from './ImportDialog'

const PAGE_SIZE = 100

type SaveCell = (key: string, lang: string, value: string) => Promise<void>
type DeleteKeys = (keys: string[]) => Promise<void>

/** The quick actions under each key. */
interface KeyActions {
  edit: (group: Group) => void
  history: (group: Group) => void
  duplicate: (group: Group) => Promise<void>
  remove: (group: Group) => Promise<void>
}

const byKey = (a: KeyRow, b: KeyRow) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

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
  const [editing, setEditing] = useState<Group | null>(null)
  const [historyOf, setHistoryOf] = useState<Group | null>(null)
  const query = useDeferredValue(search)
  const toast = useToast()
  const slug = encodeURIComponent(project.slug)

  const langs = useMemo(
    () => [project.baseLanguage, ...project.languages.filter((l) => l !== project.baseLanguage)],
    [project.baseLanguage, project.languages],
  )

  // items_one + items_other… are one plural key here; each language only needs its own forms.
  // Sorted by the name people see, so inbox.unread comes before inbox.unread_copy.
  const groups = useMemo(() => groupKeys(keys).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)), [keys])

  const missingCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const l of langs) counts[l] = groups.filter((g) => isMissing(g, l)).length
    return counts
  }, [groups, langs])

  const changedCount = useMemo(() => groups.filter((g) => isChanged(g, langs, diff)).length, [groups, langs, diff])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return groups.filter((g) => {
      if (filter === 'missing' && !langs.some((l) => isMissing(g, l))) return false
      if (filter.startsWith('missing:') && !isMissing(g, filter.slice(8))) return false
      if (filter === 'changed' && !isChanged(g, langs, diff)) return false
      return !q || matchesSearch(g, q)
    })
  }, [groups, query, filter, langs, diff])

  useEffect(() => setPage(0), [query, filter])

  // A new page, search or filter starts at the top of the list.
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Braces matter: recent Chrome returns a Promise from scrollTo, and an effect may only return a cleanup function.
    listRef.current?.scrollTo({ top: 0 })
  }, [page, query, filter])

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const visible = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const keysRef = useRef(keys)
  useLayoutEffect(() => {
    keysRef.current = keys
  })

  const saveCell = useCallback<SaveCell>(
    async (key, lang, value) => {
      // A plural form no language had written yet (Russian "few" next to English one/other)
      // becomes a key on its first save.
      const create = !keysRef.current.some((k) => k.key === key)
      if (create && value === '') return
      try {
        await api(`/projects/${slug}/translations`, { method: 'PUT', body: { key, language: lang, value, create } })
      } catch (err) {
        toast(<><Code>{key}</Code> ({lang}): {codeQuoted(errorMessage(err))}</>, 'error')
        throw err
      }
      setKeys((ks) => {
        if (!ks.some((k) => k.key === key)) {
          const form = parsePluralKey(key)
          const other = form && ks.find((k) => k.key === pluralKey(form.base, form.type, 'other'))
          return [...ks, { key, description: other?.description ?? '', values: { [lang]: value } }].sort(byKey)
        }
        return ks.map((k) => {
          if (k.key !== key) return k
          const values = { ...k.values }
          if (value === '') delete values[lang]
          else values[lang] = value
          return { ...k, values }
        })
      })
    },
    [slug, setKeys, toast],
  )

  const deleteKeys = useCallback<DeleteKeys>(
    async (doomed) => {
      try {
        await api(`/projects/${slug}/keys`, { method: 'DELETE', body: { keys: doomed } })
      } catch (err) {
        toast(errorMessage(err), 'error')
        throw err
      }
      setKeys((ks) => ks.filter((k) => !doomed.includes(k.key)))
    },
    [slug, setKeys, toast],
  )

  const actions = useMemo<KeyActions>(
    () => ({
      edit: setEditing,
      history: setHistoryOf,
      duplicate: async (group) => {
        try {
          const r = await api<{ key: string }>(`/projects/${slug}/keys/duplicate`, {
            method: 'POST',
            body: { key: group.key, ...(group.kind === 'plural' && { plural: true, type: group.type }) },
          })
          await reload()
          toast(<>Duplicated as <Code>{r.key}</Code></>)
        } catch (err) {
          toast(errorMessage(err), 'error')
        }
      },
      remove: async (group) => {
        try {
          await deleteKeys(groupFlatKeys(group))
          toast(<>Deleted <Code>{group.key}</Code></>)
        } catch {
          // deleteKeys already said what went wrong
        }
      },
    }),
    [slug, reload, toast, deleteKeys],
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-sunken px-5 py-3">
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search keys and text"
          aria-label="Search keys and text"
          className="w-full sm:w-72"
        />
        <Select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter" className="w-auto">
          <option value="all">All keys ({groups.length})</option>
          <option value="changed">Changed since live ({changedCount})</option>
          <option value="missing">Missing a translation</option>
          {langs.map((l) => (
            <option key={l} value={`missing:${l}`}>
              Missing in {l} ({missingCounts[l]})
            </option>
          ))}
        </Select>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[13px]">
          {langs.map((l) =>
            missingCounts[l] > 0 ? (
              <button
                key={l}
                onClick={() => setFilter(`missing:${l}`)}
                className="inline-flex items-center gap-1.5 text-rust hover:underline"
                title={`Show keys missing in ${languageName(l)}`}
              >
                <LangTag lang={l} base={l === project.baseLanguage} />
                {missingCounts[l]} missing
              </button>
            ) : (
              <span key={l} className="inline-flex items-center gap-1.5 text-moss">
                <LangTag lang={l} base={l === project.baseLanguage} />
                Complete
              </span>
            ),
          )}
        </div>
        <div className="ml-auto flex gap-2">
          <Button onClick={() => setImporting(true)}>
            Import
          </Button>
          <Button onClick={() => setAdding(true)}>
            Add key
          </Button>
        </div>
      </div>

      {/* Takes whatever height the toolbar and the bottom bar leave, and scrolls on its own. */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto bg-surface">
        {visible.map((group) =>
          group.kind === 'plural' ? (
            <PluralRow
              key={`${group.type}:${group.key}`}
              group={group}
              langs={langs}
              baseLanguage={project.baseLanguage}
              changedCells={groupFlatKeys(group)
                .flatMap((k) => langs.filter((l) => diff.changedCells.has(cellId(k, l))).map((l) => cellId(k, l)))
                .join('\u0001')}
              live={live?.snapshot ?? null}
              hasLive={live !== null}
              onSave={saveCell}
              onDeleteKeys={deleteKeys}
              actions={actions}
            />
          ) : (
            <Row
              key={group.key}
              group={group}
              langs={langs}
              baseLanguage={project.baseLanguage}
              changedLangs={langs.filter((l) => diff.changedCells.has(cellId(group.key, l))).join(',')}
              live={live?.snapshot ?? null}
              hasLive={live !== null}
              onSave={saveCell}
              actions={actions}
            />
          ),
        )}
        {rows.length === 0 && <p className="px-5 py-10 text-sm text-muted">No keys match this search and filter.</p>}
      </div>

      <div className="sticky bottom-0 z-10 flex shrink-0 items-center justify-between gap-4 border-t border-line bg-sunken px-5 py-2.5 text-sm text-muted">
        <span>
          {rows.length === groups.length ? '' : `${rows.length} of `}
          {groups.length === 1 ? '1 key' : `${groups.length} keys`}
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
      {editing && <EditKeyDialog detail={detail} group={editing} onClose={() => setEditing(null)} onChanged={reload} />}
      {historyOf && <HistoryDialog detail={detail} group={historyOf} langs={langs} onClose={() => setHistoryOf(null)} onRestore={saveCell} />}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function ActionButton({
  icon,
  label,
  onClick,
  busy = false,
  danger = false,
}: {
  icon: IconDefinition
  label: string
  onClick: () => void
  busy?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={label}
      aria-label={label}
      className={cx(
        'grid size-7 place-items-center rounded text-muted transition-colors disabled:cursor-wait',
        danger ? 'hover:bg-rust-soft hover:text-rust' : 'hover:bg-ink/5 hover:text-ink',
      )}
    >
      {busy ? <Spinner size="xs" /> : <FontAwesomeIcon icon={icon} className="size-3.5" />}
    </button>
  )
}

/** The key column: its name (opens the edit dialog), a plural badge, its description and quick actions. */
function KeyName({ group, actions }: { group: Group; actions: KeyActions }) {
  const description = groupDescription(group)
  const toast = useToast()
  const [busy, setBusy] = useState<'duplicate' | 'delete' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // The second click has to come soon, or the button goes back to normal.
  useEffect(() => {
    if (!confirmDelete) return
    const timer = setTimeout(() => setConfirmDelete(false), 4000)
    return () => clearTimeout(timer)
  }, [confirmDelete])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(group.key)
      toast(<>Copied <Code>{group.key}</Code></>)
    } catch {
      toast('The browser didn’t allow copying', 'error')
    }
  }
  const duplicate = async () => {
    setBusy('duplicate')
    await actions.duplicate(group)
    setBusy(null)
  }
  const remove = async () => {
    if (!confirmDelete) return setConfirmDelete(true)
    setBusy('delete')
    await actions.remove(group)
    setBusy(null)
  }

  return (
    <div className="border-b border-line px-4 py-3 md:border-r md:border-b-0">
      {/* Keeps the key name in view while scrolling through a long list of languages. */}
      <div className="md:sticky md:top-3">
        <button
          onClick={() => actions.edit(group)}
          className="text-left font-mono text-md leading-snug break-all text-ink hover:text-cobalt"
          title="Rename, describe or delete this key"
        >
          {group.key}
        </button>
        {group.kind === 'plural' && (
          <span
            className="inline-flex h-5 items-center rounded bg-blue-200 px-1.5 align-middle text-xs font-medium text-blue-700 dark:bg-blue-700 dark:text-blue-200"
            title="One text per plural form; each language only gets the forms it uses"
          >
            {group.type === 'ordinal' ? 'Ordinal plural' : 'Plural'}
          </span>
        )}
        {description && <p className="mt-1 text-[13px] leading-snug text-muted">{description}</p>}
        <div className="mt-2 -ml-1.5 flex flex-wrap items-center gap-0.5">
          <ActionButton icon={faPen} label="Edit" onClick={() => actions.edit(group)} />
          <ActionButton icon={faCopy} label={`Copy “${group.key}”`} onClick={copy} />
          <ActionButton icon={faClone} label={`Duplicate as ${group.key}_copy`} busy={busy === 'duplicate'} onClick={duplicate} />
          <ActionButton icon={faClockRotateLeft} label="History" onClick={() => actions.history(group)} />
          {confirmDelete ? (
            <button
              type="button"
              onClick={remove}
              disabled={busy === 'delete'}
              className="inline-flex h-7 items-center gap-1.5 rounded bg-rust-soft px-2 text-xs font-medium text-rust disabled:cursor-wait"
            >
              {busy === 'delete' ? <Spinner size="xs" /> : <FontAwesomeIcon icon={faTrashCan} className="size-3.5" />}
              {group.kind === 'plural' ? 'Click again: delete every form' : 'Click again to delete'}
            </button>
          ) : (
            <ActionButton icon={faTrashCan} label="Delete" danger onClick={remove} />
          )}
        </div>
      </div>
    </div>
  )
}

const labelClass = 'border-r border-line bg-sunken px-3 py-2.5 text-right text-sm leading-snug sm:px-4'

function LanguageName({ lang }: { lang: string }) {
  const name = languageName(lang)
  return (
    <>
      {name}
      {name !== lang && <span className="ml-1.5 font-mono text-[12px] font-normal text-muted">{lang}</span>}
    </>
  )
}

/** An ordinary key: its name on the left, one row per language on the right (stacked on narrow screens). */
const Row = memo(function Row({
  group,
  langs,
  baseLanguage,
  changedLangs,
  live,
  hasLive,
  onSave,
  actions,
}: {
  group: Extract<Group, { kind: 'single' }>
  langs: string[]
  baseLanguage: string
  changedLangs: string
  live: Snapshot | null
  hasLive: boolean
  onSave: SaveCell
  actions: KeyActions
}) {
  const changed = changedLangs ? changedLangs.split(',') : []
  const row = group.row
  return (
    <div className="grid border-b border-line-strong md:grid-cols-[16rem_1fr] xl:grid-cols-[22rem_1fr]">
      <KeyName group={group} actions={actions} />
      <div className="divide-y divide-line">
        {langs.map((lang) => (
          <Cell
            key={lang}
            rowKey={row.key}
            lang={lang}
            label={<LanguageName lang={lang} />}
            strong={lang === baseLanguage}
            value={row.values[lang]}
            liveValue={live?.[lang]?.[row.key]}
            changed={hasLive ? changed.includes(lang) : row.values[lang] !== undefined}
            onSave={onSave}
          />
        ))}
      </div>
    </div>
  )
})

/**
 * A plural key: per language, one cell per plural form that language uses, labelled with
 * the counts that pick it (Russian one: 1, 21, 31…). Japanese gets a single "other" cell.
 */
const PluralRow = memo(function PluralRow({
  group,
  langs,
  baseLanguage,
  changedCells,
  live,
  hasLive,
  onSave,
  onDeleteKeys,
  actions,
}: {
  group: PluralGroup
  langs: string[]
  baseLanguage: string
  changedCells: string
  live: Snapshot | null
  hasLive: boolean
  onSave: SaveCell
  onDeleteKeys: DeleteKeys
  actions: KeyActions
}) {
  const changed = new Set(changedCells ? changedCells.split('\u0001') : [])
  // Languages where someone asked for a separate text for 0; it becomes a key on its first save.
  const [zeroFor, setZeroFor] = useState<string[]>([])
  const hasZero = group.forms.zero !== undefined
  useEffect(() => {
    if (!hasZero) setZeroFor([]) // removed for every language from the edit dialog
  }, [hasZero])

  /** Drops one language's text for 0; the last one takes the zero key with it. */
  const removeZero = async (lang: string) => {
    const zero = group.forms.zero
    setZeroFor((l) => l.filter((x) => x !== lang))
    if (zero?.values[lang] === undefined) return
    if (Object.keys(zero.values).every((l) => l === lang)) await onDeleteKeys([zero.key])
    else await onSave(zero.key, lang, '')
  }
  return (
    <div className="grid border-b border-line-strong md:grid-cols-[16rem_1fr] xl:grid-cols-[22rem_1fr]">
      <KeyName group={group} actions={actions} />
      <div className="divide-y divide-line">
        {langs.map((lang) => (
          <div key={lang} className="grid grid-cols-[7rem_1fr] sm:grid-cols-[10rem_1fr]">
            <div
              className={cx(labelClass, lang === baseLanguage ? 'font-semibold text-ink' : 'text-ink-soft')}
              title={lang === baseLanguage ? `${lang} (base language)` : lang}
            >
              <LanguageName lang={lang} />
              {canAddZero(group, lang) && !zeroFor.includes(lang) && (
                <button
                  onClick={() => setZeroFor((l) => [...l, lang])}
                  className="mt-1 block w-full text-right text-xs font-normal text-cobalt hover:underline"
                  title={`Write a different text for 0, like “Aucun message”. Without it, 0 uses the ${zeroFallback(lang)} text.`}
                >
                  + Text for 0
                </button>
              )}
            </div>
            <div className="divide-y divide-line">
              {shownForms(group, lang, zeroFor.includes(lang)).map((form) => {
                const flat = pluralKey(group.key, group.type, form)
                const value = group.forms[form]?.values[lang]
                const status = formStatus(group, lang, form)
                return (
                  <Cell
                    key={form}
                    rowKey={flat}
                    lang={lang}
                    narrow
                    optional={status === 'optional'}
                    placeholder={status === 'optional' ? `Empty: 0 uses the ${zeroFallback(lang)} text` : undefined}
                    label={
                      <>
                        <span className={status === 'unused' ? 'text-muted line-through' : 'text-ink'}>{form}</span>
                        <span className="block font-mono text-[11.5px] font-normal text-muted">
                          {status === 'required'
                            ? formExamples(lang, group.type, form, group.type === 'cardinal' && group.forms.zero?.values[lang] !== undefined)
                            : status === 'optional'
                              ? '0, optional'
                              : `not used in ${languageName(lang)}`}
                        </span>
                      </>
                    }
                    ariaLabel={`${group.key} (${form}) in ${languageName(lang)}`}
                    value={value}
                    liveValue={live?.[lang]?.[flat]}
                    changed={hasLive ? changed.has(cellId(flat, lang)) : value !== undefined}
                    onSave={onSave}
                    onRemove={status === 'optional' ? () => removeZero(lang) : undefined}
                    removeLabel={`Remove the text for 0 in ${languageName(lang)}`}
                  />
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
})

// The textarea and TokenText must lay text out identically, so they share these.
const cellText = 'py-2.5 pr-9 pl-4 text-[15px] leading-snug'

/**
 * Colours {{placeholders}} and <tags> the way Lokalise does: delimiters in purple, what they
 * wrap in a lighter purple. A textarea can't colour parts of its text, so in cells with
 * tokens this layer draws the text behind it with the same layout, and the textarea's own
 * text goes transparent; typing, the caret, selection and spellcheck stay native.
 */
function TokenText({ parts, lang }: { parts: Segment[]; lang: string }) {
  return (
    <div
      aria-hidden
      lang={lang}
      className={cx(cellText, 'pointer-events-none absolute inset-0 overflow-hidden break-words whitespace-pre-wrap text-ink')}
    >
      {parts.map((part, i) => {
        if (!part.kind) return part.text
        const [open, inner, close] = tokenParts(part.text)
        return (
          <span key={i} className="text-fuchsia-600 dark:text-fuchsia-500">
            {open}
            <span className="text-fuchsia-500 dark:text-fuchsia-400">{inner}</span>
            {close}
          </span>
        )
      })}
    </div>
  )
}

/* Cell heights ---------------------------------------------------- */

function fitHeight(el: HTMLTextAreaElement) {
  el.style.height = '0px'
  el.style.height = `${el.scrollHeight}px`
}

// A height measured once goes stale whenever lines wrap differently: a scrollbar appearing
// in the list, a resized window, web fonts finishing loading. So every cell is measured
// again when its width changes (one shared observer) and once fonts are in.
const mountedCells = new Set<HTMLTextAreaElement>()
const knownWidths = new WeakMap<Element, number>()
const pendingFits = new Set<HTMLTextAreaElement>()

const widthObserver = new ResizeObserver((entries) => {
  for (const { target, contentRect } of entries) {
    // Our own height changes notify too; only a new width can change the wrapping.
    if (knownWidths.get(target) === contentRect.width) continue
    knownWidths.set(target, contentRect.width)
    pendingFits.add(target as HTMLTextAreaElement)
  }
  // Resizing inside the callback would trip the browser's "ResizeObserver loop" warning,
  // and a timeout (unlike requestAnimationFrame) also runs in background tabs.
  if (pendingFits.size) {
    setTimeout(() => {
      pendingFits.forEach(fitHeight)
      pendingFits.clear()
    })
  }
})
document.fonts.addEventListener('loadingdone', () => mountedCells.forEach(fitHeight))

/** Keeps a cell's textarea exactly as tall as its text. */
function useFitHeight(ref: RefObject<HTMLTextAreaElement | null>, text: string) {
  useLayoutEffect(() => {
    if (ref.current) fitHeight(ref.current)
  }, [ref, text])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    mountedCells.add(el)
    widthObserver.observe(el)
    return () => {
      mountedCells.delete(el)
      widthObserver.unobserve(el)
    }
  }, [ref])
}

function Cell({
  rowKey,
  lang,
  label,
  strong = false,
  narrow = false,
  optional = false,
  placeholder = 'Missing',
  ariaLabel,
  value,
  liveValue,
  changed,
  onSave,
  onRemove,
  removeLabel,
}: {
  rowKey: string
  lang: string
  /** What the label column says: the language, or a plural form and its counts. */
  label: ReactNode
  strong?: boolean
  narrow?: boolean
  /** An empty optional cell isn't missing (a zero form, which falls back to the language's own form). */
  optional?: boolean
  placeholder?: string
  ariaLabel?: string
  value: string | undefined
  liveValue: string | undefined
  changed: boolean
  onSave: SaveCell
  /** Shows a × that drops this cell (a language's optional text for 0). */
  onRemove?: () => void
  removeLabel?: string
}) {
  const [text, setText] = useState(value ?? '')
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle')
  const ref = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  const name = languageName(lang)

  useEffect(() => setText(value ?? ''), [value])
  useFitHeight(ref, text)
  const parts = useMemo(() => splitTokens(text), [text])
  const hasTokens = parts.some((part) => part.kind)

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

  const missing = !optional && value === undefined && text === ''
  const title = changed
    ? liveValue === undefined
      ? 'Not in the live release yet'
      : `Live: ${liveValue}`
    : undefined

  return (
    <div className={narrow ? 'grid grid-cols-[6rem_1fr] sm:grid-cols-[8rem_1fr]' : 'grid grid-cols-[7rem_1fr] sm:grid-cols-[10rem_1fr]'}>
      <label
        htmlFor={id}
        className={cx(labelClass, strong ? 'font-semibold text-ink' : 'text-ink-soft')}
        title={narrow ? undefined : strong ? `${lang} (base language)` : lang}
      >
        {label}
      </label>
      <div
        className={cx(
          'relative focus-within:bg-surface',
          missing && 'bg-rust-soft/50',
          changed && 'shadow-[inset_3px_0_0_var(--color-cobalt)]',
          status === 'error' && 'shadow-[inset_0_0_0_2px_var(--color-rust)]',
        )}
        title={title}
      >
        {hasTokens && <TokenText parts={parts} lang={lang} />}
        <textarea
          id={id}
          ref={ref}
          rows={1}
          value={text}
          lang={lang}
          spellCheck
          aria-label={ariaLabel ?? `${rowKey} in ${name}`}
          placeholder={placeholder}
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
          // `relative` paints it above TokenText, and it has no background so TokenText shows through.
          // Selected text is drawn by the textarea itself, so it stays readable over the selection colour.
          className={cx(
            cellText,
            'relative block min-h-full w-full resize-none overflow-hidden bg-transparent placeholder:italic focus:shadow-[inset_0_0_0_2px_var(--color-cobalt)] focus:outline-none',
            optional ? 'placeholder:text-muted' : 'placeholder:text-rust/60',
            hasTokens ? 'text-transparent caret-ink selection:text-ink' : 'text-ink',
          )}
        />
        {status === 'saving' && <Spinner className="absolute top-3 right-3 size-3.5 text-muted" />}
        {onRemove && status !== 'saving' && (
          <button
            type="button"
            // Keeps focus in the textarea, so a half-typed text isn't saved on the way out.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onRemove}
            aria-label={removeLabel}
            title={removeLabel}
            className="absolute top-2 right-2 grid size-6 place-items-center rounded text-muted hover:bg-rust-soft hover:text-rust"
          >
            <FontAwesomeIcon icon={faXmark} className="size-3.5" />
          </button>
        )}
      </div>
    </div>
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
  const [plural, setPlural] = useState(false)
  const [zero, setZero] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [pluralValues, setPluralValues] = useState<Record<string, Partial<Record<PluralForm, string>>>>({})
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const name = key.trim()
  const exists = nameTaken(detail.keys, name)
  const idBase = useId()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api(`/projects/${encodeURIComponent(detail.project.slug)}/keys`, {
        method: 'POST',
        body: plural ? { key: name, description, plural: true, zero, values: pluralValues } : { key: name, description, values },
      })
      await onAdded()
      toast(<>Added <Code>{name}</Code></>)
      onClose()
    } catch (err) {
      toast(errorMessage(err), 'error')
      setBusy(false)
    }
  }

  const langLabel = (l: string) => (l === detail.project.baseLanguage ? `${languageName(l)} (base)` : languageName(l))

  return (
    <Dialog
      title="Add key"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="add-key" variant="primary" busy={busy} disabled={!name || exists}>
            Add key
          </Button>
        </>
      }
    >
      <form id="add-key" onSubmit={submit} className="flex flex-col gap-4">
        <Field
          label="Key"
          hint={
            exists ? (
              <span className="text-rust">This key already exists.</span>
            ) : (
              <>
                Dots create groups in nested files, like <Code>settings.profile.title</Code>.
              </>
            )
          }
        >
          {(id) => <Input id={id} autoFocus className="font-mono" value={key} onChange={(e) => setKey(e.target.value)} />}
        </Field>
        <Field label="Description" hint="Optional context for whoever translates it.">
          {(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <Checkbox checked={plural} onChange={setPlural}>
          Plural
          <span className="block text-xs text-muted">
            The text changes with a number, written as <code className="font-mono">{'{{count}}'}</code>. Each language gets the
            forms it uses: English one and other, Japanese only other, Russian one, few, many and other.
          </span>
        </Checkbox>
        {plural && (
          <Checkbox checked={zero} onChange={setZero}>
            Separate text for 0
            <span className="block text-xs text-muted">
              For “No messages” instead of “0 messages”. i18next uses it for a count of 0 in every language; a language that
              leaves it empty falls back to its own form (French one, English other).
            </span>
          </Checkbox>
        )}
        {!plural &&
          langs.map((l) => (
            <Field key={l} label={langLabel(l)}>
              {(id) => (
                <Textarea id={id} rows={2} lang={l} value={values[l] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [l]: e.target.value }))} />
              )}
            </Field>
          ))}
        {plural &&
          langs.map((l) => (
            <fieldset key={l} className="flex flex-col gap-2">
              <legend className="mb-1 text-sm text-ink">{langLabel(l)}</legend>
              {PLURAL_FORMS.filter((f) => pluralForms(l).includes(f) || (zero && f === 'zero')).map((form) => (
                <div key={form} className="grid grid-cols-[6.5rem_1fr] items-start gap-3">
                  <label htmlFor={`${idBase}-${l}-${form}`} className="pt-1 text-sm text-ink">
                    {form}
                    <span className="block font-mono text-[11.5px] text-muted">
                      {pluralForms(l).includes(form) ? formExamples(l, 'cardinal', form) : '0, optional'}
                    </span>
                  </label>
                  <Textarea
                    id={`${idBase}-${l}-${form}`}
                    rows={1}
                    lang={l}
                    placeholder={form === 'zero' && !pluralForms(l).includes('zero') ? `Optional: empty uses ${zeroFallback(l)}` : '{{count}} …'}
                    value={pluralValues[l]?.[form] ?? ''}
                    onChange={(e) => setPluralValues((v) => ({ ...v, [l]: { ...v[l], [form]: e.target.value } }))}
                  />
                </div>
              ))}
            </fieldset>
          ))}
      </form>
    </Dialog>
  )
}

function EditKeyDialog({
  detail,
  group,
  onClose,
  onChanged,
}: {
  detail: ProjectDetail
  group: Group
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const plural = group.kind === 'plural'
  const type = group.kind === 'plural' ? group.type : 'cardinal'
  const [key, setKey] = useState(group.key)
  const [description, setDescription] = useState(groupDescription(group))
  const [action, setAction] = useState<'save' | 'delete' | 'convert' | 'zero' | null>(null)
  const [confirmZero, setConfirmZero] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmSingular, setConfirmSingular] = useState(false)
  const toast = useToast()
  const slug = encodeURIComponent(detail.project.slug)
  const name = key.trim()
  const taken = name !== group.key && nameTaken(detail.keys, name)
  const busy = action !== null

  const run = async (kind: NonNullable<typeof action>, request: () => Promise<unknown>, done: ReactNode) => {
    setAction(kind)
    try {
      await request()
      await onChanged()
      toast(done)
      onClose()
    } catch (err) {
      toast(errorMessage(err), 'error')
      setAction(null)
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault()
    run(
      'save',
      () =>
        api(`/projects/${slug}/keys`, {
          method: 'PATCH',
          body: { key: group.key, newKey: name === group.key ? undefined : name, description, ...(plural && { plural: true, type }) },
        }),
      'Saved key',
    )
  }

  const remove = () => {
    if (!confirmDelete) return setConfirmDelete(true)
    run('delete', () => api(`/projects/${slug}/keys`, { method: 'DELETE', body: { keys: groupFlatKeys(group) } }), <>Deleted <Code>{group.key}</Code></>)
  }

  const convert = () => {
    if (plural && !confirmSingular) return setConfirmSingular(true)
    run(
      'convert',
      () => api(`/projects/${slug}/keys/plural`, { method: 'POST', body: { key: group.key, plural: !plural, type } }),
      <>
        <Code>{group.key}</Code> {plural ? 'is no longer plural' : 'is now plural'}
      </>,
    )
  }

  const forms = group.kind === 'plural' ? PLURAL_FORMS.filter((f) => group.forms[f]) : []

  // A separate text for 0. Not offered when a project language's rules already have a zero
  // form (Arabic): there it's a required form, not an option.
  const zeroKey = pluralKey(group.key, 'cardinal', 'zero')
  const hasZero = group.kind === 'plural' && group.forms.zero !== undefined
  const zeroOption =
    group.kind === 'plural' && type === 'cardinal' && !detail.project.languages.some((l) => pluralForms(l).includes('zero'))
  const zeroLangs = group.kind === 'plural' ? Object.keys(group.forms.zero?.values ?? {}).map(languageName) : []
  const removeZeroEverywhere = () => {
    if (!confirmZero) return setConfirmZero(true)
    run('zero', () => api(`/projects/${slug}/keys`, { method: 'DELETE', body: { keys: [zeroKey] } }), 'Removed the text for 0')
  }

  return (
    <Dialog
      title="Edit key"
      onClose={onClose}
      footer={
        <>
          <Button variant="danger" onClick={remove} busy={action === 'delete'} disabled={busy} className="mr-auto">
            {confirmDelete ? 'Click again to delete' : plural ? 'Delete key and its forms' : 'Delete key'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="edit-key" variant="primary" busy={action === 'save'} disabled={!name || taken || busy}>
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
            ) : plural ? (
              <>
                Renaming moves every form (
                {forms.map((f, i) => (
                  <span key={f}>
                    {i > 0 && ', '}
                    <Code>{pluralKey(name || group.key, type, f)}</Code>
                  </span>
                ))}
                ).
              </>
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
        <div className="flex items-start justify-between gap-4 rounded-md border border-line px-3 py-2.5">
          <div className="text-sm">
            <div className="text-ink">{plural ? `Plural, with ${forms.join(', ')}` : 'Not plural'}</div>
            <p className="mt-0.5 text-xs text-muted">
              {plural
                ? 'Making it singular keeps the “other” text in every language and removes the other forms.'
                : (
                    <>
                      Make it plural when the text depends on a number (<Code>{'{{count}}'}</Code>). Today’s text becomes the “other”
                      form, and each language gets the forms it uses.
                    </>
                  )}
            </p>
          </div>
          <Button size="sm" onClick={convert} busy={action === 'convert'} disabled={busy || name !== group.key}>
            {plural ? (confirmSingular ? 'Click again to confirm' : 'Make singular') : 'Make plural'}
          </Button>
        </div>
        {zeroOption && hasZero && (
          <div className="flex items-start justify-between gap-4 rounded-md border border-line px-3 py-2.5">
            <div className="text-sm">
              <div className="text-ink">Separate text for 0</div>
              <p className="mt-0.5 text-xs text-muted">
                {zeroLangs.length ? `In ${zeroLangs.join(', ')}. ` : ''}
                Removing it here deletes it in every language, and 0 goes back to each language’s own form. To remove it
                in one language, use × on its zero row.
              </p>
            </div>
            <Button size="sm" onClick={removeZeroEverywhere} busy={action === 'zero'} disabled={busy || name !== group.key}>
              {confirmZero ? 'Click again to remove' : 'Remove everywhere'}
            </Button>
          </div>
        )}
      </form>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */

const sourceLabel: Record<HistoryEdit['source'], string> = {
  edit: 'edited',
  import: 'imported',
  add: 'added',
  duplicate: 'duplicated',
}

interface PastValue {
  text: string | null
  current: boolean
  note: string
  versions: number[]
}

/**
 * One cell's values, newest first: what it says now, each text it had before a recorded
 * change, then values releases published from before changes were recorded.
 */
function pastValues(current: string | undefined, edits: HistoryEdit[], releases: HistoryRelease[]): PastValue[] {
  const versionsOf = (text: string | null) => releases.filter((r) => r.value === text).map((r) => r.version)
  const out: PastValue[] = [{ text: current ?? null, current: true, note: 'Now', versions: versionsOf(current ?? null) }]
  for (const edit of edits) {
    if (edit.previous === null || edit.previous === out[out.length - 1].text) continue
    out.push({ text: edit.previous, current: false, note: `Until ${formatDate(edit.changedAt)}, ${sourceLabel[edit.source]}`, versions: versionsOf(edit.previous) })
  }
  const seen = new Set(out.map((v) => v.text))
  for (const r of releases) {
    if (seen.has(r.value)) continue
    seen.add(r.value)
    out.push({ text: r.value, current: false, note: `Published in v${r.version}, ${formatDate(r.createdAt)}`, versions: [r.version] })
  }
  return out
}

function HistoryDialog({
  detail,
  group,
  langs,
  onClose,
  onRestore,
}: {
  detail: ProjectDetail
  group: Group
  langs: string[]
  onClose: () => void
  onRestore: SaveCell
}) {
  const [data, setData] = useState<{ edits: HistoryEdit[]; releases: HistoryRelease[] } | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  const toast = useToast()
  const slug = encodeURIComponent(detail.project.slug)

  // Every form of a plural key, existing or not, so a form deleted since still shows its past.
  const cells = useMemo(
    () =>
      group.kind === 'plural'
        ? PLURAL_FORMS.map((form) => ({ key: pluralKey(group.key, group.type, form), form }))
        : [{ key: group.key, form: null }],
    [group],
  )

  const load = useCallback(
    () =>
      api<{ edits: HistoryEdit[]; releases: HistoryRelease[] }>(`/projects/${slug}/keys/history`, {
        method: 'POST',
        body: { keys: cells.map((c) => c.key) },
      })
        .then(setData)
        .catch((err) => toast(errorMessage(err), 'error')),
    [slug, cells, toast],
  )
  useEffect(() => {
    load()
  }, [load])

  const restore = async (key: string, lang: string, text: string) => {
    setRestoring(`${key}\u0000${lang}\u0000${text}`)
    try {
      await onRestore(key, lang, text)
      toast(`Restored ${languageName(lang)}`)
      await load()
    } catch {
      // onRestore already showed the error
    }
    setRestoring(null)
  }

  const current = (key: string, lang: string) => detail.keys.find((k) => k.key === key)?.values[lang]
  const sections = data
    ? langs
        .map((lang) => ({
          lang,
          cells: cells
            .map((cell) => ({
              ...cell,
              values: pastValues(
                current(cell.key, lang),
                data.edits.filter((e) => e.key === cell.key && e.language === lang),
                data.releases.filter((r) => r.key === cell.key && r.language === lang),
              ),
            }))
            .filter((cell) => cell.values.length > 1 || cell.values[0].text !== null),
        }))
        .filter((section) => section.cells.length > 0)
    : []
  const nothingYet = data !== null && data.edits.length === 0 && data.releases.length === 0

  return (
    <Dialog
      title={
        <>
          History of <Code>{group.key}</Code>
        </>
      }
      onClose={onClose}
      wide
    >
      {data === null ? (
        <div className="py-6">
          <Spinner size="md" />
        </div>
      ) : nothingYet ? (
        <p className="text-sm text-muted">
          No earlier values yet. Every change is recorded from now on, and the values published by each release show here too.
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {sections.map(({ lang, cells: langCells }) => (
            <section key={lang}>
              <h3 className="mb-2 text-sm font-medium text-ink">{languageName(lang)}</h3>
              <div className="flex flex-col gap-3">
                {langCells.map((cell) => (
                  <div key={cell.key}>
                    {cell.form && <div className="mb-1 font-mono text-xs text-muted">{cell.form}</div>}
                    <ol className="divide-y divide-line overflow-hidden rounded-md border border-line bg-surface">
                      {cell.values.map((v, i) => (
                        <li key={i} className="flex items-start gap-3 px-3 py-2">
                          <div className="min-w-0 flex-1">
                            <div className={cx('text-sm break-words whitespace-pre-wrap', v.text === null ? 'text-muted italic' : 'text-ink')} lang={lang}>
                              {v.text ?? 'Empty'}
                            </div>
                            <div className="mt-0.5 text-xs text-muted">
                              {v.note}
                              {v.versions.length > 0 && ` · live in ${v.versions.map((n) => `v${n}`).join(', ')}`}
                            </div>
                          </div>
                          {!v.current && v.text !== null && v.text !== cell.values[0].text && (
                            <Button
                              size="sm"
                              variant="ghost"
                              busy={restoring === `${cell.key}\u0000${lang}\u0000${v.text}`}
                              disabled={restoring !== null}
                              onClick={() => restore(cell.key, lang, v.text!)}
                            >
                              Restore
                            </Button>
                          )}
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </Dialog>
  )
}
