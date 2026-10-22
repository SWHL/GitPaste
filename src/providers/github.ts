import { encodeRepoPath, interpolate } from '../naming'
import { parseRepository } from '../public-url'
import { toBase64 } from '../util'
import type {
  DeleteRequest,
  GitHubTarget,
  ProviderFile,
  ProviderUploadResult,
  UploadProvider,
  UploadRequest,
} from '../types'

const API_VERSION = '2022-11-28'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RETRIES = 3
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])

interface GitHubContentResponse {
  content?: {
    download_url?: string
    path?: string
    sha?: string
  }
  download_url?: string
  path?: string
  sha?: string
  message?: string
}

interface GitHubRepositoryResponse {
  permissions?: {
    push?: boolean
  }
  message?: string
}

interface GitHubProviderOptions {
  timeoutMs?: number
  maxRetries?: number
  retryBaseDelayMs?: number
}

interface GitHubResponse<T> {
  response: Response
  payload: T
}

export class GitHubProvider implements UploadProvider<GitHubTarget> {
  readonly id = 'github'

  constructor(
    private readonly token: string,
    private readonly options: GitHubProviderOptions = {},
  ) {}

  async upload(
    request: UploadRequest<GitHubTarget>,
    signal?: AbortSignal,
  ): Promise<ProviderUploadResult> {
    const repo = parseRepository(request.target.repository)
    const endpoint = `https://api.github.com/repos/${encodeURIComponent(
      repo.owner,
    )}/${encodeURIComponent(repo.repository)}/contents/${encodeRepoPath(
      request.remotePath,
    )}`
    const { response, payload } = await this.request<GitHubContentResponse>(
      endpoint,
      {
        method: 'PUT',
        body: JSON.stringify({
          message: interpolate(request.commitMessage, {
            uploadedName: request.fileName,
          }),
          content: toBase64(request.data),
          branch: request.target.branch,
          ...(request.existingSha ? { sha: request.existingSha } : {}),
        }),
      },
      'upload',
      signal,
    )
    if (!response.ok) {
      if (
        response.status === 403 &&
        payload.message === 'Resource not accessible by personal access token'
      ) {
        throw new Error(
          `GitHub upload failed (403): the personal access token cannot write repository contents. ` +
            `For a fine-grained token, include ${request.target.repository} in Repository access and grant ` +
            'Repository permissions > Contents: Read and write. Organization repositories may also require token approval or SSO authorization.' +
            rateLimitSuffix(response),
        )
      }
      throw new Error(
        `GitHub upload failed (${response.status}): ${
          payload.message || response.statusText
        }${rateLimitSuffix(response)}`,
      )
    }
    return {
      remotePath: payload.content?.path || request.remotePath,
      downloadUrl: payload.content?.download_url,
      sha: payload.content?.sha,
    }
  }

