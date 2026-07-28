import * as vscode from 'vscode'
import { GitPasteService } from './service'
import type { ImageInput } from './types'

const pasteKind = vscode.DocumentDropOrPasteEditKind.Empty.append(
  'markdown',
  'image',
  'gitpaste'
)

export const pasteDocumentSelector: vscode.DocumentSelector = [
  'markdown',
  'mdx'
]

export class GitPastePasteProvider
  implements vscode.DocumentPasteEditProvider
{
  private explicitPasteRequests = 0

  constructor(private readonly service: GitPasteService) {}

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
    _ranges: readonly vscode.Range[],
    dataTransfer: vscode.DataTransfer,
    _context: vscode.DocumentPasteEditContext,
    token: vscode.CancellationToken
  ): Promise<vscode.DocumentPasteEdit[] | undefined> {
    const uploadOnPaste =
      vscode.env.uiKind === vscode.UIKind.Web &&
      vscode.workspace
        .getConfiguration('gitpaste')
        .get<boolean>('uploadOnPaste', true)
    const explicitPaste = this.explicitPasteRequests > 0
    if ((!uploadOnPaste && !explicitPaste) || token.isCancellationRequested) {
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
      if (!explicitPaste) return undefined
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

    const documentName = document.uri.path.split('/').pop() || 'document'
    try {
      const uploaded = await this.service.uploadImages(
        images,
        documentName,
        token
      )
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
}

export const pasteProviderMetadata: vscode.DocumentPasteProviderMetadata = {
  providedPasteEditKinds: [pasteKind],
  pasteMimeTypes: ['image/*', 'text/plain', 'files']
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
