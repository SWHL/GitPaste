import * as vscode from 'vscode'
import { Credentials } from './credentials'
import {
  GitPastePasteProvider,
  pasteDocumentSelector,
  pasteProviderMetadata
} from './paste-provider'
import {
  GitPasteService,
  imageFileFilters,
  isSupportedImageName
} from './service'
import { findMarkdownImageAtOffset } from './markdown-image'
import { TrackedDocumentRange } from './tracked-document-range'
import type { ImageInput, UploadedImage } from './types'

interface InsertionTarget {
  readonly document: vscode.TextDocument
  readonly range: TrackedDocumentRange
  readonly documentName: string
  readonly selectedText: string
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('GitPaste')
  const credentials = new Credentials(context.secrets)
  const service = new GitPasteService(credentials, output)
  const pasteProvider = new GitPastePasteProvider(service, {
    applied: (oldUrl, uploaded) =>
      runCommand(() => finishImageReplacement(service, oldUrl, uploaded)),
    inserted: async (uploaded) => {
      await vscode.window.showInformationMessage(
        `GitPaste: uploaded ${uploaded.length} image${
          uploaded.length === 1 ? '' : 's'
        }.`
      )
    },
    notApplied: (uploaded) =>
      runCommand(() => offerInsertionCleanup(service, uploaded))
  })

  context.subscriptions.push(
    output,
    vscode.languages.registerDocumentPasteEditProvider(
      pasteDocumentSelector,
      pasteProvider,
      pasteProviderMetadata
    ),
    vscode.commands.registerCommand(
      'gitpaste.uploadImageFromClipboard',
      async () => runCommand(() => uploadFromClipboard(pasteProvider))
    ),
    vscode.commands.registerCommand(
      'gitpaste.uploadImageFromExplorer',
      async () => runCommand(() => uploadFromExplorer(service))
    ),
    vscode.commands.registerCommand(
      'gitpaste.uploadImageFromInputBox',
      async () => runCommand(() => uploadFromInput(service))
    ),
    vscode.commands.registerCommand(
      'gitpaste.replaceImageAtCursor',
      async () =>
        runCommand(() => replaceImageAtCursor(service, pasteProvider))
    ),
    vscode.commands.registerCommand(
      'gitpaste.checkConfiguration',
      async () =>
        runCommand(async () => {
          await service.verifyCurrentConfiguration()
          await vscode.window.showInformationMessage(
            'GitPaste: repository write access and branch configuration verified.'
          )
        })
    ),
    vscode.commands.registerCommand('gitpaste.configure', async () =>
      runCommand(() => configure(service, credentials))
    ),
    vscode.commands.registerCommand('gitpaste.setToken', async () =>
      runCommand(async () => {
        const token = await credentials.promptForPersonalToken()
        if (token) {
          await service.verifyConfiguration(token)
          await vscode.window.showInformationMessage(
            'GitPaste: token saved; repository write access and branch verified.'
          )
        }
      })
    ),
    vscode.commands.registerCommand('gitpaste.clearToken', async () =>
      runCommand(async () => {
        await credentials.clearPersonalToken()
        await vscode.window.showInformationMessage(
          'GitPaste: personal access token cleared.'
        )
      })
    )
  )
}

export function deactivate(): void {}

async function uploadFromClipboard(
  pasteProvider: GitPastePasteProvider
): Promise<void> {
  if (vscode.env.uiKind === vscode.UIKind.Web) {
    await vscode.window.showInformationMessage(
      'GitPaste: in VS Code for the Web, paste the image with Ctrl/Cmd+V.'
    )
    return
  }
  if (!vscode.window.activeTextEditor) {
    throw new Error('Open a Markdown editor before uploading an image.')
  }
  await pasteProvider.pasteFromClipboard()
}

async function uploadFromExplorer(service: GitPasteService): Promise<void> {
  const target = captureInsertionTarget()
  try {
    const uris = await vscode.window.showOpenDialog({
      title: 'GitPaste: select images',
      filters: imageFileFilters(),
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false
    })
    if (!uris?.length) return
    const images = await Promise.all(uris.map((uri) => service.readUri(uri)))
    applySelectedName(images, target.selectedText)
    await uploadAndInsert(service, images, target)
  } finally {
    target.range.dispose()
  }
}

async function uploadFromInput(service: GitPasteService): Promise<void> {
  const target = captureInsertionTarget()
  try {
    const value = await vscode.window.showInputBox({
      title: 'GitPaste: upload image',
      prompt: 'Enter an HTTP URL, workspace-relative path, or VS Code URI.',
      placeHolder: 'assets/image.png or https://example.com/image.png',
      ignoreFocusOut: true
    })
    if (!value) return
    const image = await service.readPathOrUrl(value, target.document.uri)
    if (!image.mimeType?.startsWith('image/') && !isSupportedImageName(image.name)) {
      throw new Error('The selected resource is not a supported image.')
    }
    applySelectedName([image], target.selectedText)
    await uploadAndInsert(service, [image], target)
  } finally {
    target.range.dispose()
  }
}

