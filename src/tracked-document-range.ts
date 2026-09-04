import * as vscode from 'vscode'
import { updateOffsetRange, type OffsetRange } from './range-tracking'

export class TrackedDocumentRange implements vscode.Disposable {
  private offsets: OffsetRange | undefined
  private readonly invalidationEmitter = new vscode.EventEmitter<void>()
  private readonly subscriptions: vscode.Disposable[]
  private tracking = true

  readonly onDidInvalidate = this.invalidationEmitter.event

  constructor(
    readonly document: vscode.TextDocument,
    range: vscode.Range
  ) {
    this.offsets = {
      start: document.offsetAt(range.start),
      end: document.offsetAt(range.end)
    }
    this.subscriptions = [
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document !== this.document || !this.offsets) return
        const updated = updateOffsetRange(this.offsets, event.contentChanges)
        if (!updated) {
          this.invalidate()
          return
        }
        this.offsets = updated
      }),
      vscode.workspace.onDidCloseTextDocument((closed) => {
        if (closed === this.document) this.invalidate()
      })
    ]
  }

  get isValid(): boolean {
    return this.tracking && !!this.offsets && !this.document.isClosed
  }

  get current(): vscode.Range | undefined {
    const offsets = this.offsets
    return this.tracking && offsets && !this.document.isClosed
      ? new vscode.Range(
          this.document.positionAt(offsets.start),
          this.document.positionAt(offsets.end)
        )
      : undefined
  }

  resolve(): vscode.Range | undefined {
    const range = this.current
    this.dispose()
    return range
  }

  dispose(): void {
    if (!this.tracking) return
    this.tracking = false
    for (const subscription of this.subscriptions) subscription.dispose()
    this.invalidationEmitter.dispose()
  }

  private invalidate(): void {
    if (!this.offsets) return
    this.offsets = undefined
    this.invalidationEmitter.fire()
    this.dispose()
  }
}
