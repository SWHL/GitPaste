'use strict'

// Redirect `require('vscode')` to the local mock so `service.ts` and
// `credentials.ts` can run under `node --test` without a VS Code host.

const Module = require('module')
const path = require('path')

const mockPath = path.resolve(__dirname, 'vscode-mock.cjs')
const originalResolve = Module._resolveFilename

Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return mockPath
  return originalResolve.call(this, request, ...rest)
}
