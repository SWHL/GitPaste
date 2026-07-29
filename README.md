<p align="center">
  <img src="https://raw.githubusercontent.com/SWHL/GitPaste/refs/heads/main/assets/gitpaste-logo.png" width="128" height="128" alt="GitPaste logo">
</p>

[简体中文](./docs/README_ZH.md) ｜ English

# GitPaste

GitPaste uploads images to GitHub and inserts their public links into the active editor. It is a VS Code Web Extension, so the same extension runs in desktop VS Code, GitHub Codespaces, `vscode.dev`, and `github.dev`.

The first release supports GitHub only. The upload layer is provider-based so more storage platforms can be added without changing the editor and paste workflow.

> **Credential security:** vs-picgo's GitHub uploader requires the token to be written in plaintext to its configuration file. GitPaste does not write GitHub tokens to extension settings or `settings.json`. Use VS Code's built-in GitHub sign-in without managing a PAT, or provide a PAT that GitPaste stores in VS Code `SecretStorage`.

## Features

- Paste a clipboard image into Markdown and MDX in VS Code for the Web.
- Upload one or more images selected from the VS Code file picker.
- Upload an image from a workspace-relative path, VS Code URI, or HTTP URL.
- Authenticate with VS Code's built-in GitHub sign-in or a fine-grained personal access token.
- Customize the repository, branch, directory, filename, public URL, commit message, and inserted text.
- Use the same extension bundle in browser and desktop extension hosts.

## Setup

1. Run **GitPaste: Configure GitHub Repository** from the Command Palette.
2. Enter the target repository as `owner/repository`, followed by its branch and image directory.
3. Sign in with GitHub, or provide a fine-grained token with **Contents: Read and write** access to that repository.
4. Copy an image and open a Markdown or MDX file. In VS Code for the Web, paste with `Ctrl+V` or `Cmd+V`. On desktop, use `Ctrl+Alt+U` or `Cmd+Alt+U`.

Personal access tokens are stored in VS Code `SecretStorage`, not as plaintext configuration in `settings.json`.
For a fine-grained PAT, its **Resource owner** must own the target repository and its **Repository access** must include that repository. Organization repositories may also require administrator approval or SSO authorization.
After PAT authentication is selected, GitPaste asks for the PAT again if SecretStorage is unavailable instead of silently switching to VS Code's GitHub session.

## Commands

| Command | Windows/Linux | macOS |
| --- | --- | --- |
| Upload Image from Clipboard (desktop) | `Ctrl+Alt+U` | `Cmd+Alt+U` |
| Paste and Upload Image (Web) | `Ctrl+V` | `Cmd+V` |
| Upload Images from Explorer | `Ctrl+Alt+E` | `Cmd+Alt+E` |
| Upload Image from Path or URL | `Ctrl+Alt+O` | `Cmd+Alt+O` |
| Configure GitHub Repository | Command Palette | Command Palette |
| Set/Clear Personal Access Token | Command Palette | Command Palette |

Copy the image itself, not its URL. In VS Code for the Web, `Ctrl/Cmd+V` uploads image clipboard data while text and other clipboard content continue to use normal paste. The GitPaste clipboard shortcut is desktop-only because browsers expose binary clipboard data only through a real paste event.

## Settings

```json
{
  "gitpaste.github.repository": "owner/images",
  "gitpaste.github.branch": "main",
  "gitpaste.github.path": "images",
  "gitpaste.github.publicUrl": "",
  "gitpaste.fileNameFormat": "${yyyy}-${MM}-${dd}_${HH}-${mm}-${ss}-${random}${extName}",
  "gitpaste.includeImageName": true,
  "gitpaste.maxFileSizeMb": 20,
  "gitpaste.uploadOnPaste": true
}
```

GitPaste uses the raw `https://raw.githubusercontent.com/...` download URL returned by GitHub by default. Set `gitpaste.github.publicUrl` only when a custom URL template is required.
Use `gitpaste.outputFormat` to customize the inserted Markdown or HTML.
Set `gitpaste.includeImageName` to `false` to insert `![](${url})` instead of `![${uploadedName}](${url})` with the default output format.

Downloading arbitrary HTTP URLs is subject to the source server's browser CORS policy. Workspace files and pasted images do not have this limitation.

## Relationship to PicGo and vs-picgo

GitPaste is a browser-compatible rewrite derived from the MIT-licensed
[`PicGo/vs-picgo`](https://github.com/PicGo/vs-picgo) project. It retains the
original copyright notice required by the MIT license, but it is an independent
project and is not an official PicGo or vs-picgo release.

| Project | Primary role | Runtime | Storage support |
| --- | --- | --- | --- |
| [PicGo](https://github.com/Molunerfinn/PicGo) | Desktop image uploading application and plugin ecosystem | Desktop application | Multiple image hosts through built-in uploaders and plugins |
| [vs-picgo](https://github.com/PicGo/vs-picgo) | VS Code integration built around PicGo | Desktop VS Code and PicGo/Node.js components | PicGo uploaders and configuration |
| GitPaste | VS Code Web Extension focused on pasting images into editors | VS Code Web and desktop from the same browser-compatible bundle | GitHub Contents API in the current release |

GitPaste does not load PicGo plugins or PicGo/vs-picgo configuration. It uses
`gitpaste.*` settings, stores credentials in VS Code `SecretStorage`, and uploads
directly through the GitHub API. Existing PicGo or vs-picgo settings must be
configured again using the corresponding GitPaste settings.

The credential model is an intentional difference. The vs-picgo GitHub uploader
requires a token in its configuration file, which leaves the token as plaintext
configuration. GitPaste keeps tokens out of `gitpaste.*` settings: built-in GitHub
sign-in delegates authentication to VS Code, while PAT authentication stores the
secret in `SecretStorage` and only keeps the selected authentication method in
`settings.json`.

## Development

```sh
npm install
npm test
npm run package
```

`npm run package` emits `dist/web/extension.js`, a single Web Worker bundle. VS Code desktop can run the same browser entry point.

## License

MIT. See the `LICENSE` file for GitPaste and upstream copyright and license terms.
