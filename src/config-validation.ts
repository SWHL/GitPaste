import { formatUploadFileName, joinRepoPath, normalizeRepoPath } from './naming'
import { buildPublicUrl } from './public-url'
import type { GitPasteConfig } from './types'

const CONFLICT_STRATEGIES = ['rename', 'overwrite', 'prompt'] as const

export function validateConfig(config: GitPasteConfig): void {
  normalizeRepoPath(config.path)
  if (!CONFLICT_STRATEGIES.includes(config.conflictStrategy)) {
    throw new Error(
      'The filename conflict strategy must be rename, overwrite, or prompt.'
    )
  }
  if (!config.commitMessage.trim()) {
    throw new Error('The GitHub commit message cannot be empty.')
  }
  if (config.publicUrl && !config.publicUrl.includes('${path}')) {
    throw new Error('The custom public URL template must include ${path}.')
  }
  if (!config.outputFormat.includes('${url}')) {
    throw new Error('The output format must include ${url}.')
  }
  const sampleUrl = buildPublicUrl(
    config.publicUrl,
    config.repository,
    config.branch,
    joinRepoPath(config.path, 'image.png'),
    'https://raw.githubusercontent.com/example/image.png'
  )
  try {
    const parsed = new URL(sampleUrl)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Unsupported URL protocol')
    }
  } catch {
    throw new Error('The public URL template does not produce a valid URL.')
  }
  formatUploadFileName(
    config.fileNameFormat,
    'image.png',
    'image/png',
    'document.md'
  )
}
