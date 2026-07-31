import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cleanupCandidates,
  remoteVersionMatchesUpload,
  resolveUploadDestination
} from '../src/upload-policy'
import type { ProviderFile, UploadedImage } from '../src/types'

test('uses the requested path when no conflict exists', async () => {
  const checked: string[] = []
  const destination = await resolveUploadDestination(
    'images/photo.png',
    'rename',
    async (path) => {
      checked.push(path)
      return undefined
    }
  )
  assert.deepEqual(destination, {
    remotePath: 'images/photo.png',
    created: true
  })
  assert.deepEqual(checked, ['images/photo.png'])
})

test('finds the first available numeric suffix for rename conflicts', async () => {
  const files = new Map<string, ProviderFile>([
    ['images/photo.png', file('images/photo.png', 'sha-1')],
    ['images/photo-2.png', file('images/photo-2.png', 'sha-2')]
  ])
  const destination = await resolveUploadDestination(
    'images/photo.png',
    'rename',
    async (path) => files.get(path)
  )
  assert.deepEqual(destination, {
    remotePath: 'images/photo-3.png',
    created: true
  })
})

test('preserves the path and SHA for overwrite conflicts', async () => {
  const destination = await resolveUploadDestination(
    'images/photo.png',
    'overwrite',
    async (path) => file(path, 'existing-sha')
  )
  assert.deepEqual(destination, {
    remotePath: 'images/photo.png',
    existingSha: 'existing-sha',
    created: false
  })
})

test('uses the interactive choice for prompt conflicts', async () => {
  let prompted = 0
  const destination = await resolveUploadDestination(
    'images/photo.png',
    'prompt',
    async (path) => file(path, 'existing-sha'),
    async () => {
      prompted += 1
      return 'overwrite'
    }
  )
  assert.equal(prompted, 1)
  assert.equal(destination.existingSha, 'existing-sha')
  assert.equal(destination.created, false)
})

test('cleanup only targets newly created files with unchanged versions', () => {
  const created = uploaded('new.png', 'new-sha', true)
  const overwritten = uploaded('old.png', 'overwrite-sha', false)
  assert.deepEqual(cleanupCandidates([created, overwritten]), [created])
  assert.equal(remoteVersionMatchesUpload(created, 'new-sha'), true)
  assert.equal(remoteVersionMatchesUpload(created, 'changed-sha'), false)
  assert.equal(
    remoteVersionMatchesUpload(uploaded('legacy.png', undefined, true), 'any'),
    true
  )
})

function file(remotePath: string, sha: string): ProviderFile {
  return { remotePath, sha }
}

function uploaded(
  remotePath: string,
  sha: string | undefined,
  created: boolean
): UploadedImage {
  return {
    originalName: 'photo',
    uploadedName: 'photo',
    remotePath,
    sha,
    created,
    url: `https://example.com/${remotePath}`,
    output: `![photo](https://example.com/${remotePath})`
  }
}
