import * as vscode from 'vscode'
import { GitPasteService } from './service'
import type { MarkdownImage } from './markdown-image'
import { TrackedDocumentRange } from './tracked-document-range'
import type { ImageInput, UploadedImage } from './types'

const pasteKind = vscode.DocumentDropOrPasteEditKind.Empty.append(
  'markdown',
  'image',
  'gitpaste'
)
const DEFAULT_REPLACEMENT_TIMEOUT_MS = 60_000
const DEFAULT_EDIT_APPLICATION_TIMEOUT_MS = 10_000

export const pasteDocumentSelector: vscode.DocumentSelector = [
  'markdown',
  'mdx'
]
export const pasteGuardDocumentSelector: vscode.DocumentSelector = [
  { language: '*' }
]

export class GitPastePasteGuard implements vscode.DocumentPasteEditProvider {
  async provideDocumentPasteEdits(
    document: vscode.TextDocument,
    _ranges: readonly vscode.Range[],
    dataTransfer: vscode.DataTransfer,
    _context: vscode.DocumentPasteEditContext,
    _token: vscode.CancellationToken
  ): Promise<vscode.DocumentPasteEdit[] | undefined> {
    if (vscode.languages.match(pasteDocumentSelector, document) > 0) {
      return undefined
    }
    for (const [mimeType] of dataTransfer) {
      if (!mimeType.toLowerCase().startsWith('image/')) continue
      void vscode.window
        .showWarningMessage(
          'GitPaste: image pasting is only supported in Markdown or MDX files.',
          'Change language mode'
        )
        .then((choice) => {
          if (choice === 'Change language mode') {
            void vscode.commands.executeCommand(
              'workbench.action.editor.changeLanguageMode'
            )
          }
        })
      return [
        new vscode.DocumentPasteEdit(
          '',
          'GitPaste: image paste requires Markdown or MDX',
          pasteKind
        )
      ]
    }
    return undefined
  }
}

interface PendingReplacement {
  readonly document: vscode.TextDocument
  readonly image: MarkdownImage
  readonly range: TrackedDocumentRange
}

type ReplacementState =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'valid'; readonly replacement: PendingReplacement }

interface ReplacementCallbacks {
  readonly applied: (
    oldUrl: string,
    uploaded: UploadedImage
  ) => Promise<void>
  readonly inserted?: (uploaded: readonly UploadedImage[]) => Promise<void>
  readonly notApplied: (uploaded: readonly UploadedImage[]) => Promise<void>
}

