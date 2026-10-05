import { useEffect, useState } from 'react'
import { api, setUnauthorizedHandler } from './lib/api'
import { usePath } from './lib/router'
import { Login } from './pages/Login'
import { ProjectList } from './pages/ProjectList'
import { ProjectPage } from './pages/project/ProjectPage'
import { Sidebar } from './components/Sidebar'
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
      <div className="grid min-h-screen place-items-center">
        <Spinner size="md" />
      </div>
    )
  }
  if (auth === 'signed-out') return <Login onSignedIn={() => setAuth('signed-in')} />

  const match = /^\/p\/([^/]+)(?:\/([^/]+))?/.exec(path)
  const slug = match ? decodeURIComponent(match[1]) : undefined

  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' })
    setAuth('signed-out')
  }

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <Sidebar slug={slug} onSignOut={signOut} />
      {/* On large screens the page itself never scrolls: main does, or the Strings list inside it. */}
      <main className="flex min-w-0 flex-1 flex-col lg:h-dvh lg:overflow-y-auto">
        {slug ? <ProjectPage key={slug} slug={slug} tab={match?.[2]} /> : <ProjectList />}
      </main>
    </div>
  )
}
