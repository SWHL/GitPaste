# Contributing to GitPaste

Bug reports, feature proposals, documentation improvements, and code changes are
welcome. All participation must follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting issues

Search existing issues before opening a new one. For bugs, include:

- GitPaste and VS Code versions.
- VS Code environment: Web, desktop, Codespaces, `vscode.dev`, or `github.dev`.
- Document language and the exact steps to reproduce the problem.
- Relevant GitPaste output-channel messages and non-sensitive settings.

Never include personal access tokens, authorization headers, or other secrets.

## Development

GitPaste requires Node.js 22 or later.

```sh
npm ci
npm test
npm run test:web
npm run build
```

`npm test` runs type checking and unit tests. `npm run test:web` runs the extension
inside a headless VS Code Web host. `npm run build` creates `gitpaste.vsix`.

Keep changes focused, add tests for changed behavior, and update the English and
Chinese documentation when user-facing behavior changes.
