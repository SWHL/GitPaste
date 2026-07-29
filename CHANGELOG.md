# Changelog

## 0.2.0

- Added the `gitpaste.includeImageName` setting to control whether generated Markdown image links include the uploaded filename as alt text. It defaults to `true` to preserve existing output; set it to `false` to generate `![](${url})`.

## 0.1.0

- Rebuilt the extension as GitPaste with a browser-compatible entry point.
- Added automatic Markdown and MDX image paste uploads.
- Added GitHub Contents API uploads without desktop-only runtime dependencies.
- Added VS Code GitHub authentication and SecretStorage-backed personal access tokens.
- Added workspace file, URI, and HTTP URL upload commands.
- Added configurable filenames, repository paths, public URLs, commit messages, and output formats.
- Added a provider interface for future storage platforms.
- Added unit tests for naming, path safety, public URLs, and output formatting.
