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
- Replace the Markdown image under the cursor and optionally delete its old remote file.
- Authenticate with VS Code's built-in GitHub sign-in or a fine-grained personal access token.
- Customize the repository, branch, directory, filename, public URL, commit message, and inserted text.
- Handle filename conflicts by renaming, overwriting, or asking each time.
- Retry or skip failed batch items and clean up files from an incomplete upload.
- Use the same extension bundle in browser and desktop extension hosts.

## Setup

1. Run **GitPaste: Configure GitHub Repository** from the Command Palette.
2. Choose whether to save the repository for the current workspace or globally, then enter it as `owner/repository`, followed by its branch and image directory.
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
| Replace Image at Cursor | Command Palette or editor context menu; in Web, then paste the replacement image | Command Palette or editor context menu; in Web, then paste the replacement image |
| Check Configuration | Command Palette | Command Palette |
| Configure GitHub Repository | Command Palette | Command Palette |
| Set/Clear Personal Access Token | Command Palette | Command Palette |

Copy the image itself, not its URL. In VS Code for the Web, `Ctrl/Cmd+V` uploads image clipboard data while text and other clipboard content continue to use normal paste. The GitPaste clipboard shortcut is desktop-only because browsers expose binary clipboard data only through a real paste event.

## Repository Configuration Scope

**Configure GitHub Repository** asks where to save the repository, branch, and image directory:

- **Current workspace** writes them to workspace settings. Use this for project-specific image repositories. Workspace values take precedence over global values while that workspace is open.
- **Global** writes them to user settings and uses the same target in every project without a workspace override.

Credentials are never written to either settings scope. GitHub sessions are managed by VS Code, and PATs remain in VS Code `SecretStorage`.

## Filename Conflicts

`gitpaste.github.conflictStrategy` controls what happens when the generated remote path already exists.

| Value | Behavior | Important detail |
| --- | --- | --- |
| `rename` | Finds the first free numeric suffix, such as `photo-2.png` or `photo-3.png`. | Default and safest option; preserves the existing file. |
| `overwrite` | Reads the current GitHub file SHA and replaces that file. | Keeps the same remote path and normally the same public URL. The old content cannot be automatically restored by GitPaste. |
| `prompt` | Asks whether to rename or overwrite for each conflict. | Canceling stops the current operation. |

The default filename template includes `${random}`, so conflicts are uncommon unless the template is customized.

## Upload Failure Recovery

If one item in a multi-image upload fails, GitPaste shows the error and offers:

- **Retry**: retry the same image.
- **Skip**: leave that image out and continue with the remaining items.
- **Stop**: stop the batch and optionally delete files newly created earlier in that operation.

Cleanup never deletes a file that was overwritten, because GitPaste does not retain the previous file contents. Before deleting a newly created file, GitPaste reads its current SHA again and refuses to delete it if another process has changed it. Explorer and path/URL upload commands also offer cleanup if the remote upload succeeds but the editor edit fails.

## Replace an Image

Place the cursor anywhere inside an inline Markdown image such as `![old](https://example.com/old.png)`, then run **GitPaste: Replace Image at Cursor** from the Command Palette or editor context menu.

1. On desktop, select one replacement image. In VS Code for the Web, paste one image after running the command.
2. GitPaste uploads it using the normal filename and conflict settings.
3. GitPaste replaces the complete Markdown image at the cursor with the new generated output.
4. If the old URL can be mapped unambiguously to the configured repository, branch, and image directory, GitPaste offers to delete the old remote file.

Reference-style Markdown images such as `![old][image-id]` are not replaced. Old-file deletion is not offered for unrelated URLs or custom URL templates that cannot be reversed. If overwrite selects the same remote path, GitPaste keeps that path and does not offer to delete it.

In VS Code for the Web, the pending replacement expires after 60 seconds. It is also canceled if the target document or cursor position changes before the image is pasted.

Deleting a GitHub file creates a deletion commit on the configured branch. It does not erase the file from Git history, and a CDN may continue serving a cached response for some time. Deletion can also break other documents that reference the same URL, so GitPaste requires explicit confirmation.