  async getFile(
    target: GitHubTarget,
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<ProviderFile | undefined> {
    const { response, payload } = await this.request<GitHubContentResponse>(
      `${this.contentEndpoint(target, remotePath)}?ref=${encodeURIComponent(
        target.branch,
      )}`,
      {},
      'file lookup',
      signal,
    )
    if (response.status === 404) return undefined
    if (!response.ok) {
      throw new Error(
        `GitHub file lookup failed (${response.status}): ${
          payload.message || response.statusText
        }${rateLimitSuffix(response)}`,
      )
    }
    const sha = payload.sha || payload.content?.sha
    if (!sha) {
      throw new Error('GitHub did not return file metadata for this path.')
    }
    return {
      remotePath: payload.path || payload.content?.path || remotePath,
      sha,
    }
  }

  async delete(
    request: DeleteRequest<GitHubTarget>,
    signal?: AbortSignal,
  ): Promise<void> {
    const { response, payload } = await this.request<GitHubContentResponse>(
      this.contentEndpoint(request.target, request.remotePath),
      {
        method: 'DELETE',
        body: JSON.stringify({
          message: request.commitMessage,
          sha: request.sha,
          branch: request.target.branch,
        }),
      },
      'delete',
      signal,
    )
    if (!response.ok) {
      throw new Error(
        `GitHub delete failed (${response.status}): ${
          payload.message || response.statusText
        }${rateLimitSuffix(response)}`,
      )
    }
  }

  async verify(target: GitHubTarget, signal?: AbortSignal): Promise<void> {
    const repo = parseRepository(target.repository)
    const repositoryEndpoint = `https://api.github.com/repos/${encodeURIComponent(
      repo.owner,
    )}/${encodeURIComponent(repo.repository)}`
    const { response: repositoryResponse, payload: repositoryPayload } =
      await this.request<GitHubRepositoryResponse>(
        repositoryEndpoint,
        {},
        'repository access check',
        signal,
      )
    if (!repositoryResponse.ok) {
      throw new Error(
        `Cannot access ${target.repository} (${repositoryResponse.status}): ${
          repositoryPayload.message || repositoryResponse.statusText
        }${rateLimitSuffix(repositoryResponse)}`,
      )
    }
    if (repositoryPayload.permissions?.push !== true) {
      throw new Error(
        `The current GitHub credential does not have write access to ${target.repository}.`,
      )
    }
    const endpoint = `https://api.github.com/repos/${encodeURIComponent(
      repo.owner,
    )}/${encodeURIComponent(repo.repository)}/branches/${encodeURIComponent(
      target.branch,
    )}`
    const { response, payload } = await this.request<GitHubContentResponse>(
      endpoint,
      {},
      'branch access check',
      signal,
    )
    if (!response.ok) {
      throw new Error(
        `Cannot access ${target.repository}@${target.branch} (${response.status}): ${
          payload.message || response.statusText
        }${rateLimitSuffix(response)}`,
      )
    }
  }

  private contentEndpoint(target: GitHubTarget, remotePath: string): string {
    const repo = parseRepository(target.repository)
    return `https://api.github.com/repos/${encodeURIComponent(
      repo.owner,
    )}/${encodeURIComponent(repo.repository)}/contents/${encodeRepoPath(
      remotePath,
    )}`
  }

  private get headers(): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': API_VERSION,
    }
  }

  private async request<T>(
    input: string,
    init: RequestInit,
    operation: string,
    signal?: AbortSignal,
  ): Promise<GitHubResponse<T>> {
    const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController()
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      const onAbort = () => controller.abort(signal?.reason)
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const response = await fetch(input, {
          ...init,
          headers: { ...this.headers, ...init.headers },
          signal: controller.signal,
        })
        const payload = await readJson<T>(response)
        if (response.ok || attempt >= maxRetries || !isRetryable(response)) {
          return { response, payload }
        }
        await delay(this.retryDelay(response, attempt), signal)
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error
        if (timedOut && attempt >= maxRetries) {
          throw new Error(
            `GitHub ${operation} timed out after ${
              this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
            }ms.`,
          )
        }
        if (attempt >= maxRetries || (isAbortError(error) && !timedOut)) {
          throw new Error(
            `GitHub ${operation} failed due to a network error: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
        await delay(this.exponentialDelay(attempt), signal)
      } finally {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', onAbort)
      }
    }
  }

  private retryDelay(response: Response, attempt: number): number {
    const retryAfter = response.headers.get('Retry-After')
    if (retryAfter) {
      const seconds = Number(retryAfter)
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
      const date = Date.parse(retryAfter)
      if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
    }
    return this.exponentialDelay(attempt)
  }

  private exponentialDelay(attempt: number): number {
    return 2 ** attempt * (this.options.retryBaseDelayMs ?? 250)
  }
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T
  } catch {
    return {} as T
  }
}

function isRetryable(response: Response): boolean {
  return (
    RETRYABLE_STATUSES.has(response.status) ||
    (response.status === 403 &&
      (response.headers.get('X-RateLimit-Remaining') === '0' ||
        response.headers.has('Retry-After')))
  )
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' &&
      error instanceof DOMException &&
      error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

function rateLimitSuffix(response: Response): string {
  const remaining = response.headers.get('X-RateLimit-Remaining')
  if (remaining === null) return ''
  const reset = response.headers.get('X-RateLimit-Reset')
  const resetText = reset
    ? `; resets at ${new Date(Number(reset) * 1000).toISOString()}`
    : ''
  return ` (API rate limit remaining: ${remaining}${resetText})`
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}
