/**
 * i18n Hub's building blocks, rendered with Bodyguard's design system so the hub looks
 * like the dashboard. Pages keep this small, HTML-like API; the mapping to design-system
 * props lives here.
 */
import {
  Button as DsButton,
  Checkbox as DsCheckbox,
  Heading,
  Input as DsInput,
  Label,
  Modal,
  Spinner as DsSpinner,
  TextArea as DsTextArea,
  type ButtonKind,
  type SpinnerSize,
} from '@bodyguard-ai/design-system'
import {
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ')

/* ---------- buttons ---------- */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
const kinds: Record<Variant, ButtonKind> = {
  primary: 'primary',
  secondary: 'tertiary',
  ghost: 'tertiary-v2',
  danger: 'destructive',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  busy,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; busy?: boolean }) {
  return <DsButton {...props} kind={kinds[variant]} size={size} disabled={disabled || busy} loading={busy} />
}

export function Spinner({ size = 'sm', className }: { size?: SpinnerSize; className?: string }) {
  return <DsSpinner size={size} className={className} />
}

/* ---------- form controls ---------- */

// The design system wraps each control in a div: sizing and spacing classes go on that
// wrapper so they still lay the control out, everything else styles the control itself.
const LAYOUT = /^(?:[a-z0-9-]+:)*-?(?:w-|min-w-|max-w-|flex-|grow|shrink|basis-|self-|order-|col-|row-|m[trblxy]?-)/

function splitLayout(className = '') {
  const wrapper: string[] = []
  const control: string[] = []
  for (const c of className.split(/\s+/).filter(Boolean)) (LAYOUT.test(c) ? wrapper : control).push(c)
  return { wrapper: width(wrapper.join(' ')), control: control.join(' ') }
}

/** Full width unless the caller sets a width (no class merging library here). */
const width = (className?: string) => (/(^|\s)w-/.test(className ?? '') ? (className ?? '') : cx('w-full', className))

type TextValue = { value?: string; defaultValue?: string }

export function Input({ className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, keyof TextValue> & TextValue) {
  const { wrapper, control } = splitLayout(className)
  return <DsInput bordered {...props} className={control} containerClassName={wrapper} />
}

export function Textarea({
  className,
  rows,
  ...props
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'style' | keyof TextValue> & TextValue) {
  const { wrapper, control } = splitLayout(className)
  // Grows with its content from `rows` lines, like the dashboard's text areas.
  return <DsTextArea bordered {...props} minRows={rows} className={cx('min-h-0', control)} containerClassName={wrapper} />
}

/** A native select (it keeps <option> children) dressed like the design system's controls. */
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cx(
        'form-select block h-8 rounded-md border-0 bg-white py-0 pr-8 pl-3 text-sm text-zinc-900 shadow-xs ring-1 ring-zinc-300 focus:ring-2 focus:ring-primary-500 disabled:opacity-40 dark:bg-zinc-800 dark:text-white dark:ring-zinc-700',
        width(className),
      )}
    >
      {children}
    </select>
  )
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string
  hint?: ReactNode
  children: (id: string) => ReactNode
  className?: string
}) {
  const id = useId()
  return (
    <div className={cx('flex flex-col', className)}>
      <Label id={id}>{label}</Label>
      {children(id)}
      {hint && <p className="mt-1 text-xs leading-snug text-zinc-500 dark:text-zinc-400">{hint}</p>}
    </div>
  )
}

export function Checkbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  children: ReactNode
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-sm">
      <DsCheckbox checked={checked} onChange={onChange} className="mt-0.5" />
      <span>{children}</span>
    </label>
  )
}

/* ---------- dialog ---------- */

export function Dialog({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  return (
    <Modal isOpen onClose={onClose} size={wide ? '3xl' : 'lg'}>
      <Heading as="h2" size="md" className="px-6 pt-5">
        {title}
      </Heading>
      <div className="px-6 py-4">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t border-zinc-300 px-6 py-3 dark:border-zinc-700">{footer}</div>}
    </Modal>
  )
}

/* ---------- misc ---------- */

/** A key name (or another identifier) in running text: always monospace. */
export function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono">{children}</code>
}

/**
 * Server messages quote identifiers: `"inbox.count_one" already exists`, `Key "x" does not
 * exist`. Those quoted parts become <Code>, without the quotes.
 */
export function codeQuoted(text: string): ReactNode {
  const parts = text.split(/"([^"\n]+)"/)
  if (parts.length === 1) return text
  return parts.map((part, i) => (i % 2 ? <Code key={i}>{part}</Code> : part))
}

export function LangTag({ lang, base }: { lang: string; base?: boolean }) {
  return (
    <span
      className={cx(
        'inline-flex h-5 items-center rounded px-1.5 font-mono text-xs font-medium',
        base ? 'bg-primary-500 text-white' : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200',
      )}
      title={base ? 'Base language' : undefined}
    >
      {lang}
    </span>
  )
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' })

/** "fr" -> "French", "pt-BR" -> "Brazilian Portuguese"; falls back to the code itself. */
export function languageName(lang: string) {
  try {
    return languageNames.of(lang) ?? lang
  } catch {
    return lang
  }
}

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const copy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="overflow-hidden rounded-md bg-zinc-900 shadow-xs dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <span className="text-xs text-zinc-400">{label}</span>
        <button onClick={copy} className="rounded px-2 py-0.5 text-xs text-zinc-300 hover:bg-white/10 hover:text-white">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[13px] leading-relaxed text-zinc-100">
        <code>{code}</code>
      </pre>
    </div>
  )
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg bg-white px-6 py-8 shadow-xs dark:bg-zinc-800">
      <Heading as="h3" size="md">
        {title}
      </Heading>
      {children && <div className="max-w-prose text-sm text-zinc-600 dark:text-zinc-300">{children}</div>}
      {action}
    </div>
  )
}

export function formatDate(iso: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
}

export { cx }
