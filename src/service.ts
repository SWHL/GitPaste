import * as vscode from 'vscode'
import { Credentials } from './credentials'
import {
  formatHashRemotePath,
  formatUploadFileName,
  joinRepoPath,
  nameWithoutExtension,
  normalizeRepoPath,
  sha256Hex,
  splitFileName,
} from './naming'
import {
  formatOutput,
  buildPublicUrl,
  parseRepository,
  rawGitHubUrl,
  remotePathFromPublicUrl,
} from './public-url'
import { validateConfig } from './config-validation'
import { GitHubProvider } from './providers/github'
import {
  cleanupCandidates,
  remoteVersionMatchesUpload,
  resolveUploadDestination,
} from './upload-policy'
import type {
  GitPasteConfig,
  GitHubTarget,
  ImageInput,
  ConflictStrategy,
  FileNameStrategy,
  UploadedImage,
} from './types'
import {
  errorMessage,
  formatBytes,
  mapWithConcurrency,
  pathBaseName,
  preflightContentLength,
} from './util'

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
  'webp',
]

const UPLOAD_CONCURRENCY = 3

/**
 * Maximum number of times the user may retry a failed batch before GitPaste
 * gives up and reports the failures instead of looping indefinitely.
 */
const MAX_BATCH_RETRIES = 3

/**
 * Combines one or more VS Code cancellation tokens into a single `AbortSignal`
 * so the underlying `fetch` calls are actually aborted when the user cancels an
 * upload or the progress notification is dismissed.
 */
function abortSignalFromTokens(
  ...tokens: vscode.CancellationToken[]
): AbortSignal {
  const controller = new AbortController()
  for (const token of tokens) {
    if (token.isCancellationRequested) {
      controller.abort()
      break
    }
    token.onCancellationRequested(() => controller.abort())
  }
  return controller.signal
}

function isUploadedImage(
  value: UploadedImage | undefined,
): value is UploadedImage {
  return value !== undefined
}

function describeBatchFailure(
  failures: ReadonlyArray<{
    item: { image: ImageInput; index: number }
    error: unknown
  }>,
): string {
  const names = failures
    .slice(0, 3)
    .map((failure) => failure.item.image.name)
    .join(', ')
  const overflow = failures.length > 3 ? ` and ${failures.length - 3} more` : ''
  return `Failed to upload ${failures.length} image(s) after ${MAX_BATCH_RETRIES} retries: ${names}${overflow}. ${errorMessage(failures[0].error)}`
}

export class GitPasteService {
  constructor(
    private readonly credentials: Credentials,
    private readonly output: vscode.OutputChannel,
  ) {}

