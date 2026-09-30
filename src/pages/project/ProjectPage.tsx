import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, LangTag, Spinner, cx } from '../../components/ui'
import { useToast } from '../../components/Toasts'
import { api, errorMessage } from '../../lib/api'
import { diffAgainstLive } from '../../lib/diff'
import { linkHandler } from '../../lib/router'
import type { KeyRow, ProjectDetail } from '../../lib/types'
import { DeploysTab } from './DeploysTab'
import { IntegrationTab } from './IntegrationTab'
import { PublishDialog } from './PublishDialog'
import { ReleasesTab } from './ReleasesTab'
import { SettingsTab } from './SettingsTab'
import { StringsTab } from './StringsTab'

const TABS = [
  { id: 'strings', label: 'Strings' },
  { id: 'releases', label: 'Releases' },
  { id: 'deploys', label: 'Deploys' },
  { id: 'integration', label: 'Integration' },
  { id: 'settings', label: 'Settings' },
] as const

export function ProjectPage({ slug, tab }: { slug: string; tab?: string }) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [releasesVersion, setReleasesVersion] = useState(0)
  const toast = useToast()
  const active = TABS.find((t) => t.id === tab)?.id ?? 'strings'

  const reload = useCallback(async () => {
    try {
      setDetail(await api<ProjectDetail>(`/projects/${encodeURIComponent(slug)}`))
    } catch (err) {
      if ((err as { status?: number }).status === 404) setMissing(true)
      else toast(errorMessage(err), 'error')
    }
  }, [slug, toast])

  useEffect(() => {
    reload()
  }, [reload])

  const setKeys = useCallback((update: (keys: KeyRow[]) => KeyRow[]) => {
    setDetail((d) => (d ? { ...d, keys: update(d.keys) } : d))
  }, [])

  const diff = useMemo(
    () => (detail ? diffAgainstLive(detail.keys, detail.project.languages, detail.live?.snapshot ?? null) : null),
    [detail],
  )

  if (missing) {
    return (
      <div className="mx-auto max-w-5xl px-5 py-16">
        <h1 className="text-xl font-semibold">There is no project called “{slug}”</h1>
        <a href="/" onClick={linkHandler('/')} className="mt-3 inline-block text-cobalt hover:underline">
          Back to projects
        </a>
      </div>
    )
  }
  if (!detail || !diff) {
    return (
      <div className="px-5 py-16 text-muted">
        <Spinner />
      </div>
    )
  }

  const { project } = detail
  const nextVersion = (project.latestVersion ?? 0) + 1

  return (
    <div className="flex flex-col">
      <div className="border-b border-line bg-surface">
        <div className="flex flex-wrap items-start justify-between gap-4 px-5 pt-6">
          <div className="min-w-0">
            <a href="/" onClick={linkHandler('/')} className="text-sm text-muted hover:text-ink">
              Projects
            </a>
            <h1 className="mt-0.5 text-2xl font-semibold tracking-tight">{project.name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted">
              <span className="font-mono">{project.slug}</span>
              <div className="flex gap-1">
                {project.languages.map((l) => (
                  <LangTag key={l} lang={l} base={l === project.baseLanguage} />
                ))}
              </div>
              <span>{project.currentVersion ? `v${project.currentVersion} is live` : 'Nothing published yet'}</span>
            </div>
          </div>
          <Button variant="primary" disabled={diff.total === 0 && detail.live !== null} onClick={() => setPublishing(true)}>
            {diff.total === 0 && detail.live !== null
              ? 'Live is up to date'
              : `Publish v${nextVersion}${diff.total ? ` (${diff.total} ${diff.total === 1 ? 'change' : 'changes'})` : ''}`}
          </Button>
        </div>
        <nav className="mt-5 flex gap-1 overflow-x-auto px-3" aria-label="Project sections">
          {TABS.map((t) => {
            const href = t.id === 'strings' ? `/p/${project.slug}` : `/p/${project.slug}/${t.id}`
            return (
              <a
                key={t.id}
                href={href}
                onClick={linkHandler(href)}
                aria-current={active === t.id ? 'page' : undefined}
                className={cx(
                  'relative px-3 pt-1 pb-3 text-sm whitespace-nowrap',
                  active === t.id
                    ? 'font-semibold text-ink after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-ink'
                    : 'text-muted hover:text-ink',
                )}
              >
                {t.label}
              </a>
            )
          })}
        </nav>
      </div>

      {active === 'strings' && <StringsTab detail={detail} diff={diff} setKeys={setKeys} reload={reload} />}
      {active === 'releases' && <ReleasesTab detail={detail} reload={reload} refreshToken={releasesVersion} />}
      {active === 'deploys' && <DeploysTab detail={detail} reload={reload} />}
      {active === 'integration' && <IntegrationTab project={project} />}
      {active === 'settings' && <SettingsTab project={project} reload={reload} />}

      {publishing && (
        <PublishDialog
          detail={detail}
          diff={diff}
          nextVersion={nextVersion}
          onClose={() => setPublishing(false)}
          onPublished={async () => {
            setPublishing(false)
            setReleasesVersion((v) => v + 1)
            await reload()
          }}
        />
      )}
    </div>
  )
}
