import { encodeRepoPath, interpolate } from './naming'

export function parseRepository(repository: string): {
  owner: string
  repository: string
} {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repository.trim())
  if (!match) {
    throw new Error('GitHub repository must use the owner/repository format.')
  }
  return { owner: match[1], repository: match[2] }
}

/** Builds a `raw.githubusercontent.com` URL for a committed file. */
export function rawGitHubUrl(
  repository: string,
  branch: string,
  remotePath: string,
): string {
  const parsed = parseRepository(repository)
  return `https://raw.githubusercontent.com/${encodeURIComponent(
    parsed.owner,
  )}/${encodeURIComponent(parsed.repository)}/${encodeRepoPath(
    branch,
  )}/${encodeRepoPath(remotePath)}`
}

export function buildPublicUrl(
  template: string,
  repository: string,
  branch: string,
  remotePath: string,
  fallbackUrl?: string,
): string {
  if (!template.trim()) {
    if (!fallbackUrl) {
      throw new Error('GitHub did not return a public download URL.')
    }
    return fallbackUrl
  }

  const repo = parseRepository(repository)
  return interpolate(template, {
    owner: repo.owner,
    repository: repo.repository,
    branch,
    path: encodeRepoPath(remotePath),
  })
}

export function formatOutput(
  template: string,
  uploadedName: string,
  originalName: string,
  url: string,
  includeImageName = true,
): string {
  return interpolate(template, {
    uploadedName: includeImageName ? uploadedName : '',
    originalName,
    url,
  })
}

export function remotePathFromPublicUrl(
  template: string,
  repository: string,
  branch: string,
  publicUrl: string,
): string | undefined {
  const marker = '__GITPASTE_REMOTE_PATH__'
  let rendered: string
  if (template.trim()) {
    if (!template.includes('${path}')) return undefined
    rendered = buildPublicUrl(template, repository, branch, marker)
  } else {
    rendered = rawGitHubUrl(repository, branch, marker)
  }

  const markerIndex = rendered.indexOf(marker)
  const prefix = rendered.slice(0, markerIndex)
  const suffix = rendered.slice(markerIndex + marker.length)
  if (!publicUrl.startsWith(prefix) || !publicUrl.endsWith(suffix)) {
    return undefined
  }
  const encodedPath = publicUrl.slice(
    prefix.length,
    suffix ? -suffix.length : undefined,
  )
  if (!encodedPath) return undefined
  try {
    return encodedPath
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/')
  } catch {
    return undefined
  }
}