## Check Configuration

Run **GitPaste: Check Configuration** to validate:

- repository syntax, repository write permission, and target branch access;
- safe repository paths and a non-empty commit message;
- the selected filename conflict strategy;
- filename, public URL, and output templates.

A custom public URL must be HTTP(S) and include `${path}`; the output template must include `${url}`. The check is read-only and does not create a test commit. GitHub branch protection or repository rules may still reject a later upload, and GitPaste does not test whether a custom CDN is currently reachable.

## Settings

```json
{
  "gitpaste.github.repository": "owner/images",
  "gitpaste.github.branch": "main",
  "gitpaste.github.path": "images",
  "gitpaste.github.publicUrl": "",
  "gitpaste.github.commitMessage": "Upload ${uploadedName} with GitPaste",
  "gitpaste.github.conflictStrategy": "rename",
  "gitpaste.fileNameFormat": "${yyyy}-${MM}-${dd}_${HH}-${mm}-${ss}-${random}${extName}",
  "gitpaste.outputFormat": "![${uploadedName}](${url})",
  "gitpaste.includeImageName": true,
  "gitpaste.maxFileSizeMb": 20,
  "gitpaste.uploadOnPaste": true
}
```

| Setting | Default | Explanation |
| --- | --- | --- |
| `gitpaste.github.repository` | `""` | Required `owner/repository` target. Configure it per workspace when projects use different repositories. |
| `gitpaste.github.branch` | `"main"` | Branch receiving upload and deletion commits. Branch names containing `/` are supported. |
| `gitpaste.github.path` | `"images"` | Directory inside the repository. Empty means the repository root; `..` segments are rejected. |
| `gitpaste.github.authenticationMethod` | `"github"` | `github` uses VS Code sign-in; `pat` uses the token in `SecretStorage`. Normally set by the configuration flow. |
| `gitpaste.github.publicUrl` | `""` | Empty uses GitHub's returned raw URL. A custom HTTP(S) template must include `${path}`. |
| `gitpaste.github.commitMessage` | `"Upload ${uploadedName} with GitPaste"` | Non-empty Git commit message template. Supports `${uploadedName}`. |
| `gitpaste.github.conflictStrategy` | `"rename"` | One of `rename`, `overwrite`, or `prompt`; see **Filename Conflicts**. |
| `gitpaste.fileNameFormat` | Date, time, and random suffix | Remote filename template. Missing image extensions are added from the source name or MIME type. |
| `gitpaste.outputFormat` | `![${uploadedName}](${url})` | Text inserted into the editor. Must include `${url}` and may generate Markdown or HTML. |
| `gitpaste.includeImageName` | `true` | When `false`, `${uploadedName}` becomes empty; the default output becomes `![](${url})`. |
| `gitpaste.maxFileSizeMb` | `20` | Client-side size limit for each image; allowed range is 1-100 MB. GitHub may impose additional limits. |
| `gitpaste.uploadOnPaste` | `true` | Enables ordinary image paste uploads in VS Code for the Web. It is intentionally ignored on desktop, where the dedicated shortcut remains required. |

### Template Variables

| Template | Variables |
| --- | --- |
| `gitpaste.fileNameFormat` | `${name}`, `${extName}`, `${timestamp}`, `${random}`, `${yyyy}`, `${MM}`, `${dd}`, `${HH}`, `${mm}`, `${ss}`, `${document}` |
| `gitpaste.github.publicUrl` | `${owner}`, `${repository}`, `${branch}`, `${path}` |
| `gitpaste.github.commitMessage` | `${uploadedName}` |
| `gitpaste.outputFormat` | `${uploadedName}`, `${originalName}`, `${url}` |

`${random}` is an eight-character hexadecimal value. `${timestamp}` is milliseconds since the Unix epoch. `${document}` is the active document filename after unsafe filename characters are replaced. `${path}` is URL-encoded one repository segment at a time.

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
