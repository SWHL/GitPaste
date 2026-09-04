export interface OffsetRange {
  readonly start: number
  readonly end: number
}

export interface OffsetChange {
  readonly rangeOffset: number
  readonly rangeLength: number
  readonly text: string
}

export function updateOffsetRange(
  range: OffsetRange,
  changes: readonly OffsetChange[]
): OffsetRange | undefined {
  let offsetDelta = 0

  for (const change of changes) {
    const changeStart = change.rangeOffset
    const changeEnd = changeStart + change.rangeLength

    // The start boundary is right-sticky, while the end boundary is left-sticky.
    if (changeEnd <= range.start) {
      offsetDelta += change.text.length - change.rangeLength
      continue
    }
    if (changeStart >= range.end) continue

    return undefined
  }

  return {
    start: range.start + offsetDelta,
    end: range.end + offsetDelta
  }
}