export class GitPastePasteProvider
  implements vscode.DocumentPasteEditProvider
{
  private explicitPasteRequests = 0
  private pendingReplacement: PendingReplacement | undefined
  private pendingReplacementTimeout: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly service: GitPasteService,
    private readonly replacementCallbacks?: ReplacementCallbacks,
    private readonly replacementTimeoutMs = DEFAULT_REPLACEMENT_TIMEOUT_MS,
    private readonly editApplicationTimeoutMs = DEFAULT_EDIT_APPLICATION_TIMEOUT_MS
  ) {}

  prepareImageReplacement(
    document: vscode.TextDocument,
    image: MarkdownImage
  ): void {
    if (this.pendingReplacementTimeout) {
      clearTimeout(this.pendingReplacementTimeout)
    }
    this.pendingReplacement?.range.dispose()
    const pendingReplacement: PendingReplacement = {
      document,
      image,
      range: new TrackedDocumentRange(
        document,
        new vscode.Range(
          document.positionAt(image.start),
          document.positionAt(image.end)
        )
      )
    }
    this.pendingReplacement = pendingReplacement
    this.pendingReplacementTimeout = setTimeout(() => {
      if (this.pendingReplacement !== pendingReplacement) return
      pendingReplacement.range.dispose()
      this.pendingReplacement = undefined
      this.pendingReplacementTimeout = undefined
      void vscode.window.showInformationMessage(
        'GitPaste: the pending image replacement expired. Run the command again to replace an image.'
      )
    }, this.replacementTimeoutMs)
  }

  async pasteFromClipboard(): Promise<void> {
    this.explicitPasteRequests += 1
    try {
      await vscode.commands.executeCommand('editor.action.clipboardPasteAction')
    } finally {
      this.explicitPasteRequests -= 1
    }
  }

  async provideDocumentPasteEdits(
    document: vscode.TextDocument,
    ranges: readonly vscode.Range[],
    dataTransfer: vscode.DataTransfer,
    _context: vscode.DocumentPasteEditContext,
    token: vscode.CancellationToken
  ): Promise<vscode.DocumentPasteEdit[] | undefined> {
    const replacementState = this.takePendingReplacement(document, ranges)
    if (replacementState.kind === 'invalid') return undefined
    const replacement =
      replacementState.kind === 'valid'
        ? replacementState.replacement
        : undefined
    const uploadOnPaste =
      vscode.env.uiKind === vscode.UIKind.Web &&
      vscode.workspace
        .getConfiguration('gitpaste')
        .get<boolean>('uploadOnPaste', true)
    const explicitPaste = this.explicitPasteRequests > 0
    if (
      (!replacement && !uploadOnPaste && !explicitPaste) ||
      token.isCancellationRequested
    ) {
      replacement?.range.dispose()
      return undefined
    }

    const images: ImageInput[] = []
    for (const [mimeType, item] of dataTransfer) {
      if (!mimeType.toLowerCase().startsWith('image/')) continue
      const file = item.asFile()
      if (!file) continue
      images.push({
        data: await file.data(),
        name: file.name || 'pasted-image',
        mimeType
      })
    }
    if (!images.length) {
      replacement?.range.dispose()
      if (!explicitPaste && !replacement) return undefined
      void vscode.window.showErrorMessage(
        'GitPaste: the clipboard does not contain an image. Copy the image itself, not its URL.'
      )
      return [
        new vscode.DocumentPasteEdit(
          '',
          'GitPaste: clipboard does not contain an image',
          pasteKind
        )
      ]
    }

    if (replacement && images.length !== 1) {
      replacement.range.dispose()
      void vscode.window.showErrorMessage(
        'GitPaste: paste exactly one image to replace the image at the cursor.'
      )
      return [
        new vscode.DocumentPasteEdit(
          '',
          'GitPaste: replacement requires one image',
          pasteKind
        )
      ]
    }
    if (replacement && !replacement.range.isValid) {
      this.showInvalidReplacementWarning()
      return undefined
    }

    const documentName = document.uri.path.split('/').pop() || 'document'
    const uploadCancellation = new vscode.CancellationTokenSource()
    const providerCancellation = token.onCancellationRequested(() =>
      uploadCancellation.cancel()
    )
    const upload = () =>
      this.service.uploadImages(images, documentName, uploadCancellation.token)
    const placeholder = images
      .map((image) => uploadingPlaceholder(image.name))
      .join('\n')
    try {
      if (replacement) {
        const replacementRange = replacement.range.current
        if (!replacementRange) {
          void vscode.window.showErrorMessage(
            'GitPaste: the image replacement target changed before upload.'
          )
          replacement.range.dispose()
          uploadCancellation.cancel()
          return undefined
        }
        const edit = new vscode.DocumentPasteEdit(
          '',
          'Upload replacement image with GitPaste',
          pasteKind
        )
        const additionalEdit = new vscode.WorkspaceEdit()
        additionalEdit.replace(
          document.uri,
          replacementRange,
          placeholder
        )
        edit.additionalEdit = additionalEdit
        this.watchForAppliedReplacement(
          replacement,
          placeholder,
          upload,
          uploadCancellation,
          providerCancellation
        )
        return [edit]
      }

      this.watchForAppliedPaste(
        document,
        ranges,
        placeholder,
        upload,
        uploadCancellation,
        providerCancellation
      )
      return [
        new vscode.DocumentPasteEdit(
          placeholder,
          'Uploading image with GitPaste',
          pasteKind
        )
      ]
    } catch (error) {
      replacement?.range.dispose()
      uploadCancellation.cancel()
      void vscode.window.showErrorMessage(`GitPaste: ${errorMessage(error)}`)
      return undefined
    } finally {
    }
  }

  private takePendingReplacement(
    document: vscode.TextDocument,
    ranges: readonly vscode.Range[]
  ): ReplacementState {
    const pending = this.pendingReplacement
    if (!pending) return { kind: 'none' }
    this.pendingReplacement = undefined
    if (this.pendingReplacementTimeout) {
      clearTimeout(this.pendingReplacementTimeout)
      this.pendingReplacementTimeout = undefined
    }

    if (pending.document !== document) {
      pending.range.dispose()
      this.showInvalidReplacementWarning()
      return { kind: 'invalid' }
    }
    const trackedRange = pending.range.current
    if (!trackedRange) {
      this.showInvalidReplacementWarning()
      return { kind: 'invalid' }
    }
    const image = {
      ...pending.image,
      start: document.offsetAt(trackedRange.start),
      end: document.offsetAt(trackedRange.end)
    }
    const cursorIsInsideImage = ranges.some((range) => {
      const offset = document.offsetAt(range.start)
      return offset >= image.start && offset <= image.end
    })
    if (!cursorIsInsideImage) {
      pending.range.dispose()
      this.showInvalidReplacementWarning()
      return { kind: 'invalid' }
    }
    return { kind: 'valid', replacement: { ...pending, image } }
  }

  private showInvalidReplacementWarning(): void {
    void vscode.window.showWarningMessage(
      'GitPaste: image replacement was canceled because the target changed.'
    )
  }

  private watchForAppliedPaste(
    document: vscode.TextDocument,
    ranges: readonly vscode.Range[],
    placeholder: string,
    upload: () => Promise<UploadedImage[]>,
    uploadCancellation: vscode.CancellationTokenSource,
    providerCancellation: vscode.Disposable
  ): void {
    const expectedChanges = ranges.map((range) => ({
      offset: document.offsetAt(range.start),
      length: document.offsetAt(range.end) - document.offsetAt(range.start)
    }))
    let completed = false
    let applied = false
    let uploaded: readonly UploadedImage[] | undefined
    let uploadFinished = false
    let uploadStarted = false
    let canceled = false
    let subscription: vscode.Disposable | undefined
    let cancellation: vscode.Disposable | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = async (
      inserted: boolean,
      completedUpload: readonly UploadedImage[] = []
    ): Promise<void> => {
      if (completed) return
      completed = true
      subscription?.dispose()
      cancellation?.dispose()
      if (timeout) clearTimeout(timeout)
      uploadCancellation.dispose()
      providerCancellation.dispose()
      if (inserted) {
        const replacement = completedUpload.map((image) => image.output).join('\n')
        const edit = new vscode.WorkspaceEdit()
        const current = document.getText()
        const offset = current.indexOf(placeholder)
        if (offset >= 0) {
          edit.replace(
            document.uri,
            new vscode.Range(document.positionAt(offset), document.positionAt(offset + placeholder.length)),
            replacement
          )
          const appliedEdit = await vscode.workspace.applyEdit(edit)
          if (!appliedEdit) {
            void this.replacementCallbacks?.notApplied(completedUpload)
            return
          }
        } else {
          void this.replacementCallbacks?.notApplied(completedUpload)
          return
        }
        void this.replacementCallbacks?.inserted?.(completedUpload)
      } else {
        removePlaceholder(document, placeholder)
        void this.replacementCallbacks?.notApplied(completedUpload)
      }
    }

    const complete = (): void => {
      if (completed || !applied || !uploadFinished || !uploaded) return
      if (canceled) {
        void finish(false, uploaded)
        return
      }
      void finish(true, uploaded)
    }

    const startUpload = (): void => {
      if (uploadStarted) return
      uploadStarted = true
      void upload().then((completedUpload) => {
        uploaded = completedUpload
        uploadFinished = true
        complete()
      }).catch((error) => {
        uploadFinished = true
        if (!(error instanceof vscode.CancellationError)) {
          void vscode.window.showErrorMessage(`GitPaste: ${errorMessage(error)}`)
        }
        void finish(false, uploaded ?? [])
      })
    }

    subscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document !== document) return
      const unmatchedChanges = [...event.contentChanges]
      const matched = expectedChanges.every((expected) => {
        const index = unmatchedChanges.findIndex(
          (change) =>
            change.rangeOffset === expected.offset &&
            change.rangeLength === expected.length &&
            normalizeLineEndings(change.text) === normalizeLineEndings(placeholder)
        )
        if (index < 0) return false
        unmatchedChanges.splice(index, 1)
        return true
      })
      if (matched) {
        applied = true
        startUpload()
        complete()
      }
    })
    cancellation = uploadCancellation.token.onCancellationRequested(() => {
      canceled = true
      if (uploadFinished) void finish(false, uploaded ?? [])
    })
    timeout = setTimeout(() => {
      if (applied) return
      uploadCancellation.cancel()
      void finish(false, uploaded ?? [])
    }, this.editApplicationTimeoutMs)
    if (uploadCancellation.token.isCancellationRequested && uploadFinished) {
      void finish(false, uploaded ?? [])
    }
  }

  private watchForAppliedReplacement(
    replacement: PendingReplacement,
    placeholder: string,
    upload: () => Promise<UploadedImage[]>,
    uploadCancellation: vscode.CancellationTokenSource,
    providerCancellation: vscode.Disposable
  ): void {
    let completed = false
    let uploadFinished = false
    let uploaded: readonly UploadedImage[] | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    const subscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document !== replacement.document) return
      const expectedLength = replacement.image.end - replacement.image.start
      const applied = event.contentChanges.some(
        (change) =>
          change.rangeOffset === replacement.image.start &&
          change.rangeLength === expectedLength &&
          change.text === placeholder
      )
      if (!applied) return
      completed = true
      subscription.dispose()
      if (timeout) clearTimeout(timeout)
      void upload().then(async (completedUpload) => {
        uploadFinished = true
        uploaded = completedUpload
        const image = completedUpload[0]
        const edit = new vscode.WorkspaceEdit()
        const current = replacement.document.getText()
        const offset = current.indexOf(placeholder)
        if (offset >= 0) {
          edit.replace(
            replacement.document.uri,
            new vscode.Range(
              replacement.document.positionAt(offset),
              replacement.document.positionAt(offset + placeholder.length)
            ),
            image.output
          )
          const appliedEdit = await vscode.workspace.applyEdit(edit)
          if (appliedEdit) {
            void this.replacementCallbacks?.applied(replacement.image.url, image)
          } else {
            void this.replacementCallbacks?.notApplied(completedUpload)
          }
        } else {
          removePlaceholder(replacement.document, placeholder)
          void this.replacementCallbacks?.notApplied(completedUpload)
        }
        uploadCancellation.dispose()
        providerCancellation.dispose()
      }).catch((error) => {
        uploadFinished = true
        if (!(error instanceof vscode.CancellationError)) {
          void vscode.window.showErrorMessage(`GitPaste: ${errorMessage(error)}`)
        }
        uploadCancellation.dispose()
        providerCancellation.dispose()
        removePlaceholder(replacement.document, placeholder)
        void this.replacementCallbacks?.notApplied(uploaded ?? [])
      })
    })

    timeout = setTimeout(() => {
      subscription.dispose()
      if (!completed) {
        uploadCancellation.cancel()
        providerCancellation.dispose()
        if (uploadFinished) {
          removePlaceholder(replacement.document, placeholder)
          void this.replacementCallbacks?.notApplied(uploaded ?? [])
        }
      }
    }, this.editApplicationTimeoutMs)
  }
}

export const pasteProviderMetadata: vscode.DocumentPasteProviderMetadata = {
  providedPasteEditKinds: [pasteKind],
  pasteMimeTypes: ['image/*', 'text/plain', 'files']
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n')
}

function uploadingPlaceholder(name: string): string {
  const cleanName = name.replace(/[\r\n<>]/g, '').trim() || 'image'
  return `![Uploading ${cleanName}...]()`
}

function removePlaceholder(document: vscode.TextDocument, placeholder: string): void {
  const offset = document.getText().indexOf(placeholder)
  if (offset < 0) return
  const edit = new vscode.WorkspaceEdit()
  edit.delete(
    document.uri,
    new vscode.Range(
      document.positionAt(offset),
      document.positionAt(offset + placeholder.length)
    )
  )
  void vscode.workspace.applyEdit(edit)
}
