import { formatUploadFileName, joinRepoPath, normalizeRepoPath } from './naming'
import { buildPublicUrl } from './public-url'
import type { GitPasteConfig } from './types'

const CONFLICT_STRATEGIES = ['rename', 'overwrite', 'prompt'] as const
const FILE_NAME_STRATEGIES = ['timestamp', 'hash'] as const

export function validateConfig(config: GitPasteConfig): void {
  normalizeRepoPath(config.path)
  if (!CONFLICT_STRATEGIES.includes(config.conflictStrategy)) {
    throw new Error(
      'The filename conflict strategy must be rename, overwrite, or prompt.',
    )
  }
  if (!FILE_NAME_STRATEGIES.includes(config.fileNameStrategy)) {
    throw new Error('The filename strategy must be timestamp or hash.')
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
  if (
    typeof config.maxFileSizeMb !== 'number' ||
    config.maxFileSizeMb < 1 ||
    config.maxFileSizeMb > 100
  ) {
    throw new Error('The maximum image size must be between 1 and 100 MB.')
  }
  const sampleUrl = buildPublicUrl(
    config.publicUrl,
    config.repository,
    config.branch,
    joinRepoPath(config.path, 'image.png'),
    'https://raw.githubusercontent.com/example/image.png',
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
    'document.md',
  )
}
