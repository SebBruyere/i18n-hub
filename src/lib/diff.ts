import type { KeyRow, Snapshot } from './types'

export interface Diff {
  /** "key\u0000lang" for every cell whose draft value differs from the live release */
  changedCells: Set<string>
  added: string[]
  changed: string[]
  removed: string[]
  total: number
}

export const cellId = (key: string, lang: string) => `${key}\u0000${lang}`

export function diffAgainstLive(keys: KeyRow[], languages: string[], live: Snapshot | null): Diff {
  const snap = live ?? {}
  const liveKeys = new Set<string>()
  for (const lang of Object.keys(snap)) for (const key of Object.keys(snap[lang])) liveKeys.add(key)

  const changedCells = new Set<string>()
  const added: string[] = []
  const changed: string[] = []
  const draftKeys = new Set<string>()

  for (const row of keys) {
    draftKeys.add(row.key)
    let rowChanged = false
    let hasValue = false
    for (const lang of languages) {
      const draft = row.values[lang]
      if (draft !== undefined) hasValue = true
      if (draft !== snap[lang]?.[row.key]) {
        changedCells.add(cellId(row.key, lang))
        rowChanged = true
      }
    }
    if (!rowChanged) continue
    if (!liveKeys.has(row.key)) {
      if (hasValue) added.push(row.key)
    } else changed.push(row.key)
  }

  const removed = [...liveKeys].filter((k) => !draftKeys.has(k)).sort()
  return { changedCells, added, changed, removed, total: added.length + changed.length + removed.length }
}
