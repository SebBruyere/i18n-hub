import { useState } from 'react'
import { Button, Checkbox, Dialog, Field, Input } from '../../components/ui'
import { useToast } from '../../components/Toasts'
import { api, errorMessage } from '../../lib/api'
import type { Diff } from '../../lib/diff'
import type { DeployResult, ProjectDetail, Release } from '../../lib/types'
import { TARGET_LABELS } from './DeploysTab'

export function DeployResults({ results }: { results: DeployResult[] }) {
  if (results.length === 0) return null
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {results.map((r) => (
        <li key={r.targetId} className="flex gap-2">
          <span className={r.ok ? 'text-moss' : 'text-rust'}>{r.ok ? 'Started' : 'Failed'}</span>
          <span className="font-semibold">{r.name}</span>
          <span className="min-w-0 truncate text-muted">{r.message}</span>
        </li>
      ))}
    </ul>
  )
}

function KeyList({ label, keys, tone }: { label: string; keys: string[]; tone: string }) {
  if (keys.length === 0) return null
  const shown = keys.slice(0, 40)
  return (
    <div>
      <h3 className={`text-sm font-semibold ${tone}`}>
        {label} ({keys.length})
      </h3>
      <p className="mt-1 font-mono text-[13px] leading-relaxed break-words text-ink-soft">
        {shown.join(', ')}
        {keys.length > shown.length && ` and ${keys.length - shown.length} more`}
      </p>
    </div>
  )
}

export function PublishDialog({
  detail,
  diff,
  nextVersion,
  onClose,
  onPublished,
}: {
  detail: ProjectDetail
  diff: Diff
  nextVersion: number
  onClose: () => void
  onPublished: () => Promise<void>
}) {
  const { project, targets } = detail
  const [note, setNote] = useState('')
  const [selected, setSelected] = useState<number[]>(targets.filter((t) => t.autoOnPublish).map((t) => t.id))
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<DeployResult[] | null>(null)
  const toast = useToast()

  const publish = async () => {
    setBusy(true)
    try {
      const r = await api<{ release: Release; deploys: DeployResult[] }>(`/projects/${encodeURIComponent(project.slug)}/releases`, {
        method: 'POST',
        body: { note, targetIds: selected },
      })
      toast(`Published v${r.release.version}`)
      if (r.deploys.some((d) => !d.ok)) {
        setResults(r.deploys)
        setBusy(false)
        return
      }
      await onPublished()
    } catch (err) {
      toast(errorMessage(err), 'error')
      setBusy(false)
    }
  }

  if (results) {
    return (
      <Dialog
        title={`v${nextVersion} is live, but a deploy failed`}
        onClose={onPublished}
        footer={
          <Button variant="primary" onClick={onPublished}>
            Close
          </Button>
        }
      >
        <p className="mb-4 text-sm text-ink-soft">
          The release is published and pullable. Fix the target on the Deploys tab and run it again from there.
        </p>
        <DeployResults results={results} />
      </Dialog>
    )
  }

  return (
    <Dialog
      title={`Publish v${nextVersion}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={publish} busy={busy}>
            {selected.length ? `Publish and deploy to ${selected.length}` : `Publish v${nextVersion}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <p className="text-sm text-ink-soft">
          Publishing freezes the current strings as v{nextVersion} and makes it the version builds pull.
          {detail.live ? ` Compared with v${detail.live.version}, which is live now:` : ' This is the first release.'}
        </p>
        {detail.live && (
          <div className="flex flex-col gap-3 rounded-lg bg-sunken px-4 py-3">
            <KeyList label="New keys" keys={diff.added} tone="text-moss" />
            <KeyList label="Changed" keys={diff.changed} tone="text-cobalt" />
            <KeyList label="Removed" keys={diff.removed} tone="text-rust" />
          </div>
        )}
        <Field label="Release note" hint="Optional. Shown in the release history.">
          {(id) => <Input id={id} autoFocus value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Onboarding copy for the new plan" />}
        </Field>
        {targets.length > 0 ? (
          <fieldset className="flex flex-col gap-2.5">
            <legend className="mb-2 text-sm font-semibold">Deploy after publishing</legend>
            {targets.map((t) => (
              <Checkbox
                key={t.id}
                checked={selected.includes(t.id)}
                onChange={(on) => setSelected((s) => (on ? [...s, t.id] : s.filter((x) => x !== t.id)))}
              >
                {t.name} <span className="text-muted">({TARGET_LABELS[t.type]})</span>
              </Checkbox>
            ))}
          </fieldset>
        ) : (
          <p className="text-sm text-muted">
            No deploy targets yet. Apps that pull during their build pick this release up on their next deploy. Add a
            target on the Deploys tab to ship it right away.
          </p>
        )}
      </div>
    </Dialog>
  )
}
