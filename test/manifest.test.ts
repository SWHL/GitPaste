import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

interface Manifest {
  activationEvents: string[]
  contributes: {
    commands: Array<{ command: string }>
    configuration: {
      properties: Record<
        string,
        { default?: unknown; enum?: string[]; description?: string }
      >
    }
  }
}

const manifest = JSON.parse(
  readFileSync('package.json', 'utf8')
) as Manifest
const englishReadme = readFileSync('README.md', 'utf8')
const chineseReadme = readFileSync('docs/README_ZH.md', 'utf8')

test('registers new commands without removing existing upload commands', () => {
  const commands = manifest.contributes.commands.map(({ command }) => command)
  for (const command of [
    'gitpaste.uploadImageFromClipboard',
    'gitpaste.uploadImageFromExplorer',
    'gitpaste.uploadImageFromInputBox',
    'gitpaste.replaceImageAtCursor',
    'gitpaste.checkConfiguration'
  ]) {
    assert(commands.includes(command), `${command} is missing from the manifest`)
    assert(
      manifest.activationEvents.includes(`onCommand:${command}`),
      `${command} is missing its activation event`
    )
  }
})

test('declares all conflict choices and keeps desktop paste behavior unchanged', () => {
  const settings = manifest.contributes.configuration.properties
  assert.deepEqual(settings['gitpaste.github.conflictStrategy'].enum, [
    'rename',
    'overwrite',
    'prompt'
  ])
  assert.equal(settings['gitpaste.github.conflictStrategy'].default, 'rename')
  assert.equal(settings['gitpaste.uploadOnPaste'].default, true)
  assert.match(
    settings['gitpaste.uploadOnPaste'].description || '',
    /ignored on desktop/
  )
})

test('documents every contributed setting in both READMEs', () => {
  for (const setting of Object.keys(
    manifest.contributes.configuration.properties
  )) {
    assert(englishReadme.includes(setting), `${setting} is missing from README.md`)
    assert(
      chineseReadme.includes(setting),
      `${setting} is missing from docs/README_ZH.md`
    )
  }
})
