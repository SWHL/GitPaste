import * as vscode from 'vscode'
import {
  GitPastePasteProvider,
  pasteDocumentSelector
} from '../../src/paste-provider'
import { findMarkdownImageAtOffset } from '../../src/markdown-image'
import type { GitPasteService } from '../../src/service'
import type { UploadedImage } from '../../src/types'

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('SWHL.gitpaste')
  assert(extension, 'GitPaste extension was not discovered')
  await waitFor(() => extension.isActive)
  assert(
    extension.isActive,
    'GitPaste was not activated automatically in the web extension host'
  )

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
  assert(workspaceFolder, 'The web test workspace was not mounted')
  const workspaceMarkdown = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(workspaceFolder.uri, 'README.md')
  )
  assert(
    vscode.languages.match(pasteDocumentSelector, workspaceMarkdown) > 0,
    `GitPaste did not match ${workspaceMarkdown.uri.scheme}: Markdown documents`
  )

  const commands = await vscode.commands.getCommands(true)
  for (const command of [
    'gitpaste.uploadImageFromClipboard',
    'gitpaste.uploadImageFromExplorer',
    'gitpaste.uploadImageFromInputBox',
    'gitpaste.replaceImageAtCursor',
    'gitpaste.checkConfiguration',
    'gitpaste.configure',
    'gitpaste.setToken',
    'gitpaste.clearToken'
  ]) {
    assert(commands.includes(command), `${command} was not registered`)
  }

  await assertPasteEditContainsUploadedMarkdown()
  await assertPasteEditReplacesMarkdownImage()
  await assertExpiredReplacementFallsBackToNormalPaste()
}

async function assertPasteEditContainsUploadedMarkdown(): Promise<void> {
  const settings = vscode.workspace.getConfiguration('gitpaste')
  assert(
    settings.get<boolean>('uploadOnPaste') === true,
    'Image paste uploads were not enabled by default in the web extension host'
  )
  assert(
    settings.get<string>('github.conflictStrategy') === 'rename',
    'The safe rename conflict strategy was not enabled by default'
  )
  assert(
    settings.get<boolean>('includeImageName') === true,
    'The existing image alt-text behavior changed unexpectedly'
  )
  assert(
    vscode.env.uiKind === vscode.UIKind.Web,
    'The web integration test did not run in a web extension host'
  )

  const expected = '![clipboard](https://example.com/clipboard.png)'
  const uploaded: UploadedImage = {
    originalName: 'clipboard',
    uploadedName: 'clipboard',
    remotePath: 'images/clipboard.png',
    url: 'https://example.com/clipboard.png',
    output: expected
  }
  let uploadCalls = 0
  const service = {
    uploadImages: async () => {
      uploadCalls += 1
      return [uploaded]
    }
  } as unknown as GitPasteService
  const provider = new GitPastePasteProvider(service)
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: ''
  })
  const transfer = createImageTransfer('clipboard.png')
  const edits = await provider.provideDocumentPasteEdits(
    document,
    [new vscode.Range(0, 0, 0, 0)],
    transfer,
    {
      only: undefined,
      triggerKind: vscode.DocumentPasteTriggerKind.Automatic
    },
    new vscode.CancellationTokenSource().token
  )

  assert(edits?.length === 1, 'GitPaste did not return one image paste edit')
  assert(edits[0].insertText === expected, 'GitPaste paste edit was empty')

  const textTransfer = [
    [
      'text/plain',
      {
        asFile: () => undefined,
        asString: async () => 'ordinary text'
      }
    ]
  ] as unknown as vscode.DataTransfer
  const textEdits = await provider.provideDocumentPasteEdits(
    document,
    [new vscode.Range(0, 0, 0, 0)],
    textTransfer,
    {
      only: undefined,
      triggerKind: vscode.DocumentPasteTriggerKind.Automatic
    },
    new vscode.CancellationTokenSource().token
  )
  assert(!textEdits, 'GitPaste intercepted a text paste')
  assert(uploadCalls === 1, 'GitPaste attempted to upload non-image clipboard data')
}

