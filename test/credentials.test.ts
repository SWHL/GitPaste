import assert from 'node:assert/strict'
import test from 'node:test'
import * as vscode from 'vscode'
import { Credentials } from '../src/credentials'

type MockVscode = {
  __config: Record<string, unknown>
  __handlers: Record<string, (...args: any[]) => unknown>
  __reset: () => void
} & typeof vscode

const mockVscode = vscode as unknown as MockVscode

const TOKEN_KEY = 'gitpaste.github.personalAccessToken'

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

function setup(secrets = makeSecrets()): {
  credentials: Credentials
  secrets: ReturnType<typeof makeSecrets>
} {
  const credentials = new Credentials(
    secrets as unknown as vscode.SecretStorage,
  )
  return { credentials, secrets }
}

test.beforeEach(() => {
  mockVscode.__reset()
})

test('returns the OAuth session token without touching SecretStorage', async () => {
  const { credentials } = setup()
  mockVscode.__handlers.session = () =>
    Promise.resolve({ accessToken: 'oauth-token' })
  const token = await credentials.getToken(true)
  assert.equal(token, 'oauth-token')
})

test('returns the stored PAT directly when one is available', async () => {
  let sessionCalled = false
  const { credentials, secrets } = setup()
  await secrets.store(TOKEN_KEY, 'pat-token')
  mockVscode.__config['gitpaste.github.authenticationMethod'] = 'pat'
  mockVscode.__handlers.session = () => {
    sessionCalled = true
    return Promise.resolve({ accessToken: 'should-not-be-used' })
  }
  const token = await credentials.getToken(true)
  assert.equal(token, 'pat-token')
  assert.equal(sessionCalled, false)
})

test('prompts for a PAT, verifies it, and persists it on success', async () => {
  let verified: string | undefined
  const { credentials, secrets } = setup()
  mockVscode.__config['gitpaste.github.authenticationMethod'] = 'pat'
  mockVscode.__handlers.input = () => Promise.resolve('brand-new-pat')
  const token = await credentials.getToken(true, async (t) => {
    verified = t
  })
  assert.equal(token, 'brand-new-pat')
  assert.equal(verified, 'brand-new-pat')
  assert.equal(secrets.data[TOKEN_KEY], 'brand-new-pat')
  assert.equal(
    mockVscode.__config['gitpaste.github.authenticationMethod'],
    'pat',
  )
})

test('cancels when the PAT prompt is dismissed', async () => {
  const { credentials } = setup()
  mockVscode.__config['gitpaste.github.authenticationMethod'] = 'pat'
  mockVscode.__handlers.input = () => Promise.resolve(undefined)
  await assert.rejects(
    credentials.getToken(true),
    (error) => error instanceof vscode.CancellationError,
  )
})

test('cancels and reports when a supplied PAT fails verification', async () => {
  let errorShown = false
  const { credentials, secrets } = setup()
  mockVscode.__config['gitpaste.github.authenticationMethod'] = 'pat'
  mockVscode.__handlers.input = () => Promise.resolve('bad-pat')
  mockVscode.__handlers.error = () => {
    errorShown = true
    return Promise.resolve(undefined)
  }
  await assert.rejects(
    credentials.getToken(true, async () => {
      throw new Error('invalid token')
    }),
    (error) => error instanceof vscode.CancellationError,
  )
  assert.equal(errorShown, true)
  assert.equal(secrets.data[TOKEN_KEY], undefined)
})

test('throws when authentication is required but not interactive', async () => {
  const { credentials } = setup()
  mockVscode.__handlers.session = () => Promise.resolve(undefined)
  await assert.rejects(
    credentials.getToken(false),
    /authentication is required/,
  )
})

test('signInWithGitHub clears any PAT and switches to OAuth', async () => {
  const { credentials, secrets } = setup()
  await secrets.store(TOKEN_KEY, 'old-pat')
  mockVscode.__handlers.session = () =>
    Promise.resolve({ accessToken: 'oauth-token' })
  const token = await credentials.signInWithGitHub()
  assert.equal(token, 'oauth-token')
  assert.equal(secrets.data[TOKEN_KEY], undefined)
  assert.equal(
    mockVscode.__config['gitpaste.github.authenticationMethod'],
    'github',
  )
})

test('savePersonalToken persists the token and records the method', async () => {
  const { credentials, secrets } = setup()
  await credentials.savePersonalToken('my-pat')
  assert.equal(secrets.data[TOKEN_KEY], 'my-pat')
  assert.equal(
    mockVscode.__config['gitpaste.github.authenticationMethod'],
    'pat',
  )
})

test('clearPersonalToken removes the token and returns to OAuth', async () => {
  const { credentials, secrets } = setup()
  await credentials.savePersonalToken('my-pat')
  await credentials.clearPersonalToken()
  assert.equal(secrets.data[TOKEN_KEY], undefined)
  assert.equal(
    mockVscode.__config['gitpaste.github.authenticationMethod'],
    'github',
  )
})
