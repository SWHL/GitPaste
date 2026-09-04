import assert from 'node:assert/strict'
import test from 'node:test'
import { updateOffsetRange } from '../src/range-tracking'

test('keeps a tracked range stable when edits occur after it', () => {
  assert.deepEqual(
    updateOffsetRange(
      { start: 10, end: 15 },
      [{ rangeOffset: 20, rangeLength: 0, text: 'later' }]
    ),
    { start: 10, end: 15 }
  )
})

test('moves a tracked range by edits before it', () => {
  assert.deepEqual(
    updateOffsetRange(
      { start: 10, end: 15 },
      [
        { rangeOffset: 2, rangeLength: 3, text: 'replacement' },
        { rangeOffset: 8, rangeLength: 0, text: '++' }
      ]
    ),
    { start: 20, end: 25 }
  )
})

test('uses right stickiness for insertion at the start boundary', () => {
  assert.deepEqual(
    updateOffsetRange(
      { start: 10, end: 10 },
      [{ rangeOffset: 10, rangeLength: 0, text: 'typed' }]
    ),
    { start: 15, end: 15 }
  )
  assert.deepEqual(
    updateOffsetRange(
      { start: 10, end: 15 },
      [{ rangeOffset: 10, rangeLength: 0, text: 'typed' }]
    ),
    { start: 15, end: 20 }
  )
})

test('uses left stickiness for insertion at the end boundary', () => {
  assert.deepEqual(
    updateOffsetRange(
      { start: 10, end: 15 },
      [{ rangeOffset: 15, rangeLength: 0, text: 'typed' }]
    ),
    { start: 10, end: 15 }
  )
})

test('invalidates a range when an edit overlaps its contents', () => {
  assert.equal(
    updateOffsetRange(
      { start: 10, end: 15 },
      [{ rangeOffset: 12, rangeLength: 1, text: '' }]
    ),
    undefined
  )
  assert.equal(
    updateOffsetRange(
      { start: 10, end: 15 },
      [{ rangeOffset: 5, rangeLength: 20, text: '' }]
    ),
    undefined
  )
})

test('invalidates an insertion point only when an edit crosses it', () => {
  assert.equal(
    updateOffsetRange(
      { start: 10, end: 10 },
      [{ rangeOffset: 8, rangeLength: 4, text: '' }]
    ),
    undefined
  )
  assert.deepEqual(
    updateOffsetRange(
      { start: 10, end: 10 },
      [{ rangeOffset: 10, rangeLength: 4, text: '' }]
    ),
    { start: 10, end: 10 }
  )
})
