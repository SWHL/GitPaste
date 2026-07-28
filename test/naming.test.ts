import assert from 'node:assert/strict'
import test from 'node:test'
import {
  encodeRepoPath,
  formatUploadFileName,
  interpolate,
  joinRepoPath,
  normalizeRepoPath,
  sanitizeSegment,
  splitFileName
} from '../src/naming'

test('formats a deterministic upload filename', () => {
  const actual = formatUploadFileName(
    '${yyyy}${MM}${dd}-${document}-${name}-${random}${extName}',
    'Screen Shot.png',
    'image/png',
    'notes.md',
    new Date(2026, 6, 27, 9, 5, 4),
    'a1b2c3d4'
  )
  assert.equal(
    actual,
    '20260727-notes.md-Screen-Shot-a1b2c3d4.png'
  )
})

test('adds an extension based on the mime type', () => {
  const actual = formatUploadFileName(
    '${name}-${random}',
    'pasted-image',
    'image/webp',
    'readme',
    new Date(0),
    '12345678'
  )
  assert.equal(actual, 'pasted-image-12345678.webp')
})

test('sanitizes unsafe path characters without discarding unicode', () => {
  assert.equal(sanitizeSegment('设计稿 / final?.png'), '设计稿-final-.png')
})

test('normalizes and joins repository paths', () => {
  assert.equal(joinRepoPath('/images/', './2026', 'cover.png'), 'images/2026/cover.png')
  assert.throws(() => normalizeRepoPath('images/../secret.png'), /cannot contain/)
})

test('encodes repository paths one segment at a time', () => {
  assert.equal(
    encodeRepoPath('images/设计 稿.png'),
    'images/%E8%AE%BE%E8%AE%A1%20%E7%A8%BF.png'
  )
})

test('splits filenames and leaves unknown template variables intact', () => {
  assert.deepEqual(splitFileName('folder/photo.final.JPG?raw=1'), {
    name: 'photo.final',
    extName: '.jpg'
  })
  assert.equal(interpolate('${known}-${future}', { known: 'yes' }), 'yes-${future}')
})
