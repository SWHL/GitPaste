export interface MarkdownImage {
  readonly start: number
  readonly end: number
  readonly alt: string
  readonly url: string
}

export function findMarkdownImageAtOffset(
  text: string,
  offset: number
): MarkdownImage | undefined {
  let start = text.lastIndexOf('![', offset)
  while (start >= 0) {
    const image = parseMarkdownImage(text, start)
    if (image && offset >= image.start && offset <= image.end) return image
    if (start === 0) break
    start = text.lastIndexOf('![', start - 1)
  }
  return undefined
}

function parseMarkdownImage(
  text: string,
  start: number
): MarkdownImage | undefined {
  const altEnd = findUnescaped(text, ']', start + 2)
  if (altEnd < 0 || text[altEnd + 1] !== '(') return undefined

  let cursor = altEnd + 2
  while (isWhitespace(text[cursor])) cursor += 1
  const angleWrapped = text[cursor] === '<'
  if (angleWrapped) cursor += 1
  const urlStart = cursor
  let nestedParens = 0
  while (cursor < text.length) {
    const character = text[cursor]
    if (character === '\\') {
      cursor += 2
      continue
    }
    if (angleWrapped) {
      if (character === '>') break
    } else {
      if (character === '(') nestedParens += 1
      if (character === ')') {
        if (nestedParens === 0) break
        nestedParens -= 1
      }
      if (isWhitespace(character) && nestedParens === 0) break
    }
    if (character === '\n' || character === '\r') return undefined
    cursor += 1
  }
  if (cursor === urlStart || cursor >= text.length) return undefined

  const urlEnd = cursor
  if (angleWrapped) {
    if (text[cursor] !== '>') return undefined
    cursor += 1
  }
  const closingParen = findLinkClosingParen(text, cursor)
  if (closingParen < 0) return undefined
  return {
    start,
    end: closingParen + 1,
    alt: unescapeMarkdown(text.slice(start + 2, altEnd)),
    url: unescapeMarkdown(text.slice(urlStart, urlEnd))
  }
}

function findUnescaped(text: string, target: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1
      continue
    }
    if (text[index] === target) return index
    if (text[index] === '\n' || text[index] === '\r') return -1
  }
  return -1
}

function findLinkClosingParen(text: string, start: number): number {
  let quote = ''
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '\n' || character === '\r') return -1
    if (quote) {
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === ')') return index
  }
  return -1
}

function isWhitespace(value: string | undefined): boolean {
  return value === ' ' || value === '\t'
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([\\`*{}\[\]()#+\-.!_<>])/g, '$1')
}
