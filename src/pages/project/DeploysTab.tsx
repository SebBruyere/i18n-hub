import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Button, Checkbox, Dialog, Empty, Field, Input, Select, formatDate } from '../../components/ui'
import { useToast } from '../../components/Toasts'
import { api, errorMessage } from '../../lib/api'
import type { DeployLog, DeployResult, DeployTarget, ProjectDetail, TargetConfig, TargetType } from '../../lib/types'

export const TARGET_LABELS: Record<TargetType, string> = {
  vercel_hook: 'Vercel deploy hook',
  github_workflow: 'GitHub Actions workflow',
  webhook: 'Webhook',
}

const TARGET_HELP: Record<TargetType, string> = {
  vercel_hook:
    'Rebuilds a Vercel project. Its build runs the pull script, so it ships the live release. Create the hook in that project under Settings > Git > Deploy Hooks.',
  github_workflow:
    'Starts a workflow_dispatch workflow with a "version" input. Use it for apps that keep translation files in the repo: the workflow pulls, commits and opens a PR.',
  webhook:
    'POSTs {"event", "project", "version"} as JSON to any URL: a GitLab pipeline trigger, a Netlify build hook, or your own endpoint.',
}

function describe(t: DeployTarget) {
  if (t.type === 'github_workflow') return `${t.config.owner}/${t.config.repo}, ${t.config.workflow} on ${t.config.ref}`
  const url = t.config.url ?? ''
  try {
    const u = new URL(url)
    return t.type === 'vercel_hook' ? `${u.host}${u.pathname.slice(0, 44)}…` : u.host + u.pathname
  } catch {
    return url
  }
}

