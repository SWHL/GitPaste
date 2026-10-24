import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import * as vscode from 'vscode'
import {
  GitPastePasteGuard,
  GitPastePasteProvider,
} from '../src/paste-provider'
import {
  FakeDataTransfer,
  FakeDataTransferItem,
  FakeTextDocument,
  fileDropItem,
  imageItem,
  uriListItem,
} from './support/fake-document'

type MockVscode = {
  __config: Record<string, unknown>
  __handlers: Record<string, (...args: any[]) => unknown>
  __documents: Map<string, FakeTextDocument>
  __changeListeners: Array<(event: unknown) => void>
  __emitChange: (document: FakeTextDocument, changes: unknown[]) => void
  __reset: () => void
  env: { uiKind: number }
  UIKind: { Desktop: number; Web: number }
  __lastCommand?: { command: string; args: unknown[] }
} & typeof vscode

const mockVscode = vscode as unknown as MockVscode

const PLACEHOLDER_RE = /!\[Uploading .*?\.\.\.\]\(\)/

interface FakeUploaded {
  url: string
  output: string
  name: string
  originalName: string
}

function uri(path: string): vscode.Uri {
  return vscode.Uri.parse(`file://${path}`)
}

function makeService(
  onUpload: (images: any[], documentName: string) => FakeUploaded[],
): any {
  return {
    uploadImages: async (
      images: any[],
      documentName: string,
    ): Promise<FakeUploaded[]> => onUpload(images, documentName),
  }
}

function token(): vscode.CancellationToken {
  return new vscode.CancellationTokenSource().token
}

function originRange(_doc: FakeTextDocument): vscode.Range {
  return new vscode.Range(
    new vscode.Position(0, 0),
    new vscode.Position(0, 0),
  )
}

const NOOP_CALLBACKS = {
  applied: async () => {},
  inserted: async () => {},
  notApplied: async () => {},
}

function applyPlaceholder(doc: FakeTextDocument, placeholder: string): void {
  doc._setText(placeholder)
  mockVscode.__emitChange(doc, [
    { rangeOffset: 0, rangeLength: 0, text: placeholder },
  ])
}

function editText(edit: unknown): string {
  return (edit as { text: string }).text
}

// Reset the shared mock before every test: clears config/handlers/document
// registry/listeners and restores env.uiKind to Web, so concurrent subtests
// do not leak state into one another.
beforeEach(() => {
  mockVscode.__reset()
})

// ---------------------------------------------------------------------------
// GitPastePasteGuard
// ---------------------------------------------------------------------------

test('guard ignores Markdown documents and lets the paste fall through', async () => {
  const guard = new GitPastePasteGuard()
  const doc = new FakeTextDocument(uri('/guard-md.md'), 'markdown', '')
  const transfer = new FakeDataTransfer().set(
    'image/png',
    imageItem('x.png', new Uint8Array([1, 2, 3])),
  )
  const result = await guard.provideDocumentPasteEdits(
    doc as any,
    [],
    transfer as any,
    {} as any,
    token(),
  )
  assert.equal(result, undefined)
})

test('guard warns and blocks pasting images outside Markdown or MDX', async () => {
  let captured: { msg: string; rest: unknown[] } | undefined
  mockVscode.__handlers.warning = (msg: string, ...rest: unknown[]) => {
    captured = { msg, rest }
    return undefined
  }
  const guard = new GitPastePasteGuard()
  const doc = new FakeTextDocument(uri('/guard-txt.txt'), 'plaintext', '')
  const transfer = new FakeDataTransfer().set(
    'image/png',
    imageItem('x.png', new Uint8Array([1, 2, 3])),
  )
  const result = await guard.provideDocumentPasteEdits(
    doc as any,
    [],
    transfer as any,
    {} as any,
    token(),
  )
  assert.ok(result && result.length === 1)
  assert.ok(captured)
  assert.match(captured!.msg, /Markdown or MDX/)
  assert.ok(captured!.rest.includes('Change language mode'))
})

