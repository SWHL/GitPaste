import assert from 'node:assert/strict'
import test from 'node:test'
import * as vscode from 'vscode'
import { GitPasteService } from '../src/service'
import { Credentials } from '../src/credentials'
import type { ImageInput } from '../src/types'

type MockVscode = {
  __config: Record<string, unknown>
  __handlers: Record<string, (...args: any[]) => unknown>
  __reset: () => void
} & typeof vscode

const mockVscode = vscode as unknown as MockVscode

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function notFound(): Response {
  return new Response('', { status: 404 })
}

function remotePathFromUrl(url: string): string {
  const match = /contents\/([^?]+)/.exec(url)
  return match ? decodeURIComponent(match[1]) : ''
}

/** Builds a fetch handler returning sensible GitHub API responses. */
function makeFetch(
  overrides: {
    getFile?: (url: string) => Response
    put?: (url: string, body: unknown) => Response
    onRequest?: (url: string, init?: RequestInit) => void
  } = {},
): (url: string, init?: RequestInit) => Response {
  let putCount = 0
  return (url, init) => {
    overrides.onRequest?.(url, init)
    if (init?.method === 'PUT') {
      if (overrides.put)
        return overrides.put(url, JSON.parse(String(init.body)))
      const remotePath = remotePathFromUrl(url)
      putCount += 1
      return jsonResponse({
        content: {
          path: remotePath,
          sha: `sha-put-${putCount}`,
          download_url: `https://raw.githubusercontent.com/octocat/images/main/${remotePath}`,
        },
      })
    }
    if (init?.method === 'DELETE') {
      return jsonResponse({ commit: { sha: 'delete-sha' } })
    }
    if (url.includes('/contents/') && url.includes('?ref=')) {
      return overrides.getFile ? overrides.getFile(url) : notFound()
    }
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return jsonResponse({ permissions: { push: true } })
    }
    if (url.includes('/branches/')) {
      return jsonResponse({ name: 'main' })
    }
    return notFound()
  }
}

function installFetch(
  handler: (url: string, init?: RequestInit) => Response,
): () => void {
  const original = globalThis.fetch
  globalThis.fetch = handler as unknown as typeof globalThis.fetch
  return () => {
    globalThis.fetch = original
  }
}

function makeSecrets() {
  const data: Record<string, string> = {}
  return {
    data,
    get: async (key: string) => data[key],
    store: async (key: string, value: string) => {
      data[key] = value
    },
    delete: async (key: string) => {
      delete data[key]
    },
  }
}

const output = {
  appendLine() {},
  show() {},
  dispose() {},
}

function setupService(): GitPasteService {
  const secrets = makeSecrets()
  const credentials = new Credentials(
    secrets as unknown as vscode.SecretStorage,
  )
  return new GitPasteService(
    credentials,
    output as unknown as vscode.OutputChannel,
  )
}

function defaultConfig(): void {
  mockVscode.__reset()
  Object.assign(mockVscode.__config, {
    'gitpaste.github.repository': 'octocat/images',
    'gitpaste.github.branch': 'main',
    'gitpaste.github.path': 'images',
    'gitpaste.github.publicUrl': '',
    'gitpaste.github.commitMessage': 'Upload ${uploadedName} with GitPaste',
    'gitpaste.github.conflictStrategy': 'rename',
    'gitpaste.fileNameStrategy': 'timestamp',
    'gitpaste.fileNameFormat': '${name}${extName}',
    'gitpaste.outputFormat': '![${uploadedName}](${url})',
    'gitpaste.includeImageName': true,
    'gitpaste.maxFileSizeMb': 20,
  })
}

const token = (): vscode.CancellationToken =>
  new vscode.CancellationTokenSource().token

const image = (name = 'a.png'): ImageInput => ({
  data: new Uint8Array([1, 2, 3]),
  name,
  mimeType: 'image/png',
})

test.beforeEach(() => {
  defaultConfig()
})

test.afterEach(() => {
  mockVscode.__reset()
})

test('uploads a single image and returns its Markdown output', async () => {
  const restore = installFetch(makeFetch())
  try {
    const service = setupService()
    const uploaded = await service.uploadImages([image()], 'doc.md', token())
    assert.equal(uploaded.length, 1)
    assert.equal(
      uploaded[0].url,
      'https://raw.githubusercontent.com/octocat/images/main/images/a.png',
    )
    assert.equal(
      uploaded[0].output,
      '![a](https://raw.githubusercontent.com/octocat/images/main/images/a.png)',
    )
  } finally {
    restore()
  }
})

test('uploads multiple images concurrently and preserves input order', async () => {
  const restore = installFetch(makeFetch())
  try {
    const service = setupService()
    const uploaded = await service.uploadImages(
      [image('a.png'), image('b.png'), image('c.png')],
      'doc.md',
      token(),
    )
    assert.deepEqual(
      uploaded.map((u) => u.remotePath),
      ['images/a.png', 'images/b.png', 'images/c.png'],
    )
  } finally {
    restore()
  }
})

test('does not issue a PUT when the upload is already cancelled', async () => {
  const state = { puts: 0 }
  const restore = installFetch(
    makeFetch({
      onRequest: (_url, init) => {
        if (init?.method === 'PUT') state.puts += 1
      },
    }),
  )
  try {
    const source = new vscode.CancellationTokenSource()
    source.cancel()
    const service = setupService()
    await assert.rejects(
      service.uploadImages([image()], 'doc.md', source.token),
      (error) => error instanceof vscode.CancellationError,
    )
    assert.equal(state.puts, 0)
  } finally {
    restore()
  }
})

