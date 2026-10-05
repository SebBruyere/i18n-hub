import { Button as DsButton, Select, Tooltip } from '@bodyguard-ai/design-system'
import { faArrowRightFromBracket, faGrid2, faMoon, faSun } from '@fortawesome/pro-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { linkHandler, navigate } from '../lib/router'
import { useTheme } from '../lib/theme'
import type { Project } from '../lib/types'
import { cx } from './ui'

/**
 * The app's frame, like the dashboard's sidebar: logo, All projects, the project switcher,
 * and the theme switch and sign out pinned to the bottom. Below `lg` it folds into a top bar.
 */
export function Sidebar({ slug, onSignOut }: { slug?: string; onSignOut: () => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [theme, setTheme] = useTheme()

  // Reloaded on navigation and whenever the list opens, so projects created or renamed
  // elsewhere show up (the dashboard's workspace picker does the same).
  const load = useCallback(() => {
    api<{ projects: Project[] }>('/projects')
      .then((r) => setProjects(r.projects))
      .catch(() => {})
  }, [])
  useEffect(load, [load, slug])

  const nextTheme = theme === 'dark' ? 'light' : 'dark'

  return (
    <aside className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-line bg-surface px-4 shadow-lg border-r lg:h-screen lg:w-64 lg:flex-col lg:items-stretch lg:gap-0 lg:px-0">
      <a href="/" onClick={linkHandler('/')} className="group flex shrink-0 items-center gap-3 rounded lg:h-16 lg:px-4">
        <img src="/bodyguard-logo.svg" alt="Bodyguard" className="size-8 transition-transform group-hover:scale-105" />
        <span className="hidden text-base font-medium text-ink sm:inline">i18n Hub</span>
      </a>

      <nav className="hidden lg:block lg:px-3 lg:pt-2" aria-label="Main">
        <a
          href="/"
          onClick={linkHandler('/')}
          aria-current={slug ? undefined : 'page'}
          className={cx(
            'flex items-center gap-2.5 rounded px-2 py-2 text-sm transition-colors',
            slug ? 'text-muted hover:text-primary-500' : 'text-primary-500',
          )}
        >
          <FontAwesomeIcon icon={faGrid2} className="size-4" />
          All projects
        </a>
      </nav>

      <div className="min-w-0 flex-1 lg:flex-none lg:px-3 lg:pt-2">
        <Select<string>
          searchable
          doubleChevron
          containWidth
          kind="tertiary"
          placement="bottom-start"
          loading={projects === null}
          options={(projects ?? []).map((p) => ({ label: p.name, value: p.slug }))}
          value={slug}
          placeholder="Choose a project"
          searchPlaceholder="Search projects"
          noOptionsComponent={<div className="text-sm">No projects</div>}
          containerClassName="w-full"
          onOpen={load}
          onChange={(next) => next !== slug && navigate(`/p/${next}`)}
        />
      </div>

      <div className="flex shrink-0 items-center gap-1 lg:mt-auto lg:border-t lg:border-line lg:p-3">
        <DsButton kind="tertiary-v2" onClick={onSignOut} className="lg:flex-1 lg:justify-start">
          <FontAwesomeIcon icon={faArrowRightFromBracket} className="size-4" />
          <span className="hidden sm:inline">Sign out</span>
        </DsButton>
        <Tooltip content={`Switch to ${nextTheme} mode`} placement="top">
          <DsButton square kind="tertiary-v2" aria-label={`Switch to ${nextTheme} mode`} onClick={() => setTheme(nextTheme)}>
            <FontAwesomeIcon icon={theme === 'dark' ? faSun : faMoon} className="size-4" />
          </DsButton>
        </Tooltip>
      </div>
    </aside>
  )
}
