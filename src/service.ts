import * as vscode from 'vscode'
import { Credentials } from './credentials'
import {
  formatUploadFileName,
  joinRepoPath,
  nameWithoutExtension,
  normalizeRepoPath,
  splitFileName
} from './naming'
import {
  formatOutput,
  buildPublicUrl,
  parseRepository,
  remotePathFromPublicUrl
} from './public-url'
import { validateConfig } from './config-validation'
import { GitHubProvider } from './providers/github'
import {
  cleanupCandidates,
  remoteVersionMatchesUpload,
  resolveUploadDestination
} from './upload-policy'
import type {
  GitPasteConfig,
  GitHubTarget,
  ImageInput,
  ConflictStrategy,
  UploadedImage
} from './types'

const IMAGE_EXTENSIONS = [
  'avif',
  'bmp',
  'gif',
  'ico',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'tiff',
  'webp'
]

interface FailureAction extends vscode.MessageItem {
  readonly action: 'retry' | 'skip' | 'cancel'
}

export class GitPasteService {
  constructor(
    private readonly credentials: Credentials,
    private readonly output: vscode.OutputChannel
  ) {}

  async uploadImages(
    images: readonly ImageInput[],
    documentName: string,
    token: vscode.CancellationToken
  ): Promise<UploadedImage[]> {
    if (!images.length) return []
    const config = await this.getConfig(true)
    const accessToken = await this.credentials.getToken(true)
    const provider = new GitHubProvider(accessToken)
    const target: GitHubTarget = {
      repository: config.repository,
      branch: config.branch
    }

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `GitPaste: uploading ${images.length} image${
          images.length === 1 ? '' : 's'
        }`,
        cancellable: true
      },
      async (progress, progressToken) => {
        const uploaded: UploadedImage[] = []
        for (const [index, image] of images.entries()) {
          if (token.isCancellationRequested || progressToken.isCancellationRequested) {
            if (uploaded.length) {
              await this.offerCleanup(provider, target, uploaded)
            }
            throw new vscode.CancellationError()
          }
          progress.report({ message: image.name })

          let uploadedImage: UploadedImage | undefined
          while (!uploadedImage) {
            try {
              this.validateSize(image, config.maxFileSizeMb)
              uploadedImage = await this.uploadImage(
                provider,
                target,
                config,
                image,
                documentName
              )
            } catch (error) {
              if (error instanceof vscode.CancellationError) {
                if (uploaded.length) {
                  await this.offerCleanup(provider, target, uploaded)
                }
                throw error
              }
              const action = await this.chooseFailureAction(image, error)
              if (action === 'retry') continue
              if (action === 'skip') break
              if (uploaded.length) {
                await this.offerCleanup(provider, target, uploaded)
              }
              throw new vscode.CancellationError()
            }
          }
          if (!uploadedImage) continue
          uploaded.push(uploadedImage)
          progress.report({
            message: index === images.length - 1 ? 'Done' : image.name,
            increment: 100 / images.length
          })
        }
        if (uploaded.length < images.length) {
          void vscode.window.showWarningMessage(
            `GitPaste: uploaded ${uploaded.length} of ${images.length} images.`
          )
        }
        if (!uploaded.length) throw new vscode.CancellationError()
        return uploaded
      }
    )
  }

  async deleteUploadedImages(images: readonly UploadedImage[]): Promise<void> {
    const createdImages = cleanupCandidates(images)
    if (!createdImages.length) {
      throw new Error(
        'Overwritten remote files cannot be automatically rolled back.'
      )
    }
    const config = await this.getConfig(false)
    const target = this.targetFromConfig(config)
    const provider = new GitHubProvider(await this.credentials.getToken(true))
    await this.deleteImages(provider, target, createdImages)
  }

  async deleteRemotePath(remotePath: string): Promise<void> {
    const config = await this.getConfig(false)
    const target = this.targetFromConfig(config)
    const provider = new GitHubProvider(await this.credentials.getToken(true))
    const current = await provider.getFile(target, remotePath)
    if (!current) {
      throw new Error(`Remote image no longer exists: ${remotePath}`)
    }
    await provider.delete({
      target,
      remotePath: current.remotePath,
      sha: current.sha,
      commitMessage: `Delete ${current.remotePath} with GitPaste`
    })
    this.output.appendLine(
      `Deleted ${target.repository}@${target.branch}:${remotePath}`
    )
  }

  async remotePathForUrl(url: string): Promise<string | undefined> {
    const config = await this.getConfig(false)
    const mapped = remotePathFromPublicUrl(
      config.publicUrl,
      config.repository,
      config.branch,
      url
    )
    if (!mapped) return undefined
    let remotePath: string
    try {
      remotePath = normalizeRepoPath(mapped)
    } catch {
      return undefined
    }
    const configuredPath = normalizeRepoPath(config.path)
    if (
      configuredPath &&
      remotePath !== configuredPath &&
      !remotePath.startsWith(`${configuredPath}/`)
    ) {
      return undefined
    }
    return remotePath
  }

  private async uploadImage(
    provider: GitHubProvider,
    target: GitHubTarget,
    config: GitPasteConfig,
    image: ImageInput,
    documentName: string
  ): Promise<UploadedImage> {
    const fileName = formatUploadFileName(
      config.fileNameFormat,
      image.name,
      image.mimeType,
      documentName
    )
    const requestedPath = joinRepoPath(config.path, fileName)
    const destination = await resolveUploadDestination(
      requestedPath,
      config.conflictStrategy,
      (remotePath) => provider.getFile(target, remotePath),
      () => this.promptForConflict(requestedPath)
    )
    const remotePath = destination.remotePath

    const uploadedFileName = remotePath.split('/').pop() || fileName
    this.output.appendLine(
      `Uploading ${image.name} to ${target.repository}@${target.branch}:${remotePath}`
    )
    const result = await provider.upload({
      data: image.data,
      fileName: uploadedFileName,
      remotePath,
      commitMessage: config.commitMessage,
      target,
      existingSha: destination.existingSha
    })
    const url = buildPublicUrl(
      config.publicUrl,
      target.repository,
      target.branch,
      result.remotePath,
      result.downloadUrl
    )
    const uploadedName = nameWithoutExtension(uploadedFileName)
    this.output.appendLine(`Uploaded ${image.name}: ${url}`)
    return {
      originalName: nameWithoutExtension(image.name),
      uploadedName,
      remotePath: result.remotePath,
      sha: result.sha,
      created: destination.created,
      url,
      output: formatOutput(
        config.outputFormat,
        uploadedName,
        nameWithoutExtension(image.name),
        url,
        config.includeImageName
      )
    }
  }

  async readUri(uri: vscode.Uri): Promise<ImageInput> {
    const data = await vscode.workspace.fs.readFile(uri)
    return {
      data,
      name: uri.path.split('/').pop() || 'image',
      mimeType: mimeFromName(uri.path)
    }
  }

  async readPathOrUrl(value: string): Promise<ImageInput> {
    const trimmed = value.trim()
    if (/^https?:\/\//i.test(trimmed)) {
      const response = await fetch(trimmed)
      if (!response.ok) {
        throw new Error(
          `Could not download the image (${response.status} ${response.statusText}).`
        )
      }
      const mimeType = response.headers.get('content-type')?.split(';')[0]
      if (mimeType && !mimeType.startsWith('image/')) {
        throw new Error(`The URL returned ${mimeType}, not an image.`)
      }
      const url = new URL(trimmed)
      return {
        data: new Uint8Array(await response.arrayBuffer()),
        name: url.pathname.split('/').pop() || 'image',
        mimeType: mimeType || mimeFromName(url.pathname)
      }
    }

    const uri = resolveWorkspaceUri(trimmed)
    if (!uri) {
      throw new Error('Open a workspace before uploading a relative path.')
    }
    return this.readUri(uri)
  }

  async verifyConfiguration(token: string): Promise<void> {
    const config = await this.getConfig(false)
    await new GitHubProvider(token).verify(this.targetFromConfig(config))
  }

  async verifyCurrentConfiguration(): Promise<void> {
    await this.verifyConfiguration(await this.credentials.getToken(true))
  }

  async getConfig(promptForRepository: boolean): Promise<GitPasteConfig> {
    const settings = vscode.workspace.getConfiguration('gitpaste')
    let repository = settings.get<string>('github.repository', '').trim()
    if (!repository && promptForRepository) {
      repository =
        (
          await vscode.window.showInputBox({
            title: 'GitPaste: GitHub repository',
            prompt: 'Repository that will store uploaded images.',
            placeHolder: 'owner/repository',
            ignoreFocusOut: true,
            validateInput: validateRepository
          })
        )?.trim() || ''
      if (repository) {
        await settings.update(
          'github.repository',
          repository,
          vscode.workspace.workspaceFolders?.length
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global
        )
      }
    }
    if (!repository) {
      throw new Error('Configure a GitHub repository before uploading.')
    }
    parseRepository(repository)
    const config: GitPasteConfig = {
      repository,
      branch: settings.get<string>('github.branch', 'main').trim() || 'main',
      path: settings.get<string>('github.path', 'images'),
      publicUrl: settings.get<string>('github.publicUrl', ''),
      commitMessage: settings.get<string>(
        'github.commitMessage',
        'Upload ${uploadedName} with GitPaste'
      ),
      conflictStrategy: settings.get<ConflictStrategy>(
        'github.conflictStrategy',
        'rename'
      ),
      fileNameFormat: settings.get<string>(
        'fileNameFormat',
        '${yyyy}-${MM}-${dd}_${HH}-${mm}-${ss}-${random}${extName}'
      ),
      outputFormat: settings.get<string>(
        'outputFormat',
        '![${uploadedName}](${url})'
      ),
      includeImageName: settings.get<boolean>('includeImageName', true),
      maxFileSizeMb: settings.get<number>('maxFileSizeMb', 20)
    }
    validateConfig(config)
    return config
  }

  private targetFromConfig(config: GitPasteConfig): GitHubTarget {
    return { repository: config.repository, branch: config.branch }
  }

  private async promptForConflict(
    remotePath: string
  ): Promise<Exclude<ConflictStrategy, 'prompt'>> {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: 'Rename new image',
          description: 'Keep both files',
          strategy: 'rename' as const
        },
        {
          label: 'Overwrite remote image',
          description: 'Replace the existing file at the same URL',
          strategy: 'overwrite' as const
        }
      ],
      { title: `GitPaste: ${remotePath} already exists`, ignoreFocusOut: true }
    )
    if (!choice) throw new vscode.CancellationError()
    return choice.strategy
  }

  private async chooseFailureAction(
    image: ImageInput,
    error: unknown
  ): Promise<FailureAction['action']> {
    const actions: FailureAction[] = [
      { title: 'Retry', action: 'retry' },
      { title: 'Skip', action: 'skip' },
      { title: 'Stop', action: 'cancel', isCloseAffordance: true }
    ]
    const choice = await vscode.window.showErrorMessage(
      `GitPaste: failed to upload ${image.name}: ${errorMessage(error)}`,
      { modal: true },
      ...actions
    )
    return choice?.action || 'cancel'
  }

  private async offerCleanup(
    provider: GitHubProvider,
    target: GitHubTarget,
    uploaded: readonly UploadedImage[]
  ): Promise<void> {
    const createdImages = cleanupCandidates(uploaded)
    const overwrittenCount = uploaded.length - createdImages.length
    if (!createdImages.length) {
      await vscode.window.showWarningMessage(
        'GitPaste: remote files were overwritten before the operation stopped and cannot be automatically rolled back.'
      )
      return
    }
    const choice = await vscode.window.showWarningMessage(
      `GitPaste: ${createdImages.length} new image${
        createdImages.length === 1 ? '' : 's'
      } were uploaded before the operation stopped.${
        overwrittenCount
          ? ` ${overwrittenCount} overwritten file${
              overwrittenCount === 1 ? '' : 's'
            } cannot be rolled back automatically.`
          : ''
      }`,
      { modal: true },
      'Delete uploaded files',
      'Keep files'
    )
    if (choice === 'Delete uploaded files') {
      await this.deleteImages(provider, target, createdImages)
    }
  }

  private async deleteImages(
    provider: GitHubProvider,
    target: GitHubTarget,
    images: readonly UploadedImage[]
  ): Promise<void> {
    const failures: string[] = []
    for (const image of [...images].reverse()) {
      try {
        const current = await provider.getFile(target, image.remotePath)
        if (!current) continue
        if (!remoteVersionMatchesUpload(image, current.sha)) {
          throw new Error('remote file changed after it was uploaded')
        }
        await provider.delete({
          target,
          remotePath: current.remotePath,
          sha: current.sha,
          commitMessage: `Delete ${current.remotePath} after an incomplete GitPaste operation`
        })
        this.output.appendLine(
          `Deleted ${target.repository}@${target.branch}:${current.remotePath}`
        )
      } catch (error) {
        failures.push(`${image.remotePath}: ${errorMessage(error)}`)
      }
    }
    if (failures.length) {
      throw new Error(
        `Some uploaded files could not be deleted: ${failures.join('; ')}`
      )
    }
  }

  private validateSize(image: ImageInput, maxFileSizeMb: number): void {
    const maximum = maxFileSizeMb * 1024 * 1024
    if (image.data.byteLength > maximum) {
      throw new Error(
        `${image.name} is ${formatBytes(
          image.data.byteLength
        )}; the configured limit is ${maxFileSizeMb} MB.`
      )
    }
  }
}

export function imageFileFilters(): Record<string, string[]> {
  return { Images: [...IMAGE_EXTENSIONS] }
}

export function isSupportedImageName(name: string): boolean {
  const extension = splitFileName(name).extName.slice(1)
  return IMAGE_EXTENSIONS.includes(extension.toLowerCase())
}

function validateRepository(value: string): string | undefined {
  if (!value.trim()) return 'A repository is required.'
  try {
    parseRepository(value)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function resolveWorkspaceUri(value: string): vscode.Uri | undefined {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return vscode.Uri.parse(value)
  }
  const editor = vscode.window.activeTextEditor
  if (editor) {
    return vscode.Uri.joinPath(editor.document.uri, '..', value)
  }
  const folder = vscode.workspace.workspaceFolders?.[0]
  return folder ? vscode.Uri.joinPath(folder.uri, value) : undefined
}

function mimeFromName(name: string): string | undefined {
  const extension = splitFileName(name).extName
  const types: Readonly<Record<string, string>> = {
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.tiff': 'image/tiff',
    '.webp': 'image/webp'
  }
  return types[extension]
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