async function assertPasteEditReplacesMarkdownImage(): Promise<void> {
  const original = 'Before ![old](https://example.com/old.png) after'
  const expected = '![new](https://example.com/new.png)'
  const uploaded: UploadedImage = {
    originalName: 'new',
    uploadedName: 'new',
    remotePath: 'images/new.png',
    url: 'https://example.com/new.png',
    output: expected
  }
  const applied: Array<{ oldUrl: string; uploaded: UploadedImage }> = []
  const service = {
    uploadImages: async () => [uploaded]
  } as unknown as GitPasteService
  const provider = new GitPastePasteProvider(service, {
    applied: async (oldUrl, completedUpload) => {
      applied.push({ oldUrl, uploaded: completedUpload })
    },
    notApplied: async () => undefined
  })
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: original
  })
  const image = findMarkdownImageAtOffset(original, original.indexOf('old.png'))
  assert(image, 'The replacement test image could not be parsed')
  provider.prepareImageReplacement(document, image)

  const cursor = document.positionAt(original.indexOf('old.png'))
  const edits = await provider.provideDocumentPasteEdits(
    document,
    [new vscode.Range(cursor, cursor)],
    createImageTransfer('new.png'),
    {
      only: undefined,
      triggerKind: vscode.DocumentPasteTriggerKind.Automatic
    },
    new vscode.CancellationTokenSource().token
  )

  assert(edits?.length === 1, 'GitPaste did not return a replacement paste edit')
  assert(edits[0].insertText === '', 'Replacement unexpectedly inserted at the cursor')
  assert(edits[0].additionalEdit, 'Replacement did not include the Markdown edit')
  assert(
    await vscode.workspace.applyEdit(edits[0].additionalEdit),
    'The replacement workspace edit could not be applied'
  )
  await waitFor(() => applied.length === 1)
  assert(
    document.getText() === `Before ${expected} after`,
    'The complete Markdown image was not replaced'
  )
  assert(
    applied[0].oldUrl === 'https://example.com/old.png',
    'The replacement callback did not receive the old URL'
  )
  assert(applied[0].uploaded === uploaded, 'The replacement upload was lost')
}

async function assertExpiredReplacementFallsBackToNormalPaste(): Promise<void> {
  const original = '![old](https://example.com/old.png)'
  const uploaded: UploadedImage = {
    originalName: 'new',
    uploadedName: 'new',
    remotePath: 'images/new.png',
    url: 'https://example.com/new.png',
    output: '![new](https://example.com/new.png)'
  }
  const service = {
    uploadImages: async () => [uploaded]
  } as unknown as GitPasteService
  const provider = new GitPastePasteProvider(service, undefined, 5)
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: original
  })
  const image = findMarkdownImageAtOffset(original, original.indexOf('old.png'))
  assert(image, 'The expiration test image could not be parsed')
  provider.prepareImageReplacement(document, image)
  await new Promise((resolve) => setTimeout(resolve, 20))

  const cursor = document.positionAt(original.indexOf('old.png'))
  const edits = await provider.provideDocumentPasteEdits(
    document,
    [new vscode.Range(cursor, cursor)],
    createImageTransfer('new.png'),
    {
      only: undefined,
      triggerKind: vscode.DocumentPasteTriggerKind.Automatic
    },
    new vscode.CancellationTokenSource().token
  )

  assert(edits?.length === 1, 'Normal paste did not resume after expiration')
  assert(
    edits[0].insertText === uploaded.output,
    'An expired request still replaced the old Markdown image'
  )
  assert(!edits[0].additionalEdit, 'Expired replacement kept its additional edit')
}

function createImageTransfer(name: string): vscode.DataTransfer {
  return [
    [
      'image/png',
      {
        asFile: () => ({
          name,
          data: async () => new Uint8Array([1, 2, 3])
        })
      }
    ]
  ] as unknown as vscode.DataTransfer
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
