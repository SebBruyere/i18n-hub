/**
 * Plural keys, i18next style. Storage stays flat (`items_one`, `items_other`, ordinals as
 * `place_ordinal_two`), which is exactly what builds pull; this module recognises those
 * groups and says which forms each language needs. Shared by the API and the web app.
 */
export const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'] as const
export type PluralForm = (typeof PLURAL_FORMS)[number]
export type PluralType = 'cardinal' | 'ordinal'

const FORM_KEY = /^(.+?)_(ordinal_)?(zero|one|two|few|many|other)$/

export function pluralKey(base: string, type: PluralType, form: PluralForm): string {
  return type === 'ordinal' ? `${base}_ordinal_${form}` : `${base}_${form}`
}

export function parsePluralKey(key: string): { base: string; type: PluralType; form: PluralForm } | null {
  const match = FORM_KEY.exec(key)
  return match ? { base: match[1], type: match[2] ? 'ordinal' : 'cardinal', form: match[3] as PluralForm } : null
}

/* ---------- what each language needs ---------- */

// Everyday counts. CLDR also gives French, Spanish, Italian and Portuguese a "many" form
// that only millions use (1 000 000 de…); it isn't required, so it doesn't show as missing.
const SAMPLES = [...Array.from({ length: 1001 }, (_, i) => i), 0.5, 1.5, 2.5]

const cache = new Map<string, Map<PluralForm, number[]>>()

/** The forms a language uses for everyday numbers, in i18next order, each with the numbers that pick it. */
export function pluralExamples(lang: string, type: PluralType = 'cardinal'): Map<PluralForm, number[]> {
  const id = `${lang}:${type}`
  let forms = cache.get(id)
  if (!forms) {
    const found = new Map<PluralForm, number[]>()
    try {
      const rules = new Intl.PluralRules(lang, { type })
      for (const n of SAMPLES) {
        const form = rules.select(n) as PluralForm
        const list = found.get(form) ?? []
        list.push(n)
        found.set(form, list)
      }
    } catch {
      found.set('one', [1])
      found.set('other', [0, 2])
    }
    forms = new Map(PLURAL_FORMS.filter((f) => found.has(f)).map((f) => [f, found.get(f)!]))
    cache.set(id, forms)
  }
  return forms
}

/** The form a count of 0 falls back to when there's no zero text: one in French, other in English, many in Russian. */
export function zeroFallback(lang: string): PluralForm {
  try {
    return new Intl.PluralRules(lang).select(0) as PluralForm
  } catch {
    return 'other'
  }
}

export function pluralForms(lang: string, type: PluralType = 'cardinal'): PluralForm[] {
  return [...pluralExamples(lang, type).keys()]
}

/**
 * The forms a new plural key gets: every form any of the languages needs, always one + other,
 * and `zero` when asked. i18next reads key_zero for a count of 0 in every language (not only
 * those whose rules have a zero form), so "Aucun message" can differ from "1 message".
 */
export function formsForLanguages(languages: string[], type: PluralType = 'cardinal', zero = false): PluralForm[] {
  const needed = new Set<PluralForm>(['one', 'other'])
  if (zero && type === 'cardinal') needed.add('zero')
  for (const lang of languages) for (const form of pluralForms(lang, type)) needed.add(form)
  return PLURAL_FORMS.filter((f) => needed.has(f))
}

/* ---------- grouping ---------- */

export type KeyGroup<K> =
  | { kind: 'single'; key: string; row: K }
  | { kind: 'plural'; key: string; type: PluralType; forms: Partial<Record<PluralForm, K>> }

/**
 * Groups flat keys into plural keys: `base_other` plus at least one more form of the same
 * base. A lone `gender_other` stays an ordinary key. Keeps the input order (by first form).
 */
export function groupKeys<K extends { key: string }>(rows: K[]): KeyGroup<K>[] {
  const families = new Map<string, Partial<Record<PluralForm, K>>>()
  for (const row of rows) {
    const parsed = parsePluralKey(row.key)
    if (!parsed) continue
    const id = `${parsed.type}:${parsed.base}`
    const forms = families.get(id) ?? {}
    forms[parsed.form] = row
    families.set(id, forms)
  }
  const isGroup = (forms: Partial<Record<PluralForm, K>> | undefined) => !!forms?.other && Object.keys(forms).length > 1

  const out: KeyGroup<K>[] = []
  const emitted = new Set<string>()
  for (const row of rows) {
    const parsed = parsePluralKey(row.key)
    const id = parsed && `${parsed.type}:${parsed.base}`
    if (parsed && id && isGroup(families.get(id))) {
      if (emitted.has(id)) continue
      emitted.add(id)
      out.push({ kind: 'plural', key: parsed.base, type: parsed.type, forms: families.get(id)! })
    } else {
      out.push({ kind: 'single', key: row.key, row })
    }
  }
  return out
}
