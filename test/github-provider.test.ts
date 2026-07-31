import assert from 'node:assert/strict'
import test from 'node:test'
import { GitHubProvider } from '../src/providers/github'

test('uses current file metadata to overwrite and delete GitHub content', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const responses = [
    jsonResponse({ path: 'images/photo.png', sha: 'old-sha' }),
    jsonResponse({
      content: {
        path: 'images/photo.png',
        sha: 'new-sha',
        download_url:
          'https://raw.githubusercontent.com/octocat/images/main/images/photo.png'
      }
    }),
    jsonResponse({ path: 'images/photo.png', sha: 'new-sha' }),
    jsonResponse({ commit: { sha: 'delete-commit' } })
  ]
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    const response = responses.shift()
    if (!response) throw new Error('Unexpected fetch call')
    return response
  }

  try {
    const provider = new GitHubProvider('secret')
    const target = { repository: 'octocat/images', branch: 'main' }
    const existing = await provider.getFile(target, 'images/photo.png')
    assert.equal(existing?.sha, 'old-sha')
    await provider.upload({
      data: new Uint8Array([1, 2, 3]),
      fileName: 'photo.png',
      remotePath: 'images/photo.png',
      commitMessage: 'Upload ${uploadedName}',
      target,
      existingSha: existing?.sha
    })
    const current = await provider.getFile(target, 'images/photo.png')
    assert(current)
    await provider.delete({
      remotePath: current.remotePath,
      sha: current.sha,
      commitMessage: 'Delete photo.png',
      target
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(calls[0].init?.method, undefined)
  assert.match(calls[0].url, /contents\/images\/photo\.png\?ref=main$/)
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
    message: 'Upload photo.png',
    content: 'AQID',
    branch: 'main',
    sha: 'old-sha'
  })
  assert.equal(calls[3].init?.method, 'DELETE')
  assert.deepEqual(JSON.parse(String(calls[3].init?.body)), {
    message: 'Delete photo.png',
    sha: 'new-sha',
    branch: 'main'
  })
})

test('configuration verification rejects credentials without write access', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    jsonResponse({ permissions: { pull: true, push: false } })
  try {
    await assert.rejects(
      new GitHubProvider('read-only').verify({
        repository: 'octocat/images',
        branch: 'main'
      }),
      /does not have write access/
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('creates a new file without an overwrite SHA', async () => {
  const originalFetch = globalThis.fetch
  let request: RequestInit | undefined
  globalThis.fetch = async (_input, init) => {
    request = init
    return jsonResponse({
      content: {
        path: 'images/new.png',
        sha: 'new-sha',
        download_url:
          'https://raw.githubusercontent.com/octocat/images/main/images/new.png'
      }
    })
  }
  try {
    const result = await new GitHubProvider('secret').upload({
      data: new Uint8Array([4, 5, 6]),
      fileName: 'new.png',
      remotePath: 'images/new.png',
      commitMessage: 'Upload ${uploadedName}',
      target: { repository: 'octocat/images', branch: 'main' }
    })
    assert.equal(result.sha, 'new-sha')
  } finally {
    globalThis.fetch = originalFetch
  }
  const body = JSON.parse(String(request?.body)) as Record<string, unknown>
  assert.equal(body.sha, undefined)
  assert.equal(body.message, 'Upload new.png')
})

test('returns no file for a GitHub 404 response', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('', { status: 404 })
  try {
    assert.equal(
      await new GitHubProvider('secret').getFile(
        { repository: 'octocat/images', branch: 'main' },
        'images/missing.png'
      ),
      undefined
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('configuration verification checks write permission and the target branch', async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  const responses = [
    jsonResponse({ permissions: { pull: true, push: true } }),
    jsonResponse({ name: 'docs/images' })
  ]
  globalThis.fetch = async (input) => {
    urls.push(String(input))
    const response = responses.shift()
    if (!response) throw new Error('Unexpected fetch call')
    return response
  }
  try {
    await new GitHubProvider('secret').verify({
      repository: 'octocat/images',
      branch: 'docs/images'
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.match(urls[0], /repos\/octocat\/images$/)
  assert.match(urls[1], /branches\/docs%2Fimages$/)
})

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
