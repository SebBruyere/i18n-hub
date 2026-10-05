import { useCallback, useEffect, useState } from 'react'

/**
 * Light or dark, like the dashboard: the OS setting decides until someone picks one with
 * the switch, then their choice sticks in this browser. index.html applies the same rule
 * before the first paint, so a reload in dark mode doesn't flash white.
 */
export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'i18n-hub:theme'
const darkQuery = () => matchMedia('(prefers-color-scheme: dark)')

function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

const systemTheme = (): Theme => (darkQuery().matches ? 'dark' : 'light')

function applyTheme(theme: Theme) {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.style.colorScheme = theme
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() => storedTheme() ?? systemTheme())

  useEffect(() => applyTheme(theme), [theme])

  // Follow the OS while nobody has picked a theme here.
  useEffect(() => {
    const query = darkQuery()
    const onChange = () => !storedTheme() && setThemeState(systemTheme())
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Private mode or blocked storage: the switch still works for this visit.
    }
    setThemeState(next)
  }, [])

  return [theme, setTheme]
}
