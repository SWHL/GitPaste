import assert from 'node:assert/strict'
import test from 'node:test'
import {
  contentHash,
  dedupKey,
  errorMessage,
  formatBytes,
  mapWithConcurrency,
  pathBaseName,
  preflightContentLength,
  toBase64,
} from '../src/util'

test('errorMessage unwraps Error instances and coerces other values', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom')
  assert.equal(errorMessage('plain'), 'plain')
  assert.equal(errorMessage({ toString: () => 'obj' }), 'obj')
})

test('formatBytes picks a readable unit instead of always MB', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(20 * 1024 * 1024), '20.0 MB')
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), '2.0 GB')
  assert.equal(formatBytes(-1), '0 B')
})

test('toBase64 round-trips small payloads', () => {
  const data = new Uint8Array([1, 2, 3, 250, 255, 0])
  assert.equal(toBase64(data), btoa(String.fromCharCode(1, 2, 3, 250, 255, 0)))
})

test('toBase64 handles payloads larger than a single chunk without overflow', () => {
  const length = 200_000
  const data = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) {
    data[index] = index % 256
  }
  const decoded = Uint8Array.from(atob(toBase64(data)), (char) =>
    char.charCodeAt(0),
  )
  assert.deepEqual(decoded, data)
})

test('pathBaseName returns the final segment or the fallback', () => {
  assert.equal(pathBaseName('/a/b/note.md'), 'note.md')
  assert.equal(pathBaseName(''), 'document')
  assert.equal(pathBaseName('/only/', 'fallback'), 'fallback')
  assert.equal(pathBaseName('/a/b/c.png', 'image'), 'c.png')
})

test('contentHash is stable and distinguishes buffers', () => {
  const first = new Uint8Array([10, 20, 30])
  const second = new Uint8Array([10, 20, 31])
  assert.equal(contentHash(first), contentHash(first))
  assert.notEqual(contentHash(first), contentHash(second))
})

test('dedupKey collides for identical bytes and differs by source', () => {
  const image = { data: new Uint8Array([1, 2, 3]), name: 'a.png' }
  const sameBytesDifferentName = { ...image, name: 'b.png' }
  assert.equal(dedupKey(image), dedupKey(image))
  assert.notEqual(dedupKey(image), dedupKey(sameBytesDifferentName, 'uri-x'))
  assert.equal(dedupKey(image, 'uri-x'), dedupKey(image, 'uri-x'))
})

test('mapWithConcurrency preserves order and bounds parallelism', async () => {
  const order: number[] = []
  let active = 0
  let maxActive = 0
  const result = await mapWithConcurrency(
    [0, 1, 2, 3, 4, 5],
    2,
    async (value) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(value)
      active -= 1
      return value * 2
    },
  )
  assert.deepEqual(result, [0, 2, 4, 6, 8, 10])
  assert.equal(maxActive, 2)
})

test('mapWithConcurrency propagates the first rejection', async () => {
  await assert.rejects(
    mapWithConcurrency([0, 1, 2], 3, async (value) => {
      if (value === 1) throw new Error('fail')
      return value
    }),
    /fail/,
  )
})

function stubFetch(
  impl: (url: string, init?: { method?: string }) => unknown,
): () => void {
  const original = globalThis.fetch
  // @ts-expect-error - replacing the global for the duration of a test
  globalThis.fetch = (url: string, init?: { method?: string }) =>
    impl(url, init)
  return () => {
    globalThis.fetch = original
  }
}

test('preflightContentLength reads content-length from a HEAD request', async () => {
  const restore = stubFetch((_url, init) => {
    assert.equal(init?.method, 'HEAD')
    const headers = new Map([['content-length', '1024']])
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: (key: string) => headers.get(key) ?? null },
    })
  })
  try {
    assert.equal(
      await preflightContentLength('https://example.com/a.png'),
      1024,
    )
  } finally {
    restore()
  }
})

test('preflightContentLength returns undefined on a non-OK HEAD', async () => {
  const restore = stubFetch(() =>
    Promise.resolve({
      ok: false,
      status: 405,
      headers: { get: () => null },
    }),
  )
  try {
    assert.equal(
      await preflightContentLength('https://example.com/a.png'),
      undefined,
    )
  } finally {
    restore()
  }
})

test('preflightContentLength swallows network errors and missing headers', async () => {
  const restore = stubFetch(() => {
    throw new Error('network down')
  })
  try {
    assert.equal(
      await preflightContentLength('https://example.com/a.png'),
      undefined,
    )
  } finally {
    restore()
  }

  const restore2 = stubFetch(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
    }),
  )
  try {
    assert.equal(
      await preflightContentLength('https://example.com/a.png'),
      undefined,
    )
  } finally {
    restore2()
  }
})
