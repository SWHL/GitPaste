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
import type { ImageInput, UploadedImage } from './types'

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('GitPaste')
  const credentials = new Credentials(context.secrets)
  const service = new GitPasteService(credentials, output)
  const pasteProvider = new GitPastePasteProvider(service)

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
      async () => runCommand(() => replaceImageAtCursor(service))
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
  const uris = await vscode.window.showOpenDialog({
    title: 'GitPaste: select images',
    filters: imageFileFilters(),
    canSelectMany: true,
    canSelectFiles: true,
    canSelectFolders: false
  })
  if (!uris?.length) return
  const images = await Promise.all(uris.map((uri) => service.readUri(uri)))
  applySelectedName(images)
  await uploadAndInsert(service, images)
}

async function uploadFromInput(service: GitPasteService): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: 'GitPaste: upload image',
    prompt: 'Enter an HTTP URL, workspace-relative path, or VS Code URI.',
    placeHolder: 'assets/image.png or https://example.com/image.png',
    ignoreFocusOut: true
  })
  if (!value) return
  const image = await service.readPathOrUrl(value)
  if (!image.mimeType?.startsWith('image/') && !isSupportedImageName(image.name)) {
    throw new Error('The selected resource is not a supported image.')
  }
  applySelectedName([image])
  await uploadAndInsert(service, [image])
}

async function uploadAndInsert(
  service: GitPasteService,
  images: readonly ImageInput[]
): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    throw new Error('Open an editor before uploading an image.')
  }
  const documentName = editor.document.uri.path.split('/').pop() || 'document'
  const uploaded = await service.uploadImages(
    images,
    documentName,
    new vscode.CancellationTokenSource().token
  )
  await insertUploadedWithCleanup(service, editor, uploaded)
  await vscode.window.showInformationMessage(
    `GitPaste: uploaded ${uploaded.length} image${
      uploaded.length === 1 ? '' : 's'
    }.`
  )
}

async function replaceImageAtCursor(service: GitPasteService): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) throw new Error('Open a Markdown editor before replacing an image.')
  const document = editor.document
  const originalVersion = document.version
  const image = findMarkdownImageAtOffset(
    document.getText(),
    document.offsetAt(editor.selection.active)
  )
  if (!image) {
    throw new Error('Place the cursor inside a Markdown image before replacing it.')
  }

  const uris = await vscode.window.showOpenDialog({
    title: 'GitPaste: select replacement image',
    filters: imageFileFilters(),
    canSelectMany: false,
    canSelectFiles: true,
    canSelectFolders: false
  })
  if (!uris?.length) return
  const input = await service.readUri(uris[0])
  const uploaded = await service.uploadImages(
    [input],
    document.uri.path.split('/').pop() || 'document',
    new vscode.CancellationTokenSource().token
  )
  if (
    vscode.window.activeTextEditor?.document !== document ||
    document.version !== originalVersion
  ) {
    await offerInsertionCleanup(service, uploaded)
    throw new Error('The document changed while the replacement image was uploading.')
  }
  const applied = await editor.edit((builder) => {
    builder.replace(
      new vscode.Range(
        document.positionAt(image.start),
        document.positionAt(image.end)
      ),
      uploaded[0].output
    )
  })
  if (!applied) {
    await offerInsertionCleanup(service, uploaded)
    throw new Error('The Markdown image could not be replaced in the editor.')
  }

  const oldRemotePath = await service.remotePathForUrl(image.url)
  if (oldRemotePath && oldRemotePath !== uploaded[0].remotePath) {
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
  editor: vscode.TextEditor,
  uploaded: readonly UploadedImage[]
): Promise<void> {
  const text = uploaded.map((image) => image.output).join('\n')
  const applied = await editor.edit((builder) => {
    builder.replace(editor.selection, text)
  })
  if (!applied) {
    throw new Error('The Markdown link could not be inserted into the editor.')
  }
}

async function insertUploadedWithCleanup(
  service: GitPasteService,
  editor: vscode.TextEditor,
  uploaded: readonly UploadedImage[]
): Promise<void> {
  try {
    await insertUploaded(editor, uploaded)
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

function applySelectedName(images: ImageInput[]): void {
  if (images.length !== 1) return
  const editor = vscode.window.activeTextEditor
  const selected = editor?.document.getText(editor.selection).trim()
  if (!selected) return
  const extension = images[0].name.match(/\.[^.]+$/)?.[0] || ''
  images[0] = { ...images[0], name: `${selected}${extension}` }
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
