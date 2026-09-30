import { useState, type FormEvent } from 'react'
import { Button, Field, Input } from '../components/ui'
import { api, errorMessage } from '../lib/api'

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api('/auth/login', { method: 'POST', body: { password } })
      onSignedIn()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-9" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">i18n Hub</h1>
            <p className="text-sm text-muted">One source of truth for every app’s strings.</p>
          </div>
        </div>
        <Field label="Team password">
          {(id) => (
            <Input id={id} type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          )}
        </Field>
        {error && <p className="mt-2 text-sm text-rust">{error}</p>}
        <Button type="submit" variant="primary" busy={busy} disabled={!password} className="mt-5 w-full">
          Sign in
        </Button>
      </form>
    </div>
  )
}