async function uploadAndInsert(
  service: GitPasteService,
  images: readonly ImageInput[],
  target: InsertionTarget
): Promise<void> {
  if (!target.range.isValid) {
    throw new Error('The image insertion target is no longer available.')
  }
  const cancellation = new vscode.CancellationTokenSource()
  const invalidation = target.range.onDidInvalidate(() => cancellation.cancel())
  try {
    const uploaded = await service.uploadImages(
      images,
      target.documentName,
      cancellation.token
    )
    await insertUploadedWithCleanup(service, target, uploaded)
    await vscode.window.showInformationMessage(
      `GitPaste: uploaded ${uploaded.length} image${
        uploaded.length === 1 ? '' : 's'
      }.`
    )
  } finally {
    invalidation.dispose()
    cancellation.dispose()
  }
}

async function replaceImageAtCursor(
  service: GitPasteService,
  pasteProvider: GitPastePasteProvider
): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) throw new Error('Open a Markdown editor before replacing an image.')
  const document = editor.document
  const image = findMarkdownImageAtOffset(
    document.getText(),
    document.offsetAt(editor.selection.active)
  )
  if (!image) {
    throw new Error('Place the cursor inside a Markdown image before replacing it.')
  }

  if (vscode.env.uiKind === vscode.UIKind.Web) {
    pasteProvider.prepareImageReplacement(document, image)
    await vscode.window.showInformationMessage(
      'GitPaste: paste one image now to replace the image at the cursor.'
    )
    return
  }

  const target = new TrackedDocumentRange(
    document,
    new vscode.Range(document.positionAt(image.start), document.positionAt(image.end))
  )
  try {
    const uris = await vscode.window.showOpenDialog({
      title: 'GitPaste: select replacement image',
      filters: imageFileFilters(),
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false
    })
    if (!uris?.length) return
    if (!target.isValid) {
      throw new Error('The image replacement target is no longer available.')
    }
    const input = await service.readUri(uris[0])
    if (!target.isValid) {
      throw new Error('The image replacement target is no longer available.')
    }
    const cancellation = new vscode.CancellationTokenSource()
    const invalidation = target.onDidInvalidate(() => cancellation.cancel())
    let uploaded: UploadedImage[]
    try {
      uploaded = await service.uploadImages(
        [input],
        document.uri.path.split('/').pop() || 'document',
        cancellation.token
      )
    } finally {
      invalidation.dispose()
      cancellation.dispose()
    }
    const replacementRange = target.resolve()
    if (!replacementRange) {
      await offerInsertionCleanup(service, uploaded)
      throw new Error('The image replacement target changed while uploading.')
    }
    const edit = new vscode.WorkspaceEdit()
    edit.replace(document.uri, replacementRange, uploaded[0].output)
    const applied = await vscode.workspace.applyEdit(edit)
    if (!applied) {
      await offerInsertionCleanup(service, uploaded)
      throw new Error('The Markdown image could not be replaced in the editor.')
    }

    await finishImageReplacement(service, image.url, uploaded[0])
  } finally {
    target.dispose()
  }
}

async function finishImageReplacement(
  service: GitPasteService,
  oldUrl: string,
  uploaded: UploadedImage
): Promise<void> {
  const oldRemotePath = await service.remotePathForUrl(oldUrl)
  if (oldRemotePath && oldRemotePath !== uploaded.remotePath) {
    const choice = await vscode.window.showWarningMessage(
      `GitPaste: image replaced. Delete old remote image ${oldRemotePath}?`,
      {
        modal: true,
        detail:
          'This creates a deletion commit and may break references to the same image in other documents.'
      },
      'Delete old image'
    )
    if (choice === 'Delete old image') {
      try {
        await service.deleteRemotePath(oldRemotePath)
        await vscode.window.showInformationMessage(
          'GitPaste: old remote image deleted.'
        )
      } catch (error) {
        await vscode.window.showErrorMessage(
          `GitPaste: the image was replaced, but the old remote image could not be deleted: ${errorMessage(error)}`
        )
      }
    }
  } else {
    await vscode.window.showInformationMessage('GitPaste: image replaced.')
  }
}

async function insertUploaded(
  target: InsertionTarget,
  uploaded: readonly UploadedImage[]
): Promise<void> {
  const text = uploaded.map((image) => image.output).join('\n')
  const range = target.range.resolve()
  if (!range) throw new Error('The image insertion target changed while uploading.')
  const edit = new vscode.WorkspaceEdit()
  edit.replace(target.document.uri, range, text)
  const applied = await vscode.workspace.applyEdit(edit)
  if (!applied) {
    throw new Error('The Markdown link could not be inserted into the editor.')
  }
}

