import * as vscode from 'vscode'
import {
  GitPastePasteProvider,
  pasteDocumentSelector
} from '../../src/paste-provider'
import { findMarkdownImageAtOffset } from '../../src/markdown-image'
import { TrackedDocumentRange } from '../../src/tracked-document-range'
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
  await assertAppliedPasteIsConfirmed()
  await assertCanceledPasteIsCleanedUp()
  await assertUnappliedPasteIsCleanedUp()
  await assertPasteEditReplacesMarkdownImage()
  await assertChangedReplacementTargetIsCanceled()
  await assertReplacementChangedDuringUploadIsCleanedUp()
  await assertTrackedRangeIgnoresCursorMovement()
  await assertTrackedRangeInvalidatesOnOverlap()
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
  const placeholder = '![Uploading clipboard.png...]()'
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
  assert(edits[0].insertText === placeholder, 'GitPaste upload placeholder was not inserted')
  const applied = new vscode.WorkspaceEdit()
  applied.replace(document.uri, new vscode.Range(0, 0, 0, 0), placeholder)
  assert(await vscode.workspace.applyEdit(applied), 'Upload placeholder could not be applied')
  await waitFor(() => document.getText() === expected)

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

  const prefix = 'Edited before upload. '
  const prefixEdit = new vscode.WorkspaceEdit()
  prefixEdit.insert(document.uri, new vscode.Position(0, 0), prefix)
  assert(
    await vscode.workspace.applyEdit(prefixEdit),
    'Could not edit before the tracked replacement target'
  )

  const cursor = document.positionAt(document.getText().indexOf('old.png'))
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
    document.getText() === `${prefix}Before ${expected} after`,
    'The complete Markdown image was not replaced'
  )
  assert(
    applied[0].oldUrl === 'https://example.com/old.png',
    'The replacement callback did not receive the old URL'
  )
  assert(applied[0].uploaded === uploaded, 'The replacement upload was lost')
}

async function assertAppliedPasteIsConfirmed(): Promise<void> {
  const uploaded = uploadedImage('confirmed')
  const placeholder = '![Uploading confirmed.png...]()'
  let inserted = 0
  let notApplied = 0
  const provider = new GitPastePasteProvider(
    { uploadImages: async () => [uploaded] } as unknown as GitPasteService,
    {
      applied: async () => undefined,
      inserted: async () => {
        inserted += 1
      },
      notApplied: async () => {
        notApplied += 1
      }
    }
  )
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: ''
  })
  const range = new vscode.Range(0, 0, 0, 0)
  const edits = await provider.provideDocumentPasteEdits(
    document,
    [range],
    createImageTransfer('confirmed.png'),
    pasteContext(),
    new vscode.CancellationTokenSource().token
  )
  assert(edits?.length === 1, 'Confirmed paste did not return an edit')

  const appliedEdit = new vscode.WorkspaceEdit()
  appliedEdit.replace(document.uri, range, placeholder)
  assert(await vscode.workspace.applyEdit(appliedEdit), 'Paste edit could not be applied')
  await waitFor(() => inserted === 1)
  assert(inserted === 1, 'Applied paste was not confirmed')
  assert(notApplied === 0, 'Applied paste incorrectly requested cleanup')
}

async function assertCanceledPasteIsCleanedUp(): Promise<void> {
  const uploaded = uploadedImage('canceled')
  const cancellation = new vscode.CancellationTokenSource()
  let inserted = 0
  let notApplied = 0
  const provider = new GitPastePasteProvider(
    {
      uploadImages: async () => {
        cancellation.cancel()
        return [uploaded]
      }
    } as unknown as GitPasteService,
    {
      applied: async () => undefined,
      inserted: async () => {
        inserted += 1
      },
      notApplied: async () => {
        notApplied += 1
      }
    }
  )
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: ''
  })
  const edits = await provider.provideDocumentPasteEdits(
    document,
    [new vscode.Range(0, 0, 0, 0)],
    createImageTransfer('canceled.png'),
    pasteContext(),
    cancellation.token
  )

  assert(edits?.length === 1, 'Canceled paste did not return its placeholder edit')
  const applied = new vscode.WorkspaceEdit()
  applied.replace(document.uri, new vscode.Range(0, 0, 0, 0), '![Uploading canceled.png...]()')
  assert(await vscode.workspace.applyEdit(applied), 'Canceled placeholder could not be applied')
  await waitFor(() => notApplied === 1)
  cancellation.cancel()
  assert(notApplied === 1, 'Canceled paste did not request cleanup exactly once')
  assert(inserted === 0, 'Canceled paste was reported as inserted')
  cancellation.dispose()
}

async function assertUnappliedPasteIsCleanedUp(): Promise<void> {
  const uploaded = uploadedImage('unapplied')
  let inserted = 0
  let notApplied = 0
  let uploadCalls = 0
  const provider = new GitPastePasteProvider(
    { uploadImages: async () => { uploadCalls += 1; return [uploaded] } } as unknown as GitPasteService,
    {
      applied: async () => undefined,
      inserted: async () => {
        inserted += 1
      },
      notApplied: async () => {
        notApplied += 1
      }
    },
    60_000,
    5
  )
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: ''
  })
  const edits = await provider.provideDocumentPasteEdits(
    document,
    [new vscode.Range(0, 0, 0, 0)],
    createImageTransfer('unapplied.png'),
    pasteContext(),
    new vscode.CancellationTokenSource().token
  )

  assert(edits?.length === 1, 'Unapplied paste did not return its candidate edit')
  await waitFor(() => notApplied === 1)
  assert(notApplied === 1, 'Unapplied paste did not request cleanup exactly once')
  assert(inserted === 0, 'Unapplied paste was reported as inserted')
  assert(uploadCalls === 0, 'Unapplied paste started an upload')
}