test('guard ignores non-Markdown documents that carry no image', async () => {
  const guard = new GitPastePasteGuard()
  const doc = new FakeTextDocument(uri('/guard-txt2.txt'), 'plaintext', '')
  const result = await guard.provideDocumentPasteEdits(
    doc as any,
    [],
    new FakeDataTransfer() as any,
    {} as any,
    token(),
  )
  assert.equal(result, undefined)
})

// ---------------------------------------------------------------------------
// File-drop delegation and platform gating
// ---------------------------------------------------------------------------

test('paste provider delegates a file drop to the drop provider unless explicit', async () => {
  const provider = new GitPastePasteProvider(makeService(() => []), NOOP_CALLBACKS)
  const doc = new FakeTextDocument(uri('/delegate.md'), 'markdown', '')
  const transfer = new FakeDataTransfer().set(
    'files',
    fileDropItem('x.png', new Uint8Array([1])),
  )
  const result = await provider.provideDocumentPasteEdits(
    doc as any,
    [originRange(doc)],
    transfer as any,
    {} as any,
    token(),
  )
  assert.equal(result, undefined)
})

test('paste provider ignores image paste on the desktop (uploadOnPaste is web-only)', async () => {
  mockVscode.env.uiKind = mockVscode.UIKind.Desktop
  const provider = new GitPastePasteProvider(makeService(() => []), NOOP_CALLBACKS)
  const doc = new FakeTextDocument(uri('/desktop.md'), 'markdown', '')
  const transfer = new FakeDataTransfer().set(
    'image/png',
    imageItem('x.png', new Uint8Array([1])),
  )
  const result = await provider.provideDocumentPasteEdits(
    doc as any,
    [originRange(doc)],
    transfer as any,
    {} as any,
    token(),
  )
  assert.equal(result, undefined)
})

test('shows an error when an explicit paste request finds no image', async () => {
  let captured: string | undefined
  mockVscode.__handlers.error = (msg: string) => {
    captured = msg
    return undefined
  }
  const provider = new GitPastePasteProvider(makeService(() => []), NOOP_CALLBACKS)
  await provider.pasteFromClipboard()
  const doc = new FakeTextDocument(uri('/explicit.md'), 'markdown', '')
  const result = await provider.provideDocumentPasteEdits(
    doc as any,
    [originRange(doc)],
    new FakeDataTransfer() as any,
    {} as any,
    token(),
  )
  assert.ok(result && result.length === 1)
  assert.ok(captured)
  assert.match(captured!, /does not contain an image/)
})

// ---------------------------------------------------------------------------
// Replacement validation
// ---------------------------------------------------------------------------

test('replacement requires exactly one pasted image', async () => {
  let captured: string | undefined
  mockVscode.__handlers.error = (msg: string) => {
    captured = msg
    return undefined
  }
  const provider = new GitPastePasteProvider(makeService(() => []), NOOP_CALLBACKS)
  const doc = new FakeTextDocument(uri('/replace1.md'), 'markdown', '![old](http://x/old.png)')
  provider.prepareImageReplacement(doc as any, {
    url: 'http://x/old.png',
    start: 0,
    end: 22,
  } as any)
  // Two distinct image MIME types so the transfer yields two images.
  const transfer = new FakeDataTransfer()
    .set('image/png', imageItem('a.png', new Uint8Array([1])))
    .set('image/jpeg', imageItem('b.png', new Uint8Array([2])))
  const result = await provider.provideDocumentPasteEdits(
    doc as any,
    [originRange(doc)],
    transfer as any,
    {} as any,
    token(),
  )
  assert.ok(result && result.length === 1)
  assert.ok(captured)
  assert.match(captured!, /exactly one image/)
})

// ---------------------------------------------------------------------------
// pasteFromClipboard and the explicit paste request
// ---------------------------------------------------------------------------

test('pasteFromClipboard triggers the editor paste command', async () => {
  const provider = new GitPastePasteProvider(makeService(() => []), NOOP_CALLBACKS)
  await provider.pasteFromClipboard()
  assert.equal(mockVscode.__lastCommand?.command, 'editor.action.clipboardPasteAction')
})

