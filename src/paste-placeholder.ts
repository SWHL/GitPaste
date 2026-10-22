/**
 * Pure helpers for locating GitPaste upload placeholders inside document text.
 *
 * Detection is intentionally text-based (not change-based): it never depends on
 * the exact `contentChange` offset/length/text reported by VS Code. That makes
 * placeholder application tolerant of merged/coalesced edits and post-paste
 * auto-formatting, which would otherwise prevent the upload from starting and
 * leave the placeholder stranded in the document.
 */

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n')
}

export function placeholderForIndex(
  placeholder: string,
  index: number,
  count: number,
): string {
  if (count === 1) return placeholder
  return placeholder.split('\n')[index]
}

/**
 * Locates a GitPaste upload placeholder within the full document text and
 * returns the offset/length of every per-image segment.
 *
 * Detection works by finding each per-image piece in document order. Because a
 * piece never contains a newline, this is immune to CRLF conversion applied by
 * the editor and to edits that merge or reformat the insertion: the upload is
 * triggered as soon as the whole placeholder is present anywhere in the
 * document, regardless of how that insertion was delivered.
 *
 * Returns `undefined` when the placeholder (or one of its pieces) has not been
 * inserted yet, so callers can keep waiting for the next change event.
 */
export function findPlaceholderRanges(
  fullText: string,
  placeholder: string,
  expectedCount: number,
): { offset: number; length: number }[] | undefined {
  const offsets: number[] = []
  let searchFrom = 0
  for (let index = 0; index < expectedCount; index += 1) {
    const piece = placeholderForIndex(placeholder, index, expectedCount)
    const found = fullText.indexOf(piece, searchFrom)
    if (found < 0) return undefined
    offsets.push(found)
    searchFrom = found + piece.length
  }
  return offsets.map((offset, index) => ({
    offset,
    length: placeholderForIndex(placeholder, index, expectedCount).length,
  }))
}
