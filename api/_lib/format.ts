/**
 * Shared by the API and the web app (no Node-only imports here).
 * Storage is always flat: { "home.title": "Hello" }. Nesting is an output format.
 */
export type Flat = Record<string, string>
export type Snapshot = Record<string, Flat> // language -> key -> value
export type Nested = { [key: string]: string | Nested }

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function flatten(input: unknown, prefix = '', out: Flat = {}): Flat {
  if (input === null || input === undefined) return out
  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    if (prefix) out[prefix] = String(input)
    return out
  }
  if (Array.isArray(input)) {
    input.forEach((v, i) => flatten(v, prefix ? `${prefix}.${i}` : String(i), out))
    return out
  }
  if (typeof input === 'object') {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out)
    }
  }
  return out
}

export function sortFlat(flat: Flat): Flat {
  const out: Flat = {}
  for (const key of Object.keys(flat).sort(byCodePoint)) out[key] = flat[key]
  return out
}

/** Builds { home: { title } } from { "home.title" }. Throws on "a" + "a.b" collisions. */
export function nest(flat: Flat): Nested {
  const root: Nested = {}
  for (const key of Object.keys(flat).sort(byCodePoint)) {
    const parts = key.split('.')
    let node: Nested = root
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      const next = node[part]
      if (typeof next === 'string') {
        throw new Error(`Cannot nest "${key}": "${parts.slice(0, i + 1).join('.')}" is already a string`)
      }
      node = (next ?? (node[part] = {})) as Nested
    }
    const leaf = parts[parts.length - 1]
    if (typeof node[leaf] === 'object') {
      throw new Error(`Cannot nest "${key}": it is also used as a group of other keys`)
    }
    node[leaf] = flat[key]
  }
  return root
}
