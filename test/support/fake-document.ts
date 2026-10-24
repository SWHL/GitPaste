import * as vscode from 'vscode'

// Lightweight, mutable stand-ins for the VS Code API surface used by
// `paste-provider.ts` and `tracked-document-range.ts` in unit tests.
// A `FakeTextDocument` tracks its own text and computes offsets/positions so
// that placeholder detection and range tracking behave like a real editor.

const mockVscode = vscode as unknown as {
  __documents: Map<string, FakeTextDocument>
}

/**
 * A text document whose content can be mutated directly. Offset/position
 * conversion assumes a real line model so multi-line placeholder text works.
 */
export class FakeTextDocument {
  text: string
  isClosed = false

  constructor(
    readonly uri: { path: string; toString(): string },
    readonly languageId: string,
    initialText = '',
  ) {
    this.text = initialText
    mockVscode.__documents.set(uri.toString(), this)
  }

  getText(range?: { start: vscode.Position; end: vscode.Position }): string {
    if (!range) return this.text
    const start = this.offsetAt(range.start)
    const end = this.offsetAt(range.end)
    return this.text.slice(start, end)
  }

  offsetAt(position: vscode.Position): number {
    const lines = this.text.split('\n')
    if (position.line >= lines.length) return this.text.length
    let offset = 0
    for (let i = 0; i < position.line; i += 1) {
      offset += lines[i].length + 1
    }
    return offset + position.character
  }

  positionAt(offset: number): vscode.Position {
    const lines = this.text.split('\n')
    let cursor = 0
    for (let i = 0; i < lines.length; i += 1) {
      const lineLength = lines[i].length + 1
      if (cursor + lineLength > offset) {
        return new vscode.Position(i, offset - cursor)
      }
      cursor += lineLength
    }
    const lastLine = lines.length - 1
    return new vscode.Position(lastLine, lines[lastLine].length)
  }

  /** Replace the document text and (optionally) notify change listeners. */
  _setText(next: string): void {
    this.text = next
  }
}

export interface FakeImageFile {
  name: string
  uri: { path: string; toString(): string }
  data: () => Promise<Uint8Array>
  mimeType: string
}

export class FakeDataTransferItem {
  constructor(
    private readonly file?: FakeImageFile,
    private readonly stringValue?: string,
  ) {}

  asFile(): FakeImageFile | undefined {
    return this.file
  }

  asString(): Promise<string> {
    return Promise.resolve(this.stringValue ?? '')
  }
}

export class FakeDataTransfer {
  private readonly entries = new Map<string, FakeDataTransferItem>()

  set(mimeType: string, item: FakeDataTransferItem): this {
    this.entries.set(mimeType, item)
    return this
  }

  [Symbol.iterator](): Iterator<[string, FakeDataTransferItem]> {
    return this.entries.entries()
  }
}

/** Build a transfer item that carries an in-memory image file. */
export function imageItem(
  name: string,
  bytes: Uint8Array,
  mimeType = 'image/png',
): FakeDataTransferItem {
  const file: FakeImageFile = {
    name,
    uri: vscode.Uri.parse(`file:///tmp/${name}`),
    data: async () => bytes,
    mimeType,
  }
  return new FakeDataTransferItem(file)
}

/** Build a transfer item carrying a `text/uri-list` payload. */
export function uriListItem(value: string): FakeDataTransferItem {
  return new FakeDataTransferItem(undefined, value)
}

/** Build a transfer item carrying a plain `files` drop entry. */
export function fileDropItem(
  name: string,
  bytes: Uint8Array,
): FakeDataTransferItem {
  return imageItem(name, bytes)
}
