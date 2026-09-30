import { useEffect, useState } from 'react'
import { Button, Checkbox, Dialog, Empty, Spinner, formatDate } from '../../components/ui'
import { useToast } from '../../components/Toasts'
import { api, errorMessage } from '../../lib/api'
import type { DeployResult, ProjectDetail, Release } from '../../lib/types'
import { DeployResults } from './PublishDialog'

export function ReleasesTab({
  detail,
  reload,
  refreshToken,
}: {
  detail: ProjectDetail
  reload: () => Promise<void>
  refreshToken: number
}) {
  const { project } = detail
  const slug = encodeURIComponent(project.slug)
  const [releases, setReleases] = useState<Release[] | null>(null)
  const [activating, setActivating] = useState<Release | null>(null)
  const toast = useToast()

  useEffect(() => {
    api<{ releases: Release[] }>(`/projects/${slug}/releases`)
      .then((r) => setReleases(r.releases))
      .catch((err) => toast(errorMessage(err), 'error'))
  }, [slug, toast, refreshToken, project.currentVersion])

  const download = async (version: number) => {
    try {
      const data = await api<unknown>(`/pull/${slug}?version=${version}`)
      const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${project.slug}-v${version}.json`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  if (releases === null) {
    return (
      <div className="px-5 py-10 text-muted">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-8">
      {releases.length === 0 ? (
        <Empty title="No releases yet">
          A release is a frozen copy of every string. Builds pull the live release, so edits never reach an app until
          you publish.
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-sunken text-left">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Version</th>
                <th className="px-4 py-2.5 font-semibold">Note</th>
                <th className="px-4 py-2.5 font-semibold">Published</th>
                <th className="px-4 py-2.5 text-right font-semibold">Keys</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {releases.map((r) => (
                <tr key={r.version} className="border-t border-line">
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className="font-semibold">v{r.version}</span>
                    {r.isLive && <span className="ml-2 rounded bg-moss-soft px-1.5 py-0.5 text-[12.5px] font-semibold text-moss">Live</span>}
                  </td>
                  <td className="px-4 py-3 text-ink-soft">{r.note || <span className="text-muted">No note</span>}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-muted">{formatDate(r.createdAt)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.keyCount}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => download(r.version)}>
                        Download
                      </Button>
                      {!r.isLive && (
                        <Button size="sm" onClick={() => setActivating(r)}>
                          Make live
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activating && (
        <MakeLiveDialog
          detail={detail}
          release={activating}
          onClose={() => setActivating(null)}
          onDone={async () => {
            setActivating(null)
            await reload()
          }}
        />
      )}
    </div>
  )
}

function MakeLiveDialog({
  detail,
  release,
  onClose,
  onDone,
}: {
  detail: ProjectDetail
  release: Release
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const [selected, setSelected] = useState<number[]>(detail.targets.filter((t) => t.autoOnPublish).map((t) => t.id))
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<DeployResult[] | null>(null)
  const toast = useToast()

  const run = async () => {
    setBusy(true)
    try {
      const r = await api<{ deploys: DeployResult[] }>(
        `/projects/${encodeURIComponent(detail.project.slug)}/releases/${release.version}/activate`,
        { method: 'POST', body: { targetIds: selected } },
      )
      toast(`v${release.version} is live`)
      if (r.deploys.some((d) => !d.ok)) {
        setResults(r.deploys)
        setBusy(false)
      } else await onDone()
    } catch (err) {
      toast(errorMessage(err), 'error')
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={results ? 'A deploy failed' : `Make v${release.version} live`}
      onClose={results ? onDone : onClose}
      footer={
        results ? (
          <Button variant="primary" onClick={onDone}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" busy={busy} onClick={run}>
              Make v{release.version} live
            </Button>
          </>
        )
      }
    >
      {results ? (
        <DeployResults results={results} />
      ) : (
        <div className="flex flex-col gap-4 text-sm">
          <p className="text-ink-soft">
            Builds will pull v{release.version} instead of v{detail.project.currentVersion}. Your current edits stay as
            they are, and the next publish creates v{(detail.project.latestVersion ?? 0) + 1} from them.
          </p>
          {detail.targets.length > 0 && (
            <fieldset className="flex flex-col gap-2.5">
              <legend className="mb-2 font-semibold">Redeploy so apps pick it up</legend>
              {detail.targets.map((t) => (
                <Checkbox
                  key={t.id}
                  checked={selected.includes(t.id)}
                  onChange={(on) => setSelected((s) => (on ? [...s, t.id] : s.filter((x) => x !== t.id)))}
                >
                  {t.name}
                </Checkbox>
              ))}
            </fieldset>
          )}
        </div>
      )}
    </Dialog>
  )
}