test('an armed explicit paste request is not delegated as a file drop', async () => {
  const provider = new GitPastePasteProvider(makeService(() => []), NOOP_CALLBACKS)
  await provider.pasteFromClipboard()
  const doc = new FakeTextDocument(uri('/armed.md'), 'markdown', '')
  const transfer = new FakeDataTransfer().set(
    'files',
    fileDropItem('x.png', new Uint8Array([1])),
  )
  const result = await provider.provideDocumentPasteEdits(
    doc as any,
    [originRange(doc)],
    transfer as any,
    {} as any,
    token(),
  )
  assert.ok(result && result.length >= 1)
})

// ---------------------------------------------------------------------------
// End-to-end upload orchestration
// ---------------------------------------------------------------------------

test('uploads a pasted image and inserts the link when the placeholder is applied', async () => {
  const output = '![](https://github.com/x/y.png)'
  let uploadArgs: { images: any[]; documentName: string } | undefined
  const provider = new GitPastePasteProvider(
    makeService((images, documentName) => {
      uploadArgs = { images, documentName }
      return [
        {
          url: 'https://github.com/x/y.png',
          output,
          name: images[0].name,
          originalName: images[0].name,
        },
      ]
    }),
    NOOP_CALLBACKS,
    undefined,
    100,
  )
  const doc = new FakeTextDocument(uri('/repo/paste.md'), 'markdown', '')
  const transfer = new FakeDataTransfer().set(
    'image/png',
    imageItem('a.png', new Uint8Array([1, 2, 3])),
  )
  const edits = await provider.provideDocumentPasteEdits(
    doc as any,
    [originRange(doc)],
    transfer as any,
    {} as any,
    token(),
  )
  assert.ok(edits && edits.length === 1)
  const placeholder = editText(edits![0])
  assert.match(placeholder, PLACEHOLDER_RE)

  applyPlaceholder(doc, placeholder)
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.ok(uploadArgs, 'expected uploadImages to be called')
  assert.equal(uploadArgs!.images.length, 1)
  assert.equal(uploadArgs!.images[0].name, 'a.png')
  assert.equal(uploadArgs!.documentName, 'paste.md')
  assert.equal(doc.text, output)
})

test('uploads a dropped image and inserts the link', async () => {
  const output = '![](https://github.com/x/dropped.png)'
  let uploadArgs: { images: any[]; documentName: string } | undefined
  const provider = new GitPastePasteProvider(
    makeService((images, documentName) => {
      uploadArgs = { images, documentName }
      return [
        {
          url: 'https://github.com/x/dropped.png',
          output,
          name: images[0].name,
          originalName: images[0].name,
        },
      ]
    }),
    NOOP_CALLBACKS,
    undefined,
    100,
  )
  const doc = new FakeTextDocument(uri('/repo/drop.md'), 'markdown', '')
  const transfer = new FakeDataTransfer().set(
    'image/png',
    imageItem('drop.png', new Uint8Array([9])),
  )
  const dropEdits = await provider.provideDocumentDropEdits(
    doc as any,
    new vscode.Position(0, 0),
    transfer as any,
    token(),
  )
  assert.ok(dropEdits && dropEdits.length === 1)
  const placeholder = editText(dropEdits![0])
  assert.match(placeholder, PLACEHOLDER_RE)

  applyPlaceholder(doc, placeholder)
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.ok(uploadArgs)
  assert.equal(uploadArgs!.images[0].name, 'drop.png')
  assert.equal(doc.text, output)
})

test('reads image uris from a text/uri-list drop and uploads them', async () => {
  mockVscode.__handlers.fsRead = () => new Uint8Array([7, 7, 7])
  const output = '![](https://github.com/x/from-uri.png)'
  let uploadArgs: { images: any[]; documentName: string } | undefined
  const provider = new GitPastePasteProvider(
    makeService((images, documentName) => {
      uploadArgs = { images, documentName }
      return [
        {
          url: 'https://github.com/x/from-uri.png',
          output,
          name: images[0].name,
          originalName: images[0].name,
        },
      ]
    }),
    NOOP_CALLBACKS,
    undefined,
    100,
  )
  const doc = new FakeTextDocument(uri('/repo/uri.md'), 'markdown', '')
  const transfer = new FakeDataTransfer().set(
    'text/uri-list',
    uriListItem('file:///a/b/c.png'),
  )
  const dropEdits = await provider.provideDocumentDropEdits(
    doc as any,
    new vscode.Position(0, 0),
    transfer as any,
    token(),
  )
  assert.ok(dropEdits && dropEdits.length === 1)
  applyPlaceholder(doc, editText(dropEdits![0]))
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.ok(uploadArgs)
  assert.equal(uploadArgs!.images[0].name, 'c.png')
  assert.equal(doc.text, output)
})

