import { encodeRepoPath, interpolate } from '../naming'
import { parseRepository } from '../public-url'
import type {
  GitHubTarget,
  ProviderUploadResult,
  UploadProvider,
  UploadRequest
} from '../types'

const API_VERSION = '2022-11-28'

interface GitHubContentResponse {
  content?: {
    download_url?: string
    path?: string
    sha?: string
  }
  message?: string
}

export class GitHubProvider implements UploadProvider<GitHubTarget> {
  readonly id = 'github'

  constructor(private readonly token: string) {}

  async upload(
    request: UploadRequest<GitHubTarget>
  ): Promise<ProviderUploadResult> {
    const repo = parseRepository(request.target.repository)
    const endpoint = `https://api.github.com/repos/${encodeURIComponent(
      repo.owner
    )}/${encodeURIComponent(repo.repository)}/contents/${encodeRepoPath(
      request.remotePath
    )}`
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({
        message: interpolate(request.commitMessage, {
          uploadedName: request.fileName
        }),
        content: toBase64(request.data),
        branch: request.target.branch
      })
    })
    const payload = (await response.json()) as GitHubContentResponse
    if (!response.ok) {
      if (
        response.status === 403 &&
        payload.message === 'Resource not accessible by personal access token'
      ) {
        throw new Error(
          `GitHub upload failed (403): the personal access token cannot write repository contents. ` +
            `For a fine-grained token, include ${request.target.repository} in Repository access and grant ` +
            'Repository permissions > Contents: Read and write. Organization repositories may also require token approval or SSO authorization.'
        )
      }
      throw new Error(
        `GitHub upload failed (${response.status}): ${
          payload.message || response.statusText
        }`
      )
    }
    return {
      remotePath: payload.content?.path || request.remotePath,
      downloadUrl: payload.content?.download_url,
      sha: payload.content?.sha
    }
  }

  async verify(target: GitHubTarget): Promise<void> {
    const repo = parseRepository(target.repository)
    const endpoint = `https://api.github.com/repos/${encodeURIComponent(
      repo.owner
    )}/${encodeURIComponent(repo.repository)}/branches/${encodeURIComponent(
      target.branch
    )}`
    const response = await fetch(endpoint, { headers: this.headers })
    if (!response.ok) {
      const payload = (await response.json()) as GitHubContentResponse
      throw new Error(
        `Cannot access ${target.repository}@${target.branch} (${response.status}): ${
          payload.message || response.statusText
        }`
      )
    }
  }

  private get headers(): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': API_VERSION
    }
  }
}

function toBase64(data: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}
