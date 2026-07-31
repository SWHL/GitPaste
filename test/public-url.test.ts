import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPublicUrl,
  formatOutput,
  parseRepository,
  remotePathFromPublicUrl
} from '../src/public-url'

test('parses owner/repository values', () => {
  assert.deepEqual(parseRepository('octocat/images'), {
    owner: 'octocat',
    repository: 'images'
  })
  assert.throws(() => parseRepository('octocat'), /owner\/repository/)
})

test('builds a public CDN URL with encoded image paths', () => {
  const actual = buildPublicUrl(
    'https://cdn.jsdelivr.net/gh/${owner}/${repository}@${branch}/${path}',
    'octocat/images',
    'main',
    'uploads/设计 稿.png'
  )
  assert.equal(
    actual,
    'https://cdn.jsdelivr.net/gh/octocat/images@main/uploads/%E8%AE%BE%E8%AE%A1%20%E7%A8%BF.png'
  )
})

test('uses the GitHub download URL when the custom template is empty', () => {
  assert.equal(
    buildPublicUrl('', 'octocat/images', 'main', 'image.png', 'https://raw.example/image.png'),
    'https://raw.example/image.png'
  )
})

test('formats Markdown output', () => {
  assert.equal(
    formatOutput('![${originalName}](${url})', 'uploaded', 'diagram', 'https://example/image.png'),
    '![diagram](https://example/image.png)'
  )
})

test('formats Markdown output without an image name', () => {
  assert.equal(
    formatOutput(
      '![${uploadedName}](${url})',
      'uploaded',
      'diagram',
      'https://example/image.png',
      false
    ),
    '![](https://example/image.png)'
  )
})

test('maps default and custom public URLs back to repository paths', () => {
  assert.equal(
    remotePathFromPublicUrl(
      '',
      'octocat/images',
      'main',
      'https://raw.githubusercontent.com/octocat/images/main/uploads/%E8%AE%BE%E8%AE%A1.png'
    ),
    'uploads/设计.png'
  )
  assert.equal(
    remotePathFromPublicUrl(
      'https://cdn.example/${owner}/${path}?raw=1',
      'octocat/images',
      'main',
      'https://cdn.example/octocat/uploads/image.png?raw=1'
    ),
    'uploads/image.png'
  )
})

test('does not map unrelated or non-reversible public URLs', () => {
  assert.equal(
    remotePathFromPublicUrl('', 'octocat/images', 'main', 'https://example.com/image.png'),
    undefined
  )
  assert.equal(
    remotePathFromPublicUrl('https://cdn.example/static', 'octocat/images', 'main', 'https://cdn.example/static'),
    undefined
  )
  assert.equal(
    remotePathFromPublicUrl(
      '',
      'octocat/images',
      'main',
      'https://raw.githubusercontent.com/octocat/images/main/images/%E0%A4%A.png'
    ),
    undefined
  )
})