export function DeploysTab({ detail, reload }: { detail: ProjectDetail; reload: () => Promise<void> }) {
  const { project, targets } = detail
  const slug = encodeURIComponent(project.slug)
  const [logs, setLogs] = useState<DeployLog[]>([])
  const [editing, setEditing] = useState<DeployTarget | 'new' | null>(null)
  const [running, setRunning] = useState<number | null>(null)
  const toast = useToast()

  const loadLogs = useCallback(() => {
    api<{ deploys: DeployLog[] }>(`/projects/${slug}/deploys`)
      .then((r) => setLogs(r.deploys))
      .catch((err) => toast(errorMessage(err), 'error'))
  }, [slug, toast])

  useEffect(loadLogs, [loadLogs, project.currentVersion])

  const trigger = async (t: DeployTarget) => {
    setRunning(t.id)
    try {
      const { deploy } = await api<{ deploy: DeployResult }>(`/projects/${slug}/targets/${t.id}/trigger`, { method: 'POST' })
      toast(deploy.ok ? `${t.name}: ${deploy.message}` : `${t.name} failed: ${deploy.message}`, deploy.ok ? 'success' : 'error')
      loadLogs()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setRunning(null)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-5 py-8">
      <section>
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Deploy targets</h2>
            <p className="text-sm text-muted">What runs when you publish or make a release live. Each app can ship differently.</p>
          </div>
          <Button onClick={() => setEditing('new')}>Add target</Button>
        </div>
        {targets.length === 0 ? (
          <Empty title="No deploy targets">
            Without one, apps pick up a new release the next time they deploy for any reason. Add a Vercel deploy hook to
            rebuild right after publishing, or a GitHub workflow for apps that commit their locale files.
          </Empty>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {targets.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{t.name}</div>
                  <div className="text-sm text-muted">
                    {TARGET_LABELS[t.type]}: <span className="font-mono text-[13px]">{describe(t)}</span>
                  </div>
                  <div className="text-[13px] text-muted">{t.autoOnPublish ? 'Selected by default when publishing' : 'Only when chosen'}</div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>
                    Edit
                  </Button>
                  <Button size="sm" busy={running === t.id} disabled={!project.currentVersion} onClick={() => trigger(t)}>
                    {project.currentVersion ? `Deploy v${project.currentVersion}` : 'Publish first'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold">Recent runs</h2>
        {logs.length === 0 ? (
          <p className="text-sm text-muted">Nothing has been deployed from here yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full text-sm">
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className="border-t border-line first:border-t-0">
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className={l.ok ? 'text-moss' : 'text-rust'}>{l.ok ? 'Started' : 'Failed'}</span>
                    </td>
                    <td className="px-4 py-2.5 font-semibold whitespace-nowrap">{l.name}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap">{l.version ? `v${l.version}` : ''}</td>
                    <td className="max-w-md px-4 py-2.5 break-words text-ink-soft">
                      {l.status ? `${l.status}: ` : ''}
                      {l.message}
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap text-muted">{formatDate(l.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && (
        <TargetDialog
          slug={slug}
          target={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await reload()
          }}
        />
      )}
    </div>
  )
}

function TargetDialog({
  slug,
  target,
  onClose,
  onSaved,
}: {
  slug: string
  target: DeployTarget | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [name, setName] = useState(target?.name ?? 'Production')
  const [type, setType] = useState<TargetType>(target?.type ?? 'vercel_hook')
  const [config, setConfig] = useState<TargetConfig>(target?.config ?? { ref: 'main', tokenEnv: 'GITHUB_TOKEN', workflow: 'i18n-sync.yml' })
  const [auto, setAuto] = useState(target?.autoOnPublish ?? true)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const toast = useToast()
  const set = (field: keyof TargetConfig) => (e: { target: { value: string } }) => setConfig((c) => ({ ...c, [field]: e.target.value }))

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api(target ? `/projects/${slug}/targets/${target.id}` : `/projects/${slug}/targets`, {
        method: target ? 'PATCH' : 'POST',
        body: { name, type, config, autoOnPublish: auto },
      })
      toast(target ? 'Saved target' : 'Added target')
      await onSaved()
    } catch (err) {
      toast(errorMessage(err), 'error')
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!target) return
    if (!confirmDelete) return setConfirmDelete(true)
    setBusy(true)
    try {
      await api(`/projects/${slug}/targets/${target.id}`, { method: 'DELETE' })
      toast('Removed target')
      await onSaved()
    } catch (err) {
      toast(errorMessage(err), 'error')
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={target ? 'Edit deploy target' : 'Add deploy target'}
      onClose={onClose}
      footer={
        <>
          {target && (
            <Button variant="danger" className="mr-auto" onClick={remove} busy={busy && confirmDelete}>
              {confirmDelete ? 'Click again to remove' : 'Remove'}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="target" variant="primary" busy={busy && !confirmDelete}>
            {target ? 'Save target' : 'Add target'}
          </Button>
        </>
      }
    >
      <form id="target" onSubmit={save} className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Type">
            {(id) => (
              <Select id={id} value={type} onChange={(e) => setType(e.target.value as TargetType)}>
                {Object.entries(TARGET_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <p className="text-sm text-ink-soft">{TARGET_HELP[type]}</p>

        {type === 'vercel_hook' && (
          <Field label="Deploy hook URL">
            {(id) => <Input id={id} className="font-mono text-[13px]" value={config.url ?? ''} onChange={set('url')} placeholder="https://api.vercel.com/v1/integrations/deploy/prj_…/…" />}
          </Field>
        )}

        {type === 'github_workflow' && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Owner">{(id) => <Input id={id} value={config.owner ?? ''} onChange={set('owner')} placeholder="your-org" />}</Field>
              <Field label="Repository">{(id) => <Input id={id} value={config.repo ?? ''} onChange={set('repo')} placeholder="mobile-app" />}</Field>
              <Field label="Workflow file">{(id) => <Input id={id} className="font-mono text-[13px]" value={config.workflow ?? ''} onChange={set('workflow')} />}</Field>
              <Field label="Branch">{(id) => <Input id={id} className="font-mono text-[13px]" value={config.ref ?? ''} onChange={set('ref')} />}</Field>
            </div>
            <Field label="Token variable" hint="Name of the env var on this i18n Hub deployment holding a GitHub token with Actions write access to the repo.">
              {(id) => <Input id={id} className="font-mono text-[13px]" value={config.tokenEnv ?? ''} onChange={set('tokenEnv')} />}
            </Field>
          </>
        )}

        {type === 'webhook' && (
          <>
            <Field label="URL" hint="For GitLab: https://gitlab.com/api/v4/projects/<id>/trigger/pipeline?token=<trigger token>&ref=main">
              {(id) => <Input id={id} className="font-mono text-[13px]" value={config.url ?? ''} onChange={set('url')} />}
            </Field>
            <Field label="Secret" hint="Optional. Sent as the X-I18n-Secret header so your endpoint can check the call came from here.">
              {(id) => <Input id={id} className="font-mono text-[13px]" value={config.secret ?? ''} onChange={set('secret')} />}
            </Field>
          </>
        )}

        <Checkbox checked={auto} onChange={setAuto}>
          Select by default when publishing
        </Checkbox>
      </form>
    </Dialog>
  )
}
