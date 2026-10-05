/**
 * The parts of a string a translation has to carry over untouched, which Lokalise highlights
 * too: i18next interpolation ({{name}}, {{- html}}, {{count, number}}) and markup tags
 * (<b>, </0>, <br/>, <a href="…">) used by Trans components and HTML strings.
 */
const TOKEN = /\{\{[^{}]+\}\}|<\/?[A-Za-z0-9][\w.:-]*(?:\s[^<>]*)?\/?>/g

export type TokenKind = 'placeholder' | 'tag'
export type Segment = { text: string; kind?: TokenKind }

/** A token's delimiters and what they wrap: "{{" "count" "}}", "</" "b" ">", "<" "br " "/>". */
export function tokenParts(token: string): [open: string, inner: string, close: string] {
  const match = /^(\{\{|<\/?)([\s\S]*?)(\}\}|\/?>)$/.exec(token)
  return match ? [match[1], match[2], match[3]] : ['', token, '']
}

/** Splits a string into plain text and tokens, in order; joining every `text` gives the string back. */
export function splitTokens(text: string): Segment[] {
  const parts: Segment[] = []
  let last = 0
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) })
    parts.push({ text: match[0], kind: match[0].startsWith('{{') ? 'placeholder' : 'tag' })
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts
}
