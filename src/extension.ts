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
    vscode.commands.registerCommand('gitpaste.configure', async () =>
      runCommand(() => configure(service, credentials))
    ),
    vscode.commands.registerCommand('gitpaste.setToken', async () =>
      runCommand(async () => {
        const token = await credentials.promptForPersonalToken()
        if (token) {
          await service.verifyConfiguration(token)
          await vscode.window.showInformationMessage(
            'GitPaste: token saved and repository read access verified. Uploads also require Contents: Read and write.'
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
  await insertUploaded(editor, uploaded)
  await vscode.window.showInformationMessage(
    `GitPaste: uploaded ${uploaded.length} image${
      uploaded.length === 1 ? '' : 's'
    }.`
  )
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
      vscode.ConfigurationTarget.Global
    ),
    settings.update(
      'github.branch',
      branch.trim(),
      vscode.ConfigurationTarget.Global
    ),
    settings.update('github.path', path.trim(), vscode.ConfigurationTarget.Global)
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
    `GitPaste: connected to ${repository.trim()}@${branch.trim()}. Repository read access verified; uploads require Contents: Read and write.`
  )
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
