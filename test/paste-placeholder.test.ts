import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findPlaceholderRanges,
  normalizeLineEndings,
  placeholderForIndex,
} from '../src/paste-placeholder'

const single = '![Uploading cat.png...]()'

function multi(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `![Uploading img${i}.png...]()`,
  ).join('\n')
}

test('finds a single placeholder as one contiguous range', () => {
  const text = `# Notes\n\n${single}\n\nMore text.`
  const ranges = findPlaceholderRanges(text, single, 1)
  assert.deepEqual(ranges, [
    { offset: text.indexOf(single), length: single.length },
  ])
})

test('finds each per-image segment of a multi-image placeholder', () => {
  const placeholder = multi(3)
  const text = `Intro\n\n${placeholder}\nOutro`
  const ranges = findPlaceholderRanges(text, placeholder, 3)
  assert.equal(ranges?.length, 3)
  // Each range must cover exactly one placeholder piece in order.
  let cursor = text.indexOf('![Uploading img0')
  for (let i = 0; i < 3; i += 1) {
    const piece = placeholderForIndex(placeholder, i, 3)
    assert.equal(ranges?.[i].offset, cursor)
    assert.equal(ranges?.[i].length, piece.length)
    cursor += piece.length + 1 // skip the newline separator
  }
})

test('returns undefined when the placeholder is not present yet', () => {
  assert.equal(
    findPlaceholderRanges('no placeholder here', single, 1),
    undefined,
  )
})

test('returns undefined when only some pieces of a multi-image placeholder exist', () => {
  const placeholder = multi(3)
  const partial = placeholder.split('\n').slice(0, 2).join('\n')
  const text = `Intro\n\n${partial}\nOutro`
  assert.equal(findPlaceholderRanges(text, placeholder, 3), undefined)
})

test('locates pieces even when the document uses CRLF line endings', () => {
  const placeholder = multi(2)
  // Editor converts the placeholder newlines to CRLF on insert.
  const text = `Intro\r\n\r\n${placeholder.replace(/\n/g, '\r\n')}\r\nOutro`
  const ranges = findPlaceholderRanges(text, placeholder, 2)
  assert.equal(ranges?.length, 2)
  assert.equal(
    text.slice(ranges?.[0].offset, ranges?.[0].offset + ranges?.[0].length),
    placeholderForIndex(placeholder, 0, 2),
  )
  assert.equal(
    text.slice(ranges?.[1].offset, ranges?.[1].offset + ranges?.[1].length),
    placeholderForIndex(placeholder, 1, 2),
  )
})

test('normalizeLineEndings collapses CRLF to LF', () => {
  assert.equal(normalizeLineEndings('a\r\nb\r\nc'), 'a\nb\nc')
  assert.equal(normalizeLineEndings('a\nb'), 'a\nb')
})

test('placeholderForIndex returns the whole placeholder for a single image', () => {
  assert.equal(placeholderForIndex(single, 0, 1), single)
})

test('placeholderForIndex splits a multi-image placeholder by newline', () => {
  const placeholder = multi(2)
  assert.equal(
    placeholderForIndex(placeholder, 0, 2),
    '![Uploading img0.png...]()',
  )
  assert.equal(
    placeholderForIndex(placeholder, 1, 2),
    '![Uploading img1.png...]()',
  )
})
