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

export function buildPublicUrl(
  template: string,
  repository: string,
  branch: string,
  remotePath: string,
  fallbackUrl?: string
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
    path: encodeRepoPath(remotePath)
  })
}

export function formatOutput(
  template: string,
  uploadedName: string,
  originalName: string,
  url: string,
  includeImageName = true
): string {
  return interpolate(template, {
    uploadedName: includeImageName ? uploadedName : '',
    originalName,
    url
  })
}
