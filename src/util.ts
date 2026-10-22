// Shared, environment-agnostic helpers used across GitPaste.
// This module must NOT import `vscode` so it can run under `node --test`.

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Formats a byte count using the largest unit that keeps the value readable.
 * Unlike a fixed "MB" format, this avoids showing `0.0 MB` for tiny files.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const kilobytes = bytes / 1024
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`
  const megabytes = kilobytes / 1024
  if (megabytes < 1024) return `${megabytes.toFixed(1)} MB`
  const gigabytes = megabytes / 1024
  return `${gigabytes.toFixed(1)} GB`
}

/**
 * Encodes binary image data as a base64 string for the GitHub contents API.
 *
 * The chunked approach avoids two problems of the naive implementation:
 *  - `String.fromCharCode(...data)` spreads the whole buffer as function
 *    arguments, which throws "Maximum call stack size exceeded" for large
 *    images. Chunking keeps each spread within engine argument limits.
 *  - `binary += chunk` performs an O(n^2) copy of the entire accumulated
 *    string. Pushing into an array and joining once is O(n).
 */
export function toBase64(data: Uint8Array): string {
  const chunkSize = 0x8000
  const chunks: string[] = []
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    chunks.push(
      String.fromCharCode(...data.subarray(offset, offset + chunkSize)),
    )
  }
  return btoa(chunks.join(''))
}

/** Returns the last path segment, or `fallback` when the path is empty. */
export function pathBaseName(path: string, fallback = 'document'): string {
  return path.split('/').pop() || fallback
}

/**
 * Cheap, stable 32-bit FNV-1a hash of a byte buffer. Used for de-duplication
 * keys so we never have to stringify the entire image in memory.
 */
export function contentHash(data: Uint8Array): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < data.length; index += 1) {
    hash ^= data[index]
    hash = Math.imul(hash, 0x01000193)
  }
  return hash.toString(16)
}

/**
 * Reads Content-Length from a HEAD request before downloading a URL image, so
 * an oversized upload can be rejected without streaming the whole body.
 *
 * Returns the byte length when the server reports it on a successful HEAD;
 * otherwise `undefined` (HEAD unsupported, blocked, returns a 4xx/5xx, or
 * omits the header) so the caller falls back to a GET and re-checks. Network
 * errors never propagate — preflight is only an optimization and must not block
 * the real download.
 */
export async function preflightContentLength(
  url: string,
): Promise<number | undefined> {
  try {
    const response = await fetch(url, { method: 'HEAD' })
    if (!response.ok) return undefined
    const header = response.headers.get('content-length')
    if (!header) return undefined
    const value = Number(header)
    return Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

export interface DedupImage {
  readonly data: Uint8Array
  readonly name: string
  readonly mimeType?: string
}

/**
 * Builds a key that identifies an image so duplicate drops/flies are skipped.
 * Combines the source (URI or file name), byte length, and a content hash so
 * identical bytes are recognized without serializing the whole buffer.
 */
export function dedupKey(image: DedupImage, uri?: string): string {
  const source = uri ?? image.name
  return `${source}:${image.data.length}:${contentHash(image.data)}`
}

/**
 * Maps `items` through `worker` while running at most `limit` of them
 * concurrently. Results are returned in the original order. If any worker
 * rejects, the first rejection is re-thrown after every runner has settled, so
 * the call never produces an unhandled rejection from a sibling that fails
 * later. A failing worker stops only its own runner; the shared cursor keeps
 * the others busy until they finish or also fail.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const safeLimit = Math.max(1, Math.min(limit, items.length))
  const results: R[] = new Array(items.length)
  const errors: unknown[] = []
  let cursor = 0
  const runners = Array.from({ length: safeLimit }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      try {
        results[index] = await worker(items[index], index)
      } catch (error) {
        errors.push(error)
        throw error
      }
    }
  })
  await Promise.all(runners.map((runner) => runner.catch(() => {})))
  if (errors.length) throw errors[0]
  return results
}