  async uploadImages(
    images: readonly ImageInput[],
    documentName: string,
    token: vscode.CancellationToken,
  ): Promise<UploadedImage[]> {
    if (!images.length) return []
    const config = await this.getConfig(true)
    const accessToken = await this.credentials.getToken(
      true,
      this.verifyConfiguration.bind(this),
    )
    const provider = new GitHubProvider(accessToken)
    const target: GitHubTarget = {
      repository: config.repository,
      branch: config.branch,
    }

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `GitPaste: uploading ${images.length} image${
          images.length === 1 ? '' : 's'
        }`,
        cancellable: true,
      },
      async (progress, progressToken) => {
        // Indexed results keep the result order aligned with `images` so that
        // callers can match each uploaded image to its placeholder/range. A
        // plain `push` would sort by completion order, which diverges from the
        // input order once uploads run concurrently.
        const results: (UploadedImage | undefined)[] = new Array(images.length)
        // `pending` holds the images that still need an attempt. A failed batch
        // is retried as a whole (or skipped / stopped) through a single prompt.
        let pending = images.map((image, index) => ({ image, index }))
        let batchRetries = 0

        try {
          while (pending.length) {
            if (
              token.isCancellationRequested ||
              progressToken.isCancellationRequested
            ) {
              throw new vscode.CancellationError()
            }
            const failures: {
              item: { image: ImageInput; index: number }
              error: unknown
            }[] = []
            await mapWithConcurrency(
              pending,
              UPLOAD_CONCURRENCY,
              async (item) => {
                if (
                  token.isCancellationRequested ||
                  progressToken.isCancellationRequested
                ) {
                  throw new vscode.CancellationError()
                }
                progress.report({ message: `Uploading ${item.image.name}` })
                try {
                  results[item.index] = await this.uploadImage(
                    provider,
                    target,
                    config,
                    item.image,
                    documentName,
                    abortSignalFromTokens(token, progressToken),
                  )
                } catch (error) {
                  if (error instanceof vscode.CancellationError) throw error
                  failures.push({ item, error })
                }
              },
            )
            if (!failures.length) break

            if (batchRetries >= MAX_BATCH_RETRIES) {
              await this.cleanupCreated(results, provider, target)
              throw new Error(describeBatchFailure(failures))
            }
            const action = await this.chooseBatchFailureAction(
              failures,
              token,
              progressToken,
            )
            if (action === 'retry') {
              batchRetries += 1
              pending = failures.map((failure) => failure.item)
              continue
            }
            if (action === 'skip') break
            throw new vscode.CancellationError()
          }
        } catch (error) {
          // A user cancellation (or a Stop) leaves any already-created remote
          // files behind, so roll them back before surfacing the cancellation.
          if (error instanceof vscode.CancellationError) {
            await this.cleanupCreated(results, provider, target)
          }
          throw error
        }

        const uploaded = results.filter(isUploadedImage)
        if (uploaded.length < images.length) {
          void vscode.window.showWarningMessage(
            `GitPaste: uploaded ${uploaded.length} of ${images.length} images.`,
          )
        }
        // Every image failed and the user chose to skip (or nothing was ever
        // created). Report this instead of swallowing it as a cancellation.
        if (!uploaded.length) {
          throw new Error('No images were uploaded.')
        }
        return uploaded
      },
    )
  }

  /**
   * Presents a single prompt for an entire failed batch instead of one dialog
   * per image, so a batch of concurrent failures does not flood the user with
   * stacked modal dialogs.
   */
  private async chooseBatchFailureAction(
    failures: ReadonlyArray<{
      item: { image: ImageInput; index: number }
      error: unknown
    }>,
    token: vscode.CancellationToken,
    progressToken: vscode.CancellationToken,
  ): Promise<'retry' | 'skip' | 'stop'> {
    if (
      token.isCancellationRequested ||
      progressToken.isCancellationRequested
    ) {
      return 'stop'
    }
    const names = failures.map((failure) => failure.item.image.name).join(', ')
    const firstError = errorMessage(failures[0].error)
    const choice = await vscode.window.showErrorMessage(
      `GitPaste: failed to upload ${failures.length} image(s) (${names}). ${firstError}`,
      { modal: true },
      { title: 'Retry all', action: 'retry' },
      { title: 'Skip failed', action: 'skip' },
      { title: 'Stop', action: 'stop', isCloseAffordance: true },
    )
    if (!choice) return 'stop'
    return (choice as { action: 'retry' | 'skip' | 'stop' }).action
  }

  /**
   * Rolls back every remote file that this operation created. Used when an
   * upload is stopped or cancelled after some images already landed.
   */
  private async cleanupCreated(
    results: ReadonlyArray<UploadedImage | undefined>,
    provider: GitHubProvider,
    target: GitHubTarget,
  ): Promise<void> {
    const created = cleanupCandidates(results.filter(isUploadedImage))
    if (created.length) {
      await this.offerCleanup(provider, target, created)
    }
  }

  async deleteUploadedImages(
    images: readonly UploadedImage[],
    token?: vscode.CancellationToken,
  ): Promise<void> {
    const createdImages = cleanupCandidates(images)
    if (!createdImages.length) {
      throw new Error(
        'Overwritten remote files cannot be automatically rolled back.',
      )
    }
    const config = await this.getConfig(false)
    const target = this.targetFromConfig(config)
    const provider = new GitHubProvider(
      await this.credentials.getToken(
        true,
        this.verifyConfiguration.bind(this),
      ),
    )
    await this.deleteImages(
      provider,
      target,
      createdImages,
      token ? abortSignalFromTokens(token) : undefined,
    )
  }

  async deleteRemotePath(
    remotePath: string,
    token?: vscode.CancellationToken,
  ): Promise<void> {
    const config = await this.getConfig(false)
    const target = this.targetFromConfig(config)
    const provider = new GitHubProvider(
      await this.credentials.getToken(
        true,
        this.verifyConfiguration.bind(this),
      ),
    )
    const abortSignal = token ? abortSignalFromTokens(token) : undefined
    const current = await provider.getFile(target, remotePath, abortSignal)
    if (!current) {
      throw new Error(`Remote image no longer exists: ${remotePath}`)
    }
    await provider.delete(
      {
        target,
        remotePath: current.remotePath,
        sha: current.sha,
        commitMessage: `Delete ${current.remotePath} with GitPaste`,
      },
      abortSignal,
    )
    this.output.appendLine(
      `Deleted ${target.repository}@${target.branch}:${remotePath}`,
    )
  }

  async remotePathForUrl(url: string): Promise<string | undefined> {
    const config = await this.getConfig(false)
    const mapped = remotePathFromPublicUrl(
      config.publicUrl,
      config.repository,
      config.branch,
      url,
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
    documentName: string,
    signal?: AbortSignal,
  ): Promise<UploadedImage> {
    this.validateSize(image, config.maxFileSizeMb)
    const hashMode = config.fileNameStrategy === 'hash'
    const hash = hashMode ? await sha256Hex(image.data) : undefined
    const fileName = formatUploadFileName(
      config.fileNameFormat,
      image.name,
      image.mimeType,
      documentName,
    )
    const requestedPath = hashMode
      ? formatHashRemotePath(config.path, hash!, image.name, image.mimeType)
      : joinRepoPath(config.path, fileName)
    const existing = hashMode
      ? await provider.getFile(target, requestedPath, signal)
      : undefined
    if (hashMode && existing) {
      const url = buildPublicUrl(
        config.publicUrl,
        target.repository,
        target.branch,
        existing.remotePath,
        rawGitHubUrl(target.repository, target.branch, existing.remotePath),
      )
      const uploadedName = nameWithoutExtension(image.name)
      this.output.appendLine(`Reused ${image.name}: ${url}`)
      return {
        originalName: uploadedName,
        uploadedName,
        remotePath: existing.remotePath,
        sha: existing.sha,
        created: false,
        url,
        output: formatOutput(
          config.outputFormat,
          uploadedName,
          uploadedName,
          url,
          config.includeImageName,
        ),
      }
    }
    const destination = hashMode
      ? { remotePath: requestedPath, created: true }
      : await resolveUploadDestination(
          requestedPath,
          config.conflictStrategy,
          (remotePath) => provider.getFile(target, remotePath, signal),
          () => this.promptForConflict(requestedPath),
        )
    const remotePath = destination.remotePath

    const uploadedFileName = remotePath.split('/').pop() || fileName
    this.output.appendLine(
      `Uploading ${image.name} to ${target.repository}@${target.branch}:${remotePath}`,
    )
    const result = await provider.upload(
      {
        data: image.data,
        fileName: uploadedFileName,
        remotePath,
        commitMessage: config.commitMessage,
        target,
        existingSha: destination.existingSha,
      },
      signal,
    )
    const url = buildPublicUrl(
      config.publicUrl,
      target.repository,
      target.branch,
      result.remotePath,
      result.downloadUrl,
    )
    const uploadedName = hashMode
      ? nameWithoutExtension(image.name)
      : nameWithoutExtension(uploadedFileName)
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
        config.includeImageName,
      ),
    }
  }

  async readUri(uri: vscode.Uri): Promise<ImageInput> {
    const data = await vscode.workspace.fs.readFile(uri)
    return {
      data,
      name: pathBaseName(uri.path, 'image'),
      mimeType: mimeFromName(uri.path),
    }
  }

  async readPathOrUrl(
    value: string,
    documentUri?: vscode.Uri,
  ): Promise<ImageInput> {
    const trimmed = value.trim()
    if (/^https?:\/\//i.test(trimmed)) {
      const url = new URL(trimmed)
      const name = pathBaseName(url.pathname, 'image')
      const maxFileSizeMb = vscode.workspace
        .getConfiguration('gitpaste')
        .get<number>('maxFileSizeMb', 20)
      const maxBytes = maxFileSizeMb * 1024 * 1024

      // Preflight: reject oversized images on a HEAD request before streaming
      // the whole body. A missing/incorrect header falls through to the GET
      // path, which still re-checks below.
      const preflightBytes = await preflightContentLength(trimmed)
      if (preflightBytes !== undefined && preflightBytes > maxBytes) {
        throw new Error(
          `${name} is ${formatBytes(
            preflightBytes,
          )}; the configured limit is ${maxFileSizeMb} MB.`,
        )
      }

      const response = await fetch(trimmed)
      if (!response.ok) {
        throw new Error(
          `Could not download the image (${response.status} ${response.statusText}).`,
        )
      }
      const contentLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error(
          `${name} is ${formatBytes(contentLength)}; the configured limit is ${maxFileSizeMb} MB.`,
        )
      }
      const mimeType = response.headers.get('content-type')?.split(';')[0]
      if (mimeType && !mimeType.startsWith('image/')) {
        throw new Error(`The URL returned ${mimeType}, not an image.`)
      }
      return {
        data: new Uint8Array(await response.arrayBuffer()),
        name,
        mimeType: mimeType || mimeFromName(url.pathname),
      }
    }

    const uri = resolveWorkspaceUri(trimmed, documentUri)
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
    await this.verifyConfiguration(
      await this.credentials.getToken(
        true,
        this.verifyConfiguration.bind(this),
      ),
    )
  }

  /**
   * Reads the current GitPaste configuration without prompting or writing
   * anything. Throws when no repository is configured.
   */
  private readConfig(): GitPasteConfig {
    const settings = vscode.workspace.getConfiguration('gitpaste')
    const repository = settings.get<string>('github.repository', '').trim()
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
        'Upload ${uploadedName} with GitPaste',
      ),
      conflictStrategy: settings.get<ConflictStrategy>(
        'github.conflictStrategy',
        'rename',
      ),
      fileNameFormat: settings.get<string>(
        'fileNameFormat',
        '${yyyy}-${MM}-${dd}_${HH}-${mm}-${ss}-${random}${extName}',
      ),
      fileNameStrategy: settings.get<FileNameStrategy>(
        'fileNameStrategy',
        'timestamp',
      ),
      outputFormat: settings.get<string>(
        'outputFormat',
        '![${uploadedName}](${url})',
      ),
      includeImageName: settings.get<boolean>('includeImageName', true),
      maxFileSizeMb: settings.get<number>('maxFileSizeMb', 20),
    }
    validateConfig(config)
    return config
  }

  /**
   * Prompts for and persists the GitHub repository when it is not yet
   * configured. No-op when a repository is already set.
   */
  private async ensureRepository(): Promise<void> {
    const settings = vscode.workspace.getConfiguration('gitpaste')
    const repository = settings.get<string>('github.repository', '').trim()
    if (repository) return
    const prompted = (
      await vscode.window.showInputBox({
        title: 'GitPaste: GitHub repository',
        prompt: 'Repository that will store uploaded images.',
        placeHolder: 'owner/repository',
        ignoreFocusOut: true,
        validateInput: validateRepository,
      })
    )?.trim()
    if (!prompted) return
    await settings.update(
      'github.repository',
      prompted,
      vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global,
    )
  }

  async getConfig(promptForRepository: boolean): Promise<GitPasteConfig> {
    if (promptForRepository) {
      await this.ensureRepository()
    }
    return this.readConfig()
  }

  private targetFromConfig(config: GitPasteConfig): GitHubTarget {
    return { repository: config.repository, branch: config.branch }
  }

  private async promptForConflict(
    remotePath: string,
  ): Promise<Exclude<ConflictStrategy, 'prompt'>> {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: 'Rename new image',
          description: 'Keep both files',
          strategy: 'rename' as const,
        },
        {
          label: 'Overwrite remote image',
          description: 'Replace the existing file at the same URL',
          strategy: 'overwrite' as const,
        },
      ],
      { title: `GitPaste: ${remotePath} already exists`, ignoreFocusOut: true },
    )
    if (!choice) throw new vscode.CancellationError()
    return choice.strategy
  }

  private async offerCleanup(
    provider: GitHubProvider,
    target: GitHubTarget,
    uploaded: readonly UploadedImage[],
  ): Promise<void> {
    const createdImages = cleanupCandidates(uploaded)
    const overwrittenCount = uploaded.length - createdImages.length
    if (!createdImages.length) {
      await vscode.window.showWarningMessage(
        'GitPaste: remote files were overwritten before the operation stopped and cannot be automatically rolled back.',
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
      'Keep files',
    )
    if (choice === 'Delete uploaded files') {
      await this.deleteImages(provider, target, createdImages)
    }
  }

  private async deleteImages(
    provider: GitHubProvider,
    target: GitHubTarget,
    images: readonly UploadedImage[],
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const failures: string[] = []
    for (const image of [...images].reverse()) {
      try {
        const current = await provider.getFile(
          target,
          image.remotePath,
          abortSignal,
        )
        if (!current) continue
        if (!remoteVersionMatchesUpload(image, current.sha)) {
          throw new Error('remote file changed after it was uploaded')
        }
        await provider.delete(
          {
            target,
            remotePath: current.remotePath,
            sha: current.sha,
            commitMessage: `Delete ${current.remotePath} after an incomplete GitPaste operation`,
          },
          abortSignal,
        )
        this.output.appendLine(
          `Deleted ${target.repository}@${target.branch}:${current.remotePath}`,
        )
      } catch (error) {
        failures.push(`${image.remotePath}: ${errorMessage(error)}`)
      }
    }
    if (failures.length) {
      throw new Error(
        `Some uploaded files could not be deleted: ${failures.join('; ')}`,
      )
    }
  }

  private validateSize(image: ImageInput, maxFileSizeMb: number): void {
    const maximum = maxFileSizeMb * 1024 * 1024
    if (image.data.byteLength > maximum) {
      throw new Error(
        `${image.name} is ${formatBytes(
          image.data.byteLength,
        )}; the configured limit is ${maxFileSizeMb} MB.`,
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

function resolveWorkspaceUri(
  value: string,
  documentUri?: vscode.Uri,
): vscode.Uri | undefined {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return vscode.Uri.parse(value)
  }
  if (documentUri) return vscode.Uri.joinPath(documentUri, '..', value)
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
    '.webp': 'image/webp',
  }
  return types[extension]
}