async function assertChangedReplacementTargetIsCanceled(): Promise<void> {
  const original = '![old](https://example.com/old.png)'
  let uploadCalls = 0
  const provider = new GitPastePasteProvider({
    uploadImages: async () => {
      uploadCalls += 1
      return [uploadedImage('new')]
    }
  } as unknown as GitPasteService)
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: original
  })
  const image = findMarkdownImageAtOffset(original, original.indexOf('old.png'))
  assert(image, 'The changed-target test image could not be parsed')
  provider.prepareImageReplacement(document, image)

  const targetEdit = new vscode.WorkspaceEdit()
  const changedPosition = document.positionAt(original.indexOf('old'))
  targetEdit.replace(
    document.uri,
    new vscode.Range(changedPosition, changedPosition.translate(0, 3)),
    'changed'
  )
  assert(await vscode.workspace.applyEdit(targetEdit), 'Could not change replacement target')

  const edits = await provider.provideDocumentPasteEdits(
    document,
    [new vscode.Range(0, 0, 0, 0)],
    createImageTransfer('new.png'),
    pasteContext(),
    new vscode.CancellationTokenSource().token
  )
  assert(!edits, 'Changed replacement target fell back to a normal upload')
  assert(uploadCalls === 0, 'Changed replacement target uploaded an image')
}

async function assertReplacementChangedDuringUploadIsCleanedUp(): Promise<void> {
  const original = '![old](https://example.com/old.png)'
  const uploaded = uploadedImage('changed-during-upload')
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: original
  })
  let notApplied = 0
  const provider = new GitPastePasteProvider(
    {
      uploadImages: async () => {
        const edit = new vscode.WorkspaceEdit()
        const position = document.positionAt(original.indexOf('old'))
        edit.replace(
          document.uri,
          new vscode.Range(position, position.translate(0, 3)),
          'changed'
        )
        assert(await vscode.workspace.applyEdit(edit), 'Could not change upload target')
        return [uploaded]
      }
    } as unknown as GitPasteService,
    {
      applied: async () => undefined,
      notApplied: async () => {
        notApplied += 1
      }
    }
  )
  const image = findMarkdownImageAtOffset(original, original.indexOf('old.png'))
  assert(image, 'The in-flight replacement test image could not be parsed')
  provider.prepareImageReplacement(document, image)
  const cursor = document.positionAt(original.indexOf('old.png'))

  const edits = await provider.provideDocumentPasteEdits(
    document,
    [new vscode.Range(cursor, cursor)],
    createImageTransfer('changed-during-upload.png'),
    pasteContext(),
    new vscode.CancellationTokenSource().token
  )
  assert(edits?.[0].additionalEdit, 'Changed replacement did not return a placeholder edit')
  assert(
    await vscode.workspace.applyEdit(edits[0].additionalEdit),
    'Changed replacement placeholder could not be applied'
  )
  await waitFor(() => notApplied === 1)
  assert(notApplied === 1, 'Changed in-flight replacement was not cleaned up once')
}

async function assertTrackedRangeInvalidatesOnOverlap(): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: 'before target after'
  })
  const tracker = new TrackedDocumentRange(
    document,
    new vscode.Range(0, 7, 0, 13)
  )
  const edit = new vscode.WorkspaceEdit()
  edit.replace(document.uri, new vscode.Range(0, 9, 0, 10), 'X')
  assert(await vscode.workspace.applyEdit(edit), 'Could not edit tracked range')
  assert(!tracker.isValid, 'Overlapping edit did not invalidate the tracked range')
  assert(!tracker.resolve(), 'Invalid tracked range still resolved to a target')
}

async function assertTrackedRangeIgnoresCursorMovement(): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: 'one two'
  })
  const editor = await vscode.window.showTextDocument(document)
  editor.selection = new vscode.Selection(0, 3, 0, 3)
  const tracker = new TrackedDocumentRange(document, editor.selection)

  editor.selection = new vscode.Selection(0, 7, 0, 7)
  const resolved = tracker.resolve()
  assert(resolved?.start.character === 3, 'Cursor movement changed the upload target')
  assert(!tracker.isValid, 'Resolved tracker remained active')
  assert(!tracker.resolve(), 'Resolved tracker returned a stale target twice')
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
    edits[0].insertText === '![Uploading new.png...]()',
    'Expired replacement did not fall back to a normal upload placeholder'
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

function pasteContext(): vscode.DocumentPasteEditContext {
  return {
    only: undefined,
    triggerKind: vscode.DocumentPasteTriggerKind.Automatic
  }
}

function uploadedImage(name: string): UploadedImage {
  return {
    originalName: name,
    uploadedName: name,
    remotePath: `images/${name}.png`,
    url: `https://example.com/${name}.png`,
    output: `![${name}](https://example.com/${name}.png)`
  }
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
