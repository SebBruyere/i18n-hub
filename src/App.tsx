import { useEffect, useState } from 'react'
import { api, setUnauthorizedHandler } from './lib/api'
import { linkHandler, usePath } from './lib/router'
import { Login } from './pages/Login'
import { ProjectList } from './pages/ProjectList'
import { ProjectPage } from './pages/project/ProjectPage'
import { Spinner } from './components/ui'

type AuthState = 'checking' | 'signed-in' | 'signed-out'

export default function App() {
  const [auth, setAuth] = useState<AuthState>('checking')
  const path = usePath()

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth('signed-out'))
    api<{ authenticated: boolean }>('/auth/me')
      .then((r) => setAuth(r.authenticated ? 'signed-in' : 'signed-out'))
      .catch(() => setAuth('signed-out'))
  }, [])

  if (auth === 'checking') {
    return (
      <div className="grid min-h-screen place-items-center text-muted">
        <Spinner />
      </div>
    )
  }
  if (auth === 'signed-out') return <Login onSignedIn={() => setAuth('signed-in')} />

  const match = /^\/p\/([^/]+)(?:\/([^/]+))?/.exec(path)

  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' })
    setAuth('signed-out')
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
        <div className="flex h-14 items-center justify-between px-5">
          <a href="/" onClick={linkHandler('/')} className="flex items-center gap-2.5 font-semibold tracking-tight">
            <img src="/favicon.svg" alt="" className="size-6" />
            i18n Hub
          </a>
          <button onClick={signOut} className="text-sm text-muted hover:text-ink">
            Sign out
          </button>
        </div>
      </header>
      <main className="flex-1">
        {match ? <ProjectPage key={match[1]} slug={decodeURIComponent(match[1])} tab={match[2]} /> : <ProjectList />}
      </main>
    </div>
  )
}
