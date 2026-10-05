import { Toaster, ToastType, useToast as useDsToast } from '@bodyguard-ai/design-system'
import { createContext, useCallback, useContext, type ReactNode } from 'react'
import { codeQuoted } from './ui'

type Kind = 'success' | 'error'

type Push = (message: ReactNode, kind?: Kind) => void

const ToastContext = createContext<Push>(() => {})

/**
 * The design system's toasts behind i18n Hub's `toast(message, kind)`. Errors stay up longer.
 * Key names are monospace: pass <Code> in a message, and quoted names in server errors
 * (`"inbox.count_one" already exists`) are switched over here.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const success = useDsToast(undefined, { duration: 3500 }).createToast
  const error = useDsToast(undefined, { duration: 7000 }).createToast
  const push = useCallback<Push>(
    (raw, kind = 'success') => {
      // The design system types `message` as a string; `description` takes any content, so it
      // carries the text, styled like a message.
      const description = (
        <span className="font-medium text-zinc-900 dark:text-white">{typeof raw === 'string' ? codeQuoted(raw) : raw}</span>
      )
      if (kind === 'error') error({ type: ToastType.Error, description })
      else success({ type: ToastType.Confirmation, description })
    },
    [success, error],
  )
  return (
    <ToastContext.Provider value={push}>
      {children}
      <Toaster />
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)
