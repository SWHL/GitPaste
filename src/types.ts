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
  readonly existingSha?: string
}

export interface DeleteRequest<TTarget> {
  readonly remotePath: string
  readonly sha: string
  readonly commitMessage: string
  readonly target: TTarget
}

export interface ProviderFile {
  readonly remotePath: string
  readonly sha: string
}

export interface ProviderUploadResult {
  readonly remotePath: string
  readonly downloadUrl?: string
  readonly sha?: string
}

export interface UploadProvider<TTarget> {
  readonly id: string
  upload(request: UploadRequest<TTarget>): Promise<ProviderUploadResult>
  getFile?(
    target: TTarget,
    remotePath: string
  ): Promise<ProviderFile | undefined>
  delete?(request: DeleteRequest<TTarget>): Promise<void>
  verify?(target: TTarget): Promise<void>
}

export type ConflictStrategy = 'rename' | 'overwrite' | 'prompt'

export interface GitPasteConfig {
  readonly repository: string
  readonly branch: string
  readonly path: string
  readonly publicUrl: string
  readonly commitMessage: string
  readonly conflictStrategy: ConflictStrategy
  readonly fileNameFormat: string
  readonly outputFormat: string
  readonly includeImageName: boolean
  readonly maxFileSizeMb: number
}

export interface UploadedImage {
  readonly originalName: string
  readonly uploadedName: string
  readonly remotePath: string
  readonly sha?: string
  readonly created?: boolean
  readonly url: string
  readonly output: string
}

export type TemplateValues = Readonly<Record<string, string | number>>