async function insertUploadedWithCleanup(
  service: GitPasteService,
  target: InsertionTarget,
  uploaded: readonly UploadedImage[]
): Promise<void> {
  try {
    await insertUploaded(target, uploaded)
  } catch (error) {
    await offerInsertionCleanup(service, uploaded)
    throw error
  }
}

async function offerInsertionCleanup(
  service: GitPasteService,
  uploaded: readonly UploadedImage[]
): Promise<void> {
  if (!uploaded.some((image) => image.created !== false)) {
    await vscode.window.showWarningMessage(
      'GitPaste overwrote the remote image, but could not update the editor. The previous remote content cannot be automatically restored.'
    )
    return
  }
  const choice = await vscode.window.showWarningMessage(
    'GitPaste uploaded the image, but could not update the editor.',
    { modal: true },
    'Delete uploaded files',
    'Keep files'
  )
  if (choice === 'Delete uploaded files') {
    await service.deleteUploadedImages(uploaded)
  }
}

function applySelectedName(images: ImageInput[], selectedText: string): void {
  if (images.length !== 1) return
  if (!selectedText) return
  const extension = images[0].name.match(/\.[^.]+$/)?.[0] || ''
  images[0] = { ...images[0], name: `${selectedText}${extension}` }
}

function captureInsertionTarget(): InsertionTarget {
  const editor = vscode.window.activeTextEditor
  if (!editor) throw new Error('Open an editor before uploading an image.')
  const document = editor.document
  return {
    document,
    range: new TrackedDocumentRange(document, editor.selection),
    documentName: document.uri.path.split('/').pop() || 'document',
    selectedText: document.getText(editor.selection).trim()
  }
}

async function configure(
  service: GitPasteService,
  credentials: Credentials
): Promise<void> {
  const settings = vscode.workspace.getConfiguration('gitpaste')
  const configurationTarget = await pickConfigurationTarget()
  if (configurationTarget === undefined) return
  const current = settings.get<string>('github.repository', '')
  const repository = await vscode.window.showInputBox({
    title: 'GitPaste: GitHub repository',
    prompt: 'Repository that will store uploaded images.',
    placeHolder: 'owner/repository',
    value: current,
    ignoreFocusOut: true,
    validateInput: (value) =>
      /^[^/\s]+\/[^/\s]+$/.test(value.trim())
        ? undefined
        : 'Use the owner/repository format.'
  })
  if (!repository) return

  const branch = await vscode.window.showInputBox({
    title: 'GitPaste: branch',
    value: settings.get<string>('github.branch', 'main'),
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'A branch is required.')
  })
  if (!branch) return

  const path = await vscode.window.showInputBox({
    title: 'GitPaste: image directory',
    value: settings.get<string>('github.path', 'images'),
    placeHolder: 'images',
    ignoreFocusOut: true
  })
  if (path === undefined) return

  await Promise.all([
    settings.update(
      'github.repository',
      repository.trim(),
      configurationTarget
    ),
    settings.update(
      'github.branch',
      branch.trim(),
      configurationTarget
    ),
    settings.update('github.path', path.trim(), configurationTarget)
  ])

  const authentication = await vscode.window.showQuickPick(
    [
      {
        label: 'Sign in with GitHub',
        description: 'Recommended for vscode.dev and desktop',
        method: 'oauth'
      },
      {
        label: 'Use a personal access token',
        description: 'Use a fine-grained token stored in VS Code SecretStorage',
        method: 'token'
      }
    ],
    { title: 'GitPaste: authentication', ignoreFocusOut: true }
  )
  if (!authentication) return
  const token =
    authentication.method === 'oauth'
      ? await credentials.signInWithGitHub()
      : await credentials.promptForPersonalToken()
  if (!token) return
  await service.verifyConfiguration(token)
  await vscode.window.showInformationMessage(
    `GitPaste: connected to ${repository.trim()}@${branch.trim()}. Write access and branch verified.`
  )
}

async function pickConfigurationTarget(): Promise<
  vscode.ConfigurationTarget | undefined
> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return vscode.ConfigurationTarget.Global
  }
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: 'Current workspace',
        description: 'Use this image repository only in the current project',
        target: vscode.ConfigurationTarget.Workspace
      },
      {
        label: 'Global',
        description: 'Use this image repository in every project',
        target: vscode.ConfigurationTarget.Global
      }
    ],
    { title: 'GitPaste: save repository configuration', ignoreFocusOut: true }
  )
  return choice?.target
}

async function runCommand(action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (error instanceof vscode.CancellationError) return
    await vscode.window.showErrorMessage(
      `GitPaste: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
