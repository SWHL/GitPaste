export interface ImageInput {
  readonly data: Uint8Array
  readonly name: string
  readonly mimeType?: string
}

export interface GitHubTarget {
  readonly repository: string
  readonly branch: string
}

export interface UploadRequest<TTarget> {
  readonly data: Uint8Array
  readonly fileName: string
  readonly remotePath: string
  readonly commitMessage: string
  readonly target: TTarget
}

export interface ProviderUploadResult {
  readonly remotePath: string
  readonly downloadUrl?: string
  readonly sha?: string
}

export interface UploadProvider<TTarget> {
  readonly id: string
  upload(request: UploadRequest<TTarget>): Promise<ProviderUploadResult>
  verify?(target: TTarget): Promise<void>
}

export interface GitPasteConfig {
  readonly repository: string
  readonly branch: string
  readonly path: string
  readonly publicUrl: string
  readonly commitMessage: string
  readonly fileNameFormat: string
  readonly outputFormat: string
  readonly includeImageName: boolean
  readonly maxFileSizeMb: number
}

export interface UploadedImage {
  readonly originalName: string
  readonly uploadedName: string
  readonly remotePath: string
  readonly url: string
  readonly output: string
}

export type TemplateValues = Readonly<Record<string, string | number>>
