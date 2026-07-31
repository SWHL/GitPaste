import assert from 'node:assert/strict'
import test from 'node:test'
import { findMarkdownImageAtOffset } from '../src/markdown-image'

test('finds a Markdown image containing the cursor', () => {
  const text = 'Before ![old image](https://example.com/old.png "title") after'
  assert.deepEqual(findMarkdownImageAtOffset(text, text.indexOf('old.png')), {
    start: 7,
    end: 56,
    alt: 'old image',
    url: 'https://example.com/old.png'
  })
})

test('supports angle-wrapped URLs and ignores links away from the cursor', () => {
  const text = '![one](one.png) text ![two](<two image.png>)'
  assert.equal(findMarkdownImageAtOffset(text, 18), undefined)
  assert.equal(findMarkdownImageAtOffset(text, 35)?.url, 'two image.png')
})

test('supports balanced parentheses in image URLs', () => {
  const text = '![chart](https://example.com/chart_(1).png)'
  assert.equal(findMarkdownImageAtOffset(text, 20)?.url, 'https://example.com/chart_(1).png')
})

test('returns the exact replacement range without adjacent text', () => {
  const text = 'prefix ![old](old.png) suffix'
  const image = findMarkdownImageAtOffset(text, text.indexOf('old.png'))
  assert(image)
  assert.equal(text.slice(image.start, image.end), '![old](old.png)')
})

test('ignores malformed and reference-style images', () => {
  assert.equal(findMarkdownImageAtOffset('![old][image-id]', 4), undefined)
  assert.equal(findMarkdownImageAtOffset('![old](unterminated', 8), undefined)
})
