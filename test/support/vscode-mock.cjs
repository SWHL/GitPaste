'use strict'

// Minimal VS Code API mock for `node --test` unit tests.
// Only the surface used by `service.ts` and `credentials.ts` is implemented,
// plus the additional surface required by `paste-provider.ts` and
// `tracked-document-range.ts`. Test code configures behavior through
// `mock.__config` and `mock.__handlers`, and drives editor-like behavior
// through `mock.__emitChange`, `mock.__emitClose`, and `mock.__documents`.

const mock = {
  ProgressLocation: { Notification: 15, Window: 15, SourceControl: 1 },
  UIKind: { Desktop: 1, Web: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  CancellationError: class CancellationError extends Error {
    constructor(message) {
      super(message)
      this.name = 'CancellationError'
    }
  },
  CancellationTokenSource: class {
    constructor() {
      this._cancelled = false
      this._listeners = []
      this.token = {
        isCancellationRequested: false,
        onCancellationRequested: (listener) => {
          if (this._cancelled) {
            listener()
            return { dispose() {} }
          }
          this._listeners.push(listener)
          return {
            dispose: () => {
              const index = this._listeners.indexOf(listener)
              if (index >= 0) this._listeners.splice(index, 1)
            },
          }
        },
      }
    }
    cancel() {
      if (this._cancelled) return
      this._cancelled = true
      this.token.isCancellationRequested = true
      for (const listener of this._listeners.splice(0)) listener()
    }
    dispose() {}
  },
  window: {
    withProgress: async (_options, task) => {
      const source = new mock.CancellationTokenSource()
      return task({ report() {} }, source.token)
    },
    showErrorMessage: async (message, options, ...items) => {
      const handler = mock.__handlers.error
      return handler ? handler(message, options, items) : undefined
    },
    showWarningMessage: async (message, options, ...items) => {
      const handler = mock.__handlers.warning
      return handler ? handler(message, options, items) : undefined
    },
    showInformationMessage: async (message, options, ...items) => {
      const handler = mock.__handlers.info
      return handler ? handler(message, options, items) : undefined
    },
    showQuickPick: async (items, _options) => {
      const handler = mock.__handlers.quickPick
      return handler ? handler(items, _options) : undefined
    },
    showInputBox: async (options) => {
      const handler = mock.__handlers.input
      return handler ? handler(options) : undefined
    },
    showOpenDialog: async (options) => {
      const handler = mock.__handlers.openDialog
      return handler ? handler(options) : undefined
    },
    createOutputChannel: () => ({
      appendLine() {},
      show() {},
      dispose() {},
    }),
  },
  workspace: {
    getConfiguration: (section) => ({
      get: (key, fallback) => {
        const full = section ? `${section}.${key}` : key
        const value = mock.__config[full]
        return value === undefined ? fallback : value
      },
      update: async (key, value) => {
        const full = section ? `${section}.${key}` : key
        mock.__config[full] = value
      },
    }),
    onDidChangeTextDocument: (listener) => {
      mock.__changeListeners.push(listener)
      return {
        dispose() {
          const index = mock.__changeListeners.indexOf(listener)
          if (index >= 0) mock.__changeListeners.splice(index, 1)
        },
      }
    },
    onDidCloseTextDocument: (listener) => {
      mock.__closeListeners.push(listener)
      return {
        dispose() {
          const index = mock.__closeListeners.indexOf(listener)
          if (index >= 0) mock.__closeListeners.splice(index, 1)
        },
      }
    },
    applyEdit: async (edit) => {
      if (!edit || !edit._ops) return false
      for (const op of edit._ops) {
        const key = op.uri && op.uri.toString ? op.uri.toString() : String(op.uri)
        const doc = mock.__documents.get(key)
        if (!doc) continue
        const start = doc.offsetAt(op.range.start)
        const end = doc.offsetAt(op.range.end)
        const text = op.text === undefined ? '' : op.text
        doc._setText(doc.text.slice(0, start) + text + doc.text.slice(end))
        mock.__emitChange(doc, [
          { rangeOffset: start, rangeLength: end - start, text },
        ])
      }
      return true
    },
    fs: {
      readFile: async (uri) => {
        const handler = mock.__handlers.fsRead
        return handler ? handler(uri) : new Uint8Array()
      },
    },
  },
  authentication: {
    getSession: async (provider, scopes, options) => {
      const handler = mock.__handlers.session
      if (handler) return handler(provider, scopes, options)
      return { accessToken: 'oauth-access-token' }
    },
  },
  commands: {
    executeCommand: async (command, ...args) => {
      mock.__lastCommand = { command, args }
      const handler = mock.__handlers.command
      return handler ? handler(command, ...args) : undefined
    },
  },
  languages: {
    match: (selector, document) => {
      const languageId = document && document.languageId
      if (Array.isArray(selector)) {
        return selector.includes(languageId) ? 1 : 0
      }
      if (typeof selector === 'string') {
        return selector === languageId ? 1 : 0
      }
      return 0
    },
  },
  Position: class {
    constructor(line, character) {
      this.line = line
      this.character = character
    }
  },
  Range: class {
    constructor(start, end) {
      this.start = start
      this.end = end
    }
  },
  Uri: class {
    constructor(path) {
      this.path = path
    }
    static parse(value) {
      const path = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
      return new mock.Uri(path)
    }
    toString() {
      return this.path
    }
  },
  EventEmitter: class {
    constructor() {
      this._listeners = []
      this.event = (listener) => {
        this._listeners.push(listener)
        return {
          dispose: () => {
            const index = this._listeners.indexOf(listener)
            if (index >= 0) this._listeners.splice(index, 1)
          },
        }
      }
    }
    fire(data) {
      for (const listener of [...this._listeners]) listener(data)
    }
    dispose() {
      this._listeners = []
    }
  },
  DocumentDropOrPasteEditKind: class {
    constructor(parts) {
      this.parts = parts || []
    }
    static get Empty() {
      return new mock.DocumentDropOrPasteEditKind([])
    }
    append(...parts) {
      return new mock.DocumentDropOrPasteEditKind([...this.parts, ...parts])
    }
  },
  DocumentPasteEdit: class {
    constructor(text, title, kind) {
      this.text = text
      this.title = title
      this.kind = kind
      this.additionalEdit = undefined
    }
  },
  DocumentDropEdit: class {
    constructor(text, title, kind) {
      this.text = text
      this.title = title
      this.kind = kind
    }
  },
  WorkspaceEdit: class {
    constructor() {
      this._ops = []
    }
    replace(uri, range, text) {
      this._ops.push({ uri, range, text })
      return this
    }
    delete(uri, range) {
      this._ops.push({ uri, range, text: '' })
      return this
    }
  },
  __config: {},
  __handlers: {},
  __documents: new Map(),
  __changeListeners: [],
  __closeListeners: [],
  __lastCommand: undefined,
  __emitChange(document, contentChanges) {
    for (const listener of [...mock.__changeListeners]) {
      listener({ document, contentChanges: contentChanges || [] })
    }
  },
  __emitClose(document) {
    document.isClosed = true
    for (const listener of [...mock.__closeListeners]) listener(document)
  },
  __reset() {
    for (const key of Object.keys(mock.__config)) delete mock.__config[key]
    for (const key of Object.keys(mock.__handlers)) delete mock.__handlers[key]
    mock.__documents.clear()
    mock.__changeListeners.length = 0
    mock.__closeListeners.length = 0
    mock.__lastCommand = undefined
    mock.env.uiKind = mock.UIKind.Web
  },
}

mock.env = { uiKind: mock.UIKind.Web }

module.exports = mock
