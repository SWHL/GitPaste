'use strict'

// Minimal VS Code API mock for `node --test` unit tests.
// Only the surface used by `service.ts` and `credentials.ts` is implemented.
// Test code configures behavior through `mock.__config` and `mock.__handlers`.

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
  },
  authentication: {
    getSession: async (provider, scopes, options) => {
      const handler = mock.__handlers.session
      if (handler) return handler(provider, scopes, options)
      return { accessToken: 'oauth-access-token' }
    },
  },
  __config: {},
  __handlers: {},
  __reset() {
    for (const key of Object.keys(mock.__config)) delete mock.__config[key]
    for (const key of Object.keys(mock.__handlers)) delete mock.__handlers[key]
  },
}

mock.env = { uiKind: mock.UIKind.Web }

module.exports = mock
