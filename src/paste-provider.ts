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
    const uploadCancellation = replacement
      ? new vscode.CancellationTokenSource()
      : undefined
    const providerCancellation = uploadCancellation
      ? token.onCancellationRequested(() => uploadCancellation.cancel())
      : undefined
    const targetInvalidation = uploadCancellation
      ? replacement?.range.onDidInvalidate(() => uploadCancellation.cancel())
      : undefined
    try {
      const uploaded = await this.service.uploadImages(
        images,
        documentName,
        uploadCancellation?.token ?? token
      )
      if (token.isCancellationRequested) {
        replacement?.range.dispose()
        void this.replacementCallbacks?.notApplied(uploaded)
        return undefined
      }
      if (replacement) {
        const replacementRange = replacement.range.resolve()
        if (!replacementRange) {
          void vscode.window.showErrorMessage(
            'GitPaste: the image replacement target changed while uploading.'
          )
          void this.replacementCallbacks?.notApplied(uploaded)
          return undefined
        }
        const resolvedReplacement: PendingReplacement = {
          ...replacement,
          image: {
            ...replacement.image,
            start: document.offsetAt(replacementRange.start),
            end: document.offsetAt(replacementRange.end)
          }
        }
        const uploadedImage = uploaded[0]
        const edit = new vscode.DocumentPasteEdit(
          '',
          'Replace image with GitPaste',
          pasteKind
        )
        const additionalEdit = new vscode.WorkspaceEdit()
        additionalEdit.replace(
          document.uri,
          new vscode.Range(
            document.positionAt(resolvedReplacement.image.start),
            document.positionAt(resolvedReplacement.image.end)
          ),
          uploadedImage.output
        )
        edit.additionalEdit = additionalEdit
        this.watchForAppliedReplacement(resolvedReplacement, uploadedImage)
        return [edit]
      }

      const insertText = uploaded.map((image) => image.output).join('\n')
      if (this.replacementCallbacks) {
        this.watchForAppliedPaste(document, ranges, insertText, uploaded, token)
      }
      return [
        new vscode.DocumentPasteEdit(
          insertText,
          'Upload image to GitHub with GitPaste',
          pasteKind
        )
      ]
    } catch (error) {
      replacement?.range.dispose()
      if (!(error instanceof vscode.CancellationError)) {
        void vscode.window.showErrorMessage(
          `GitPaste: ${errorMessage(error)}`
        )
      }
      return undefined
    } finally {
      providerCancellation?.dispose()
      targetInvalidation?.dispose()
      uploadCancellation?.dispose()
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
    insertText: string,
    uploaded: readonly UploadedImage[],
    token: vscode.CancellationToken
  ): void {
    const expectedChanges = ranges.map((range) => ({
      offset: document.offsetAt(range.start),
      length: document.offsetAt(range.end) - document.offsetAt(range.start)
    }))
    let completed = false
    let subscription: vscode.Disposable | undefined
    let cancellation: vscode.Disposable | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (applied: boolean): void => {
      if (completed) return
      completed = true
      subscription?.dispose()
      cancellation?.dispose()
      if (timeout) clearTimeout(timeout)
      if (applied) {
        void this.replacementCallbacks?.inserted?.(uploaded)
      } else {
        void this.replacementCallbacks?.notApplied(uploaded)
      }
    }

    subscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document !== document) return
      const unmatchedChanges = [...event.contentChanges]
      const applied = expectedChanges.every((expected) => {
        const index = unmatchedChanges.findIndex(
          (change) =>
            change.rangeOffset === expected.offset &&
            change.rangeLength === expected.length &&
            normalizeLineEndings(change.text) === normalizeLineEndings(insertText)
        )
        if (index < 0) return false
        unmatchedChanges.splice(index, 1)
        return true
      })
      if (applied) finish(true)
    })
    cancellation = token.onCancellationRequested(() => finish(false))
    timeout = setTimeout(() => finish(false), this.editApplicationTimeoutMs)
    if (token.isCancellationRequested) finish(false)
  }

  private watchForAppliedReplacement(
    replacement: PendingReplacement,
    uploaded: UploadedImage
  ): void {
    let completed = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const subscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document !== replacement.document) return
      const expectedLength = replacement.image.end - replacement.image.start
      const applied = event.contentChanges.some(
        (change) =>
          change.rangeOffset === replacement.image.start &&
          change.rangeLength === expectedLength &&
          change.text === uploaded.output
      )
      if (!applied) return
      completed = true
      subscription.dispose()
      if (timeout) clearTimeout(timeout)
      void this.replacementCallbacks?.applied(replacement.image.url, uploaded)
    })

    timeout = setTimeout(() => {
      subscription.dispose()
      if (!completed) {
        void this.replacementCallbacks?.notApplied([uploaded])
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
