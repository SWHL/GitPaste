import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import * as vscode from 'vscode'
import { TrackedDocumentRange } from '../src/tracked-document-range'
import { FakeTextDocument } from './support/fake-document'

type MockVscode = {
  __documents: Map<string, FakeTextDocument>
  __changeListeners: Array<(event: unknown) => void>
  __emitChange: (document: FakeTextDocument, changes: unknown[]) => void
  __emitClose: (document: FakeTextDocument) => void
  __reset: () => void
} & typeof vscode

const mockVscode = vscode as unknown as MockVscode

beforeEach(() => {
  mockVscode.__reset()
})

function uri(path: string): vscode.Uri {
  return vscode.Uri.parse(`file://${path}`)
}

function rangeFor(
  doc: FakeTextDocument,
  start: number,
  end: number,
): TrackedDocumentRange {
  return new TrackedDocumentRange(
    doc as any,
    new vscode.Range(doc.positionAt(start), doc.positionAt(end)),
  )
}

test('reports the initial range as valid and current', () => {
  const doc = new FakeTextDocument(uri('/a.md'), 'markdown', 'hello world')
  const range = rangeFor(doc, 0, 5)
  assert.equal(range.isValid, true)
  const current = range.current
  assert.ok(current)
  assert.equal(doc.offsetAt(current.start), 0)
  assert.equal(doc.offsetAt(current.end), 5)
})

test('shifts offsets when text is inserted before the range', () => {
  const doc = new FakeTextDocument(uri('/a.md'), 'markdown', 'hello world')
  const range = rangeFor(doc, 6, 11) // 'world'
  doc._setText('XYZhello world')
  mockVscode.__emitChange(doc, [{ rangeOffset: 0, rangeLength: 0, text: 'XYZ' }])
  const current = range.current
  assert.ok(current)
  assert.equal(doc.offsetAt(current.start), 9) // 6 + 3
  assert.equal(doc.offsetAt(current.end), 14) // 11 + 3
})

test('ignores edits that occur after the tracked range', () => {
  const doc = new FakeTextDocument(uri('/a.md'), 'markdown', 'hello world')
  const range = rangeFor(doc, 0, 5)
  doc._setText('hello world!!!')
  mockVscode.__emitChange(doc, [{ rangeOffset: 11, rangeLength: 0, text: '!!!' }])
  const current = range.current
  assert.ok(current)
  assert.equal(doc.offsetAt(current.start), 0)
  assert.equal(doc.offsetAt(current.end), 5)
})

test('invalidates when an edit overlaps the tracked range', () => {
  const doc = new FakeTextDocument(uri('/a.md'), 'markdown', 'hello world')
  const range = rangeFor(doc, 0, 5)
  let invalidated = false
  range.onDidInvalidate(() => {
    invalidated = true
  })
  doc._setText('XYZ world')
  mockVscode.__emitChange(doc, [{ rangeOffset: 0, rangeLength: 5, text: 'XYZ' }])
  assert.equal(range.isValid, false)
  assert.equal(range.current, undefined)
  assert.equal(invalidated, true)
})

test('invalidates when the document is closed', () => {
  const doc = new FakeTextDocument(uri('/a.md'), 'markdown', 'hello world')
  const range = rangeFor(doc, 0, 5)
  let invalidated = false
  range.onDidInvalidate(() => {
    invalidated = true
  })
  mockVscode.__emitClose(doc)
  assert.equal(range.isValid, false)
  assert.equal(range.current, undefined)
  assert.equal(invalidated, true)
})

test('dispose stops tracking and cannot be resurrected by later edits', () => {
  const doc = new FakeTextDocument(uri('/a.md'), 'markdown', 'hello world')
  const range = rangeFor(doc, 0, 5)
  range.dispose()
  assert.equal(range.isValid, false)
  doc._setText('XYZhello world')
  mockVscode.__emitChange(doc, [{ rangeOffset: 0, rangeLength: 0, text: 'XYZ' }])
  assert.equal(range.current, undefined)
})

test('resolve returns the current range then disposes the tracker', () => {
  const doc = new FakeTextDocument(uri('/a.md'), 'markdown', 'hello world')
  const range = rangeFor(doc, 0, 5)
  const resolved = range.resolve()
  assert.ok(resolved)
  assert.equal(doc.offsetAt(resolved.start), 0)
  assert.equal(doc.offsetAt(resolved.end), 5)
  assert.equal(range.isValid, false)
})
