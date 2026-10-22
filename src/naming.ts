import type { TemplateValues } from './types'

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/tiff': '.tiff',
  'image/webp': '.webp',
  'image/x-icon': '.ico',
}

export function interpolate(template: string, values: TemplateValues): string {
  return template.replace(/\$\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, key) => {
    const value = values[key]
    return value === undefined ? match : String(value)
  })
}

export function splitFileName(fileName: string): {
  name: string
  extName: string
} {
  const cleanName = fileName.split(/[?#]/, 1)[0].split('/').pop() || 'image'
  const extensionIndex = cleanName.lastIndexOf('.')
  if (extensionIndex <= 0) {
    return { name: cleanName, extName: '' }
  }
  return {
    name: cleanName.slice(0, extensionIndex),
    extName: cleanName.slice(extensionIndex).toLowerCase(),
  }
}

export function extensionForMime(mimeType?: string): string {
  if (!mimeType) return ''
  return MIME_EXTENSIONS[mimeType.toLowerCase()] || ''
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    data as BufferSource,
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

export function formatHashRemotePath(
  basePath: string,
  hash: string,
  originalName: string,
  mimeType?: string,
): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(
      'The SHA-256 hash must be a 64-character hexadecimal string.',
    )
  }
  const original = splitFileName(originalName)
  const extension = extensionForMime(mimeType) || original.extName || '.png'
  return joinRepoPath(
    basePath,
    hash.slice(0, 2),
    hash.slice(2, 4),
    `${hash}${extension}`,
  )
}

export function formatUploadFileName(
  template: string,
  originalName: string,
  mimeType: string | undefined,
  documentName: string,
  now = new Date(),
  random = randomString(),
): string {
  const original = splitFileName(originalName)
  const extName = original.extName || extensionForMime(mimeType) || '.png'
  const values: TemplateValues = {
    name: sanitizeSegment(original.name) || 'image',
    extName,
    timestamp: now.getTime(),
    random,
    yyyy: now.getFullYear(),
    MM: pad(now.getMonth() + 1),
    dd: pad(now.getDate()),
    HH: pad(now.getHours()),
    mm: pad(now.getMinutes()),
    ss: pad(now.getSeconds()),
    document: sanitizeSegment(documentName),
  }
  const rendered = sanitizeSegment(interpolate(template, values))
  if (!rendered) {
    throw new Error('The filename template produced an empty filename.')
  }
  return rendered.toLowerCase().endsWith(extName.toLowerCase())
    ? rendered
    : `${rendered}${extName}`
}

export function sanitizeSegment(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
  )
}

export function normalizeRepoPath(value: string): string {
  const segments = value.replace(/\\/g, '/').split('/')
  if (segments.some((segment) => segment === '..')) {
    throw new Error('Repository paths cannot contain ".." segments.')
  }
  return segments.filter((segment) => segment && segment !== '.').join('/')
}

export function joinRepoPath(...parts: string[]): string {
  return normalizeRepoPath(parts.filter(Boolean).join('/'))
}

export function encodeRepoPath(path: string): string {
  return normalizeRepoPath(path)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

export function nameWithoutExtension(fileName: string): string {
  return splitFileName(fileName).name
}

export function appendFileNameSuffix(path: string, suffix: string): string {
  const slashIndex = path.lastIndexOf('/')
  const directory = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : ''
  const fileName = slashIndex >= 0 ? path.slice(slashIndex + 1) : path
  const { name, extName } = splitFileName(fileName)
  return `${directory}${name}${suffix}${extName}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function randomString(): string {
  const bytes = new Uint8Array(4)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}
