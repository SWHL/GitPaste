import * as vscode from 'vscode'
import { GitPasteService } from './service'
import type { MarkdownImage } from './markdown-image'
import type { ImageInput, UploadedImage } from './types'

const pasteKind = vscode.DocumentDropOrPasteEditKind.Empty.append(
  'markdown',
  'image',
  'gitpaste'
)
const DEFAULT_REPLACEMENT_TIMEOUT_MS = 60_000

export const pasteDocumentSelector: vscode.DocumentSelector = [
  'markdown',
  'mdx'
]

interface PendingReplacement {
  readonly document: vscode.TextDocument
  readonly documentVersion: number
  readonly image: MarkdownImage
}

interface ReplacementCallbacks {
  readonly applied: (
    oldUrl: string,
    uploaded: UploadedImage
  ) => Promise<void>
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
    private readonly replacementTimeoutMs = DEFAULT_REPLACEMENT_TIMEOUT_MS
  ) {}

  prepareImageReplacement(
    document: vscode.TextDocument,
    image: MarkdownImage
  ): void {
    if (this.pendingReplacementTimeout) {
      clearTimeout(this.pendingReplacementTimeout)
    }
    const pendingReplacement: PendingReplacement = {
      document,
      documentVersion: document.version,
      image
    }
    this.pendingReplacement = pendingReplacement
    this.pendingReplacementTimeout = setTimeout(() => {
      if (this.pendingReplacement !== pendingReplacement) return
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
    const replacement = this.takePendingReplacement(document, ranges)
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

    const documentName = document.uri.path.split('/').pop() || 'document'
    try {
      const uploaded = await this.service.uploadImages(
        images,
        documentName,
        token
      )
      if (replacement) {
        if (document.version !== replacement.documentVersion) {
          void vscode.window.showErrorMessage(
            'GitPaste: the document changed while the replacement image was uploading.'
          )
          void this.replacementCallbacks?.notApplied(uploaded)
          return [
            new vscode.DocumentPasteEdit(
              '',
              'GitPaste: replacement target changed',
              pasteKind
            )
          ]
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
            document.positionAt(replacement.image.start),
            document.positionAt(replacement.image.end)
          ),
          uploadedImage.output
        )
        edit.additionalEdit = additionalEdit
        this.watchForAppliedReplacement(replacement, uploadedImage)
        return [edit]
      }

      const insertText = uploaded.map((image) => image.output).join('\n')
      void vscode.window.showInformationMessage(
        `GitPaste: uploaded ${uploaded.length} image${
          uploaded.length === 1 ? '' : 's'
        }.`
      )
      return [
        new vscode.DocumentPasteEdit(
          insertText,
          'Upload image to GitHub with GitPaste',
          pasteKind
        )
      ]
    } catch (error) {
      if (!(error instanceof vscode.CancellationError)) {
        void vscode.window.showErrorMessage(
          `GitPaste: ${errorMessage(error)}`
        )
      }
      return undefined
    }
  }

  private takePendingReplacement(
    document: vscode.TextDocument,
    ranges: readonly vscode.Range[]
  ): PendingReplacement | undefined {
    const pending = this.pendingReplacement
    if (!pending) return undefined
    this.pendingReplacement = undefined
    if (this.pendingReplacementTimeout) {
      clearTimeout(this.pendingReplacementTimeout)
      this.pendingReplacementTimeout = undefined
    }

    const cursorIsInsideImage = ranges.some((range) => {
      const offset = document.offsetAt(range.start)
      return offset >= pending.image.start && offset <= pending.image.end
    })
    if (
      pending.document !== document ||
      pending.documentVersion !== document.version ||
      !cursorIsInsideImage
    ) {
      void vscode.window.showWarningMessage(
        'GitPaste: image replacement was canceled because the target changed.'
      )
      return undefined
    }
    return pending
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
    }, 10_000)
  }
}

export const pasteProviderMetadata: vscode.DocumentPasteProviderMetadata = {
  providedPasteEditKinds: [pasteKind],
  pasteMimeTypes: ['image/*', 'text/plain', 'files']
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
