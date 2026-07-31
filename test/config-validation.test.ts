import assert from 'node:assert/strict'
import test from 'node:test'
import { validateConfig } from '../src/config-validation'
import type { GitPasteConfig } from '../src/types'

const validConfig: GitPasteConfig = {
  repository: 'octocat/images',
  branch: 'main',
  path: 'images',
  publicUrl: '',
  commitMessage: 'Upload ${uploadedName} with GitPaste',
  conflictStrategy: 'rename',
  fileNameFormat: '${name}-${random}${extName}',
  outputFormat: '![${uploadedName}](${url})',
  includeImageName: true,
  maxFileSizeMb: 20
}

test('accepts the default-style configuration', () => {
  assert.doesNotThrow(() => validateConfig(validConfig))
})

test('accepts a reversible HTTPS public URL template', () => {
  assert.doesNotThrow(() =>
    validateConfig({
      ...validConfig,
      publicUrl:
        'https://cdn.example/${owner}/${repository}@${branch}/${path}'
    })
  )
})

test('rejects invalid conflict, path, commit, URL, and output settings', () => {
  assert.throws(
    () =>
      validateConfig({
        ...validConfig,
        conflictStrategy: 'invalid' as GitPasteConfig['conflictStrategy']
      }),
    /must be rename, overwrite, or prompt/
  )
  assert.throws(
    () => validateConfig({ ...validConfig, path: 'images/../private' }),
    /cannot contain/
  )
  assert.throws(
    () => validateConfig({ ...validConfig, commitMessage: '   ' }),
    /cannot be empty/
  )
  assert.throws(
    () =>
      validateConfig({
        ...validConfig,
        publicUrl: 'https://cdn.example/static.png'
      }),
    /must include \$\{path\}/
  )
  assert.throws(
    () =>
      validateConfig({
        ...validConfig,
        publicUrl: 'javascript:${path}'
      }),
    /valid URL/
  )
  assert.throws(
    () => validateConfig({ ...validConfig, outputFormat: '${uploadedName}' }),
    /must include \$\{url\}/
  )
})
