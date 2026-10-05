/**
 * What the Strings tab shows: ordinary keys, and plural keys made of their forms
 * (items_one + items_other…), with each language asked only for the forms it uses.
 */
import {
  PLURAL_FORMS,
  groupKeys,
  parsePluralKey,
  pluralExamples,
  pluralForms,
  pluralKey,
  zeroFallback,
  type KeyGroup,
  type PluralForm,
  type PluralType,
} from '../../api/_lib/plurals'
import { cellId, type Diff } from './diff'
import type { KeyRow } from './types'

export type Group = KeyGroup<KeyRow>
export type PluralGroup = Extract<Group, { kind: 'plural' }>
export { PLURAL_FORMS, groupKeys, parsePluralKey, pluralForms, pluralKey, zeroFallback }
export type { PluralForm, PluralType }

const rowsOf = (g: Group): KeyRow[] => (g.kind === 'single' ? [g.row] : Object.values(g.forms).filter((r): r is KeyRow => !!r))

/** The flat keys behind a group, as stored and pulled. */
export const groupFlatKeys = (g: Group) => rowsOf(g).map((r) => r.key)

export const groupDescription = (g: Group) =>
  g.kind === 'single' ? g.row.description : (g.forms.other?.description ?? rowsOf(g).find((r) => r.description)?.description ?? '')

/**
 * required: the language's rules use it. optional: zero, which i18next reads for a count of 0
 * in every language (French "Aucun message" next to "1 message"), falling back to the
 * language's own form when empty. unused: neither, but it has text.
 */
export type FormStatus = 'required' | 'optional' | 'unused'

export function formStatus(g: PluralGroup, lang: string, form: PluralForm): FormStatus {
  if (pluralForms(lang, g.type).includes(form)) return 'required'
  return form === 'zero' && g.type === 'cardinal' ? 'optional' : 'unused'
}

/**
 * The forms a language needs, any it has text for (so nothing is hidden), and zero when
 * someone just asked for one in this language (`withZero`). A zero text is per language:
 * French can have "Aucun message" while English keeps "0 messages".
 */
export function shownForms(g: PluralGroup, lang: string, withZero = false): PluralForm[] {
  const needed = new Set(pluralForms(lang, g.type))
  return PLURAL_FORMS.filter(
    (f) => needed.has(f) || g.forms[f]?.values[lang] !== undefined || (f === 'zero' && withZero && g.type === 'cardinal'),
  )
}

/** Whether the language can be given a separate text for 0 its rules don't ask for. */
export const canAddZero = (g: PluralGroup, lang: string) =>
  g.type === 'cardinal' && g.forms.zero?.values[lang] === undefined && !pluralForms(lang, 'cardinal').includes('zero')

export function isMissing(g: Group, lang: string): boolean {
  if (g.kind === 'single') return g.row.values[lang] === undefined
  return pluralForms(lang, g.type).some((f) => g.forms[f]?.values[lang] === undefined)
}

export const isChanged = (g: Group, langs: string[], diff: Diff) =>
  rowsOf(g).some((r) => langs.some((l) => diff.changedCells.has(cellId(r.key, l))))

export function matchesSearch(g: Group, query: string): boolean {
  if (g.key.toLowerCase().includes(query)) return true
  return rowsOf(g).some(
    (r) => r.description.toLowerCase().includes(query) || Object.values(r.values).some((v) => v.toLowerCase().includes(query)),
  )
}

/** A key name that is already used, as a key or as the name of a plural key. */
export const nameTaken = (keys: KeyRow[], name: string) =>
  keys.some((k) => k.key === name || parsePluralKey(k.key)?.base === name)

/**
 * "1, 21, 31…": the counts that pick this form, so translators know which one they're writing.
 * `zeroHasText`: the language has a zero text, which takes 0 away from its usual form.
 */
export function formExamples(lang: string, type: PluralType, form: PluralForm, zeroHasText = false): string {
  const numbers = (pluralExamples(lang, type).get(form) ?? []).filter((n) => !(zeroHasText && form !== 'zero' && n === 0))
  const whole = numbers.filter(Number.isInteger)
  const list = whole.length ? whole : numbers
  return list.slice(0, 3).join(', ') + (list.length > 3 ? '…' : '')
}
