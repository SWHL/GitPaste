import { appendFileNameSuffix } from './naming'
import type {
  ConflictStrategy,
  ProviderFile,
  UploadedImage
} from './types'

export interface UploadDestination {
  readonly remotePath: string
  readonly existingSha?: string
  readonly created: boolean
}

export async function resolveUploadDestination(
  remotePath: string,
  strategy: ConflictStrategy,
  getFile: (path: string) => Promise<ProviderFile | undefined>,
  promptForStrategy?: () => Promise<Exclude<ConflictStrategy, 'prompt'>>
): Promise<UploadDestination> {
  const existing = await getFile(remotePath)
  if (!existing) return { remotePath, created: true }

  const resolvedStrategy =
    strategy === 'prompt'
      ? await requireConflictPrompt(promptForStrategy)()
      : strategy
  if (resolvedStrategy === 'overwrite') {
    return {
      remotePath: existing.remotePath,
      existingSha: existing.sha,
      created: false
    }
  }

  for (let counter = 2; counter <= 1000; counter += 1) {
    const candidate = appendFileNameSuffix(remotePath, `-${counter}`)
    if (!(await getFile(candidate))) {
      return { remotePath: candidate, created: true }
    }
  }
  throw new Error(`Could not find an available filename for ${remotePath}.`)
}

export function cleanupCandidates(
  images: readonly UploadedImage[]
): UploadedImage[] {
  return images.filter((image) => image.created !== false)
}

export function remoteVersionMatchesUpload(
  image: UploadedImage,
  currentSha: string
): boolean {
  return !image.sha || image.sha === currentSha
}

function requireConflictPrompt(
  promptForStrategy:
    | (() => Promise<Exclude<ConflictStrategy, 'prompt'>>)
    | undefined
): () => Promise<Exclude<ConflictStrategy, 'prompt'>> {
  if (!promptForStrategy) {
    throw new Error('A conflict prompt is required for the prompt strategy.')
  }
  return promptForStrategy
}
