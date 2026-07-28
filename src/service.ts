import * as vscode from 'vscode'
import { Credentials } from './credentials'
import {
  formatUploadFileName,
  joinRepoPath,
  nameWithoutExtension,
  splitFileName
} from './naming'
import { formatOutput, buildPublicUrl, parseRepository } from './public-url'
import { GitHubProvider } from './providers/github'
import type {
  GitPasteConfig,
  GitHubTarget,
  ImageInput,
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
            throw new vscode.CancellationError()
          }
          this.validateSize(image, config.maxFileSizeMb)
          progress.report({ message: image.name })

          const fileName = formatUploadFileName(
            config.fileNameFormat,
            image.name,
            image.mimeType,
            documentName
          )
          const remotePath = joinRepoPath(config.path, fileName)
          this.output.appendLine(
            `Uploading ${image.name} to ${target.repository}@${target.branch}:${remotePath}`
          )
          const result = await provider.upload({
            data: image.data,
            fileName,
            remotePath,
            commitMessage: config.commitMessage,
            target
          })
          const url = buildPublicUrl(
            config.publicUrl,
            target.repository,
            target.branch,
            result.remotePath,
            result.downloadUrl
          )
          const uploadedName = nameWithoutExtension(fileName)
          uploaded.push({
            originalName: nameWithoutExtension(image.name),
            uploadedName,
            remotePath: result.remotePath,
            url,
            output: formatOutput(
              config.outputFormat,
              uploadedName,
              nameWithoutExtension(image.name),
              url
            )
          })
          this.output.appendLine(`Uploaded ${image.name}: ${url}`)
          progress.report({
            message: index === images.length - 1 ? 'Done' : image.name,
            increment: 100 / images.length
          })
        }
        return uploaded
      }
    )
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
    await new GitHubProvider(token).verify?.({
      repository: config.repository,
      branch: config.branch
    })
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
          vscode.ConfigurationTarget.Global
        )
      }
    }
    if (!repository) {
      throw new Error('Configure a GitHub repository before uploading.')
    }
    parseRepository(repository)
    return {
      repository,
      branch: settings.get<string>('github.branch', 'main').trim() || 'main',
      path: settings.get<string>('github.path', 'images'),
      publicUrl: settings.get<string>('github.publicUrl', ''),
      commitMessage: settings.get<string>(
        'github.commitMessage',
        'Upload ${uploadedName} with GitPaste'
      ),
      fileNameFormat: settings.get<string>(
        'fileNameFormat',
        '${yyyy}-${MM}-${dd}_${HH}-${mm}-${ss}-${random}${extName}'
      ),
      outputFormat: settings.get<string>(
        'outputFormat',
        '![${uploadedName}](${url})'
      ),
      maxFileSizeMb: settings.get<number>('maxFileSizeMb', 20)
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