test('deduplicates identical dropped images before uploading', async () => {
  const output = '![](https://github.com/x/dup.png)'
  let uploadArgs: { images: any[]; documentName: string } | undefined
  const provider = new GitPastePasteProvider(
    makeService((images, documentName) => {
      uploadArgs = { images, documentName }
      return images.map((image) => ({
        url: 'https://github.com/x/dup.png',
        output,
        name: image.name,
        originalName: image.name,
      }))
    }),
    NOOP_CALLBACKS,
    undefined,
    100,
  )
  const doc = new FakeTextDocument(uri('/repo/dup.md'), 'markdown', '')
  const transfer = new FakeDataTransfer()
    .set('image/png', imageItem('a.png', new Uint8Array([1, 1])))
    .set('image/png', imageItem('a.png', new Uint8Array([1, 1])))
  const dropEdits = await provider.provideDocumentDropEdits(
    doc as any,
    new vscode.Position(0, 0),
    transfer as any,
    token(),
  )
  assert.ok(dropEdits && dropEdits.length === 1)
  applyPlaceholder(doc, editText(dropEdits![0]))
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.ok(uploadArgs)
  assert.equal(uploadArgs!.images.length, 1, 'identical images should be deduped')
})

test('skips non-image dropped files', async () => {
  const provider = new GitPastePasteProvider(makeService(() => []), NOOP_CALLBACKS)
  const doc = new FakeTextDocument(uri('/repo/skip.md'), 'markdown', '')
  const transfer = new FakeDataTransfer().set(
    'application/octet-stream',
    new FakeDataTransferItem(undefined, undefined),
  )
  const result = await provider.provideDocumentDropEdits(
    doc as any,
    new vscode.Position(0, 0),
    transfer as any,
    token(),
  )
  assert.equal(result, undefined)
})

test('replaces the image at the cursor and reports the old url', async () => {
  const oldText = '![old](http://x/old.png)'
  const output = '![](http://x/new.png)'
  let applied: { oldUrl: string; uploaded: FakeUploaded } | undefined
  const provider = new GitPastePasteProvider(
    makeService((images) => [
      {
        url: 'http://x/new.png',
        output,
        name: images[0].name,
        originalName: images[0].name,
      },
    ]),
    {
      applied: async (oldUrl, uploaded) =>
        void (applied = {
          oldUrl,
          uploaded: uploaded as unknown as FakeUploaded,
        }),
      inserted: async () => {},
      notApplied: async () => {},
    },
    undefined,
    100,
  )
  const doc = new FakeTextDocument(uri('/repo/replace.md'), 'markdown', oldText)
  provider.prepareImageReplacement(doc as any, {
    url: 'http://x/old.png',
    start: 0,
    end: oldText.length,
  } as any)
  const transfer = new FakeDataTransfer().set(
    'image/png',
    imageItem('b.png', new Uint8Array([4, 5, 6])),
  )
  const cursor = new vscode.Range(
    new vscode.Position(0, 5),
    new vscode.Position(0, 5),
  )
  const edits = await provider.provideDocumentPasteEdits(
    doc as any,
    [cursor],
    transfer as any,
    {} as any,
    token(),
  )
  assert.ok(edits && edits.length === 1)
  const additional: any = (edits![0] as any).additionalEdit
  assert.ok(additional, 'replacement edit should carry an additionalEdit')

  await vscode.workspace.applyEdit(additional)
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.ok(applied, 'applied callback should fire')
  assert.equal(applied!.oldUrl, 'http://x/old.png')
  assert.equal(doc.text, output)
})
