import * as vscode from 'vscode'
import {
  GitPastePasteProvider,
  pasteDocumentSelector
} from '../../src/paste-provider'
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
    'gitpaste.configure',
    'gitpaste.setToken',
    'gitpaste.clearToken'
  ]) {
    assert(commands.includes(command), `${command} was not registered`)
  }

  await assertPasteEditContainsUploadedMarkdown()
}

async function assertPasteEditContainsUploadedMarkdown(): Promise<void> {
  const settings = vscode.workspace.getConfiguration('gitpaste')
  assert(
    settings.get<boolean>('uploadOnPaste') === true,
    'Image paste uploads were not enabled by default in the web extension host'
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