test('overwrites an existing remote file and sends its SHA', async () => {
  let putBody: any
  const restore = installFetch(
    makeFetch({
      getFile: () => jsonResponse({ path: 'images/a.png', sha: 'old-sha' }),
      put: (url, body) => {
        putBody = body
        return jsonResponse({
          content: {
            path: remotePathFromUrl(url),
            sha: 'new-sha',
            download_url: `https://raw.githubusercontent.com/octocat/images/main/${remotePathFromUrl(url)}`,
          },
        })
      },
    }),
  )
  try {
    mockVscode.__config['gitpaste.github.conflictStrategy'] = 'overwrite'
    const service = setupService()
    const uploaded = await service.uploadImages([image()], 'doc.md', token())
    assert.equal(uploaded[0].remotePath, 'images/a.png')
    assert.equal(putBody.sha, 'old-sha')
  } finally {
    restore()
  }
})

test('renames to the first free suffix when the target exists', async () => {
  const restore = installFetch(
    makeFetch({
      getFile: (url) => {
        if (remotePathFromUrl(url) === 'images/a.png') {
          return jsonResponse({ path: 'images/a.png', sha: 'old-sha' })
        }
        return notFound()
      },
    }),
  )
  try {
    const service = setupService()
    const uploaded = await service.uploadImages([image()], 'doc.md', token())
    assert.equal(uploaded[0].remotePath, 'images/a-2.png')
  } finally {
    restore()
  }
})

test('asks the user when the prompt conflict strategy is selected', async () => {
  const restore = installFetch(
    makeFetch({
      getFile: () => jsonResponse({ path: 'images/a.png', sha: 'old-sha' }),
    }),
  )
  try {
    mockVscode.__config['gitpaste.github.conflictStrategy'] = 'prompt'
    mockVscode.__handlers.quickPick = (items: any[]) =>
      items.find((item) => item.strategy === 'overwrite')
    const service = setupService()
    const uploaded = await service.uploadImages([image()], 'doc.md', token())
    assert.equal(uploaded[0].remotePath, 'images/a.png')
  } finally {
    restore()
  }
})

test('reuses an identical image in hash mode without uploading it again', async () => {
  let putCalls = 0
  const restore = installFetch(
    makeFetch({
      getFile: () =>
        jsonResponse({
          path: 'images/hashsub/hashsub2/hashvalue.png',
          sha: 'existing-sha',
        }),
      put: () => {
        putCalls += 1
        return jsonResponse({})
      },
    }),
  )
  try {
    mockVscode.__config['gitpaste.fileNameStrategy'] = 'hash'
    const service = setupService()
    const uploaded = await service.uploadImages([image()], 'doc.md', token())
    assert.equal(uploaded[0].created, false)
    assert.equal(putCalls, 0)
  } finally {
    restore()
  }
})

test('reports a descriptive error instead of silently swallowing a total failure', async () => {
  const restore = installFetch(makeFetch())
  try {
    mockVscode.__config['gitpaste.maxFileSizeMb'] = 1
    mockVscode.__handlers.error = () => ({
      title: 'Skip failed',
      action: 'skip',
    })
    const service = setupService()
    const tooLarge: ImageInput = {
      data: new Uint8Array(2 * 1024 * 1024),
      name: 'big.png',
      mimeType: 'image/png',
    }
    await assert.rejects(
      service.uploadImages([tooLarge], 'doc.md', token()),
      /No images were uploaded/,
    )
  } finally {
    restore()
  }
})

test('propagates a cancellation as a CancellationError', async () => {
  const restore = installFetch(makeFetch())
  try {
    const source = new vscode.CancellationTokenSource()
    source.cancel()
    const service = setupService()
    await assert.rejects(
      service.uploadImages([image()], 'doc.md', source.token),
      (error) => error instanceof vscode.CancellationError,
    )
  } finally {
    restore()
  }
})

test('maps a raw GitHub URL back to its repository-relative path', async () => {
  const service = setupService()
  const mapped = await service.remotePathForUrl(
    'https://raw.githubusercontent.com/octocat/images/main/images/a.png',
  )
  assert.equal(mapped, 'images/a.png')
  const unrelated = await service.remotePathForUrl(
    'https://raw.githubusercontent.com/other/repo/main/images/a.png',
  )
  assert.equal(unrelated, undefined)
})

test('deletes a remote path and aborts the request when cancelled', async () => {
  let aborted = false
  const restore = installFetch(
    makeFetch({
      getFile: () => jsonResponse({ path: 'images/a.png', sha: 'old-sha' }),
      onRequest: (_url, init) => {
        if (
          init?.method === 'DELETE' &&
          (init?.signal as AbortSignal | undefined)?.aborted
        ) {
          aborted = true
        }
      },
    }),
  )
  try {
    const source = new vscode.CancellationTokenSource()
    const service = setupService()
    await service.deleteRemotePath('images/a.png', source.token)
    assert.equal(aborted, false)
    source.cancel()
    await service.deleteRemotePath('images/a.png', source.token)
    assert.equal(aborted, true)
  } finally {
    restore()
  }
})
