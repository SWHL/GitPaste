# Changelog

## 0.7.2

### Added

- Added a shared `src/util.ts` module with tested helpers (`errorMessage`, `formatBytes`, `toBase64`, `pathBaseName`, `rawGitHubUrl`, `dedupKey`, `contentHash`, `mapWithConcurrency`, `preflightContentLength`), removing duplicated logic across the extension, service, paste provider, and command entry points.
- Added ESLint (flat config), Prettier, and EditorConfig plus `lint`, `format`, and `format:check` scripts; the CI pipeline now runs a `lint` step.
- Added a `rawGitHubUrl` builder in `public-url.ts` as the single source for `raw.githubusercontent.com` URLs.
- Added `HEAD`-based size preflight for URL uploads: oversized images are rejected before the full body is downloaded, with a `GET` fallback validation.
- Split `getConfig` into a pure `readConfig()` and an interactive `ensureRepository()`.

### Improved

- **Cancellation is now propagated to HTTP requests.** VS Code cancellation tokens are bridged to `AbortSignal`, so canceling an upload or dismissing the progress notification actually aborts the in-flight `fetch` calls to GitHub (`src/service.ts`, `src/providers/github.ts`).
- **Upload failures are reported instead of swallowed.** When an entire batch fails (or is skipped), GitPaste throws a descriptive error rather than a `CancellationError`, so a silently dropped upload is no longer possible. User-initiated cancellations remain distinct and trigger rollback of created files.
- **Batch failures use a single aggregated dialog.** A whole failed batch is presented once with Retry all / Skip failed / Stop, instead of one stacked modal per image.
- **Paste placeholder application is robust to coalesced edits and auto-formatting.** Placeholder detection is now text-based (`src/paste-placeholder.ts`) rather than depending on an exact `contentChange` match, so uploads start reliably even when the editor merges or reformats the insertion.- Rewrote `toBase64` to accumulate chunks in an array and join once, removing the `String.fromCharCode(...)` spread that could overflow the argument limit on large files and the O(n²) string concatenation.
- Replaced the drag-and-paste deduplication key (`Array.from(image.data).join(',')`, which serialized the entire image) with file length + name + FNV-1a content hash.
- Multi-image uploads now run with bounded concurrency (3 at a time) instead of strictly sequentially, while preserving per-image retry, skip, cancellation, and cleanup.
- `formatBytes` now adapts between B, KB, MB, and GB instead of always reporting megabytes.
- Personal access tokens are now validated before being stored: `setToken`, `configure`, and the `getToken` PAT fallback all verify the token first and persist it only on success.

### Fixed

- Added a runtime validation for `gitpaste.maxFileSizeMb`: values outside the `1`–`100` MB range (or a non-number) are rejected with a clear message instead of being silently accepted.
- Concurrency uploads now return results in input order so multi-image Markdown links are inserted into the correct placeholders.
- `preflightContentLength` treats a missing `content-length` header as unknown instead of misreading `Number(null)` (`0`) as a valid size.
- The SHA-256 digest call in `naming.ts` now uses a precise `BufferSource` assertion instead of `any`.
- The test TypeScript configuration now includes the `WebWorker` lib so web globals used by source modules type-check under `tsc -p tsconfig.test.json`.
- The CI web integration tests no longer block releases: they run as a separate `continue-on-error` job, and the pinned VS Code commit is documented inline.

### Tests

- Added a minimal `vscode` mock and resolver so `service.ts` and `credentials.ts` run under `node --test` without a VS Code host.
- Added `test/service.test.ts` (single/multi upload, cancellation propagation, overwrite/rename conflict handling, hash-mode reuse, total-failure reporting, delete + abort) and `test/credentials.test.ts` (OAuth vs PAT, prompt/verify/persist, dismissal, sign-in cleanup).
- Added `test/paste-placeholder.test.ts` covering single/multi-image detection, partial placeholders, and CRLF-resilient detection.
- Added `test/util.test.ts` covering every shared helper, including a large-payload `toBase64` round-trip, `formatBytes` unit boundaries, `dedupKey`, and `mapWithConcurrency` ordering, limit, and error propagation.
- Added `rawGitHubUrl` builder coverage in `test/public-url.test.ts`.
- Added `test/paste-provider.test.ts` and `test/tracked-document-range.test.ts`, closing the last unit-test coverage gap (module coverage is now 16/16). The paste provider tests exercise the paste guard, drop delegation, web placeholder plus upload orchestration, replacement, `pasteFromClipboard`, explicit paste requests, drag-and-drop uploads including `text/uri-list` parsing, de-duplication, non-image skipping, and cancellation. The range tracker tests cover validity, insertion offsets, overlap and document-close invalidation, `dispose`, and `resolve`.
- Added `test/support/fake-document.ts` with `FakeTextDocument` and `FakeDataTransfer`/`FakeDataTransferItem` plus `imageItem`/`uriListItem` helpers.
- Extended `test/support/vscode-mock.cjs` with `Range`, `Position`, `Uri`, `EventEmitter`, `DocumentDropOrPasteEditKind`, `DocumentPasteEdit`, `DocumentDropEdit`, `WorkspaceEdit`, `commands`, `languages`, workspace change/close event registration and emission, `applyEdit`, `fs`, and a document registry, so the paste provider and range tracker run under `node --test`.
- Updated `tsconfig.test.json` to include the new support module.

### CI

- Added a `pull_request` gate to `.github/workflows/ci.yml`. Pull requests run lint, type-check, and unit tests; release and web-tests remain tag-only.

## 0.7.1

### Fixed

- Fixed desktop clipboard image uploads on macOS when VS Code exposes clipboard images with the `files` MIME type.
- Kept explicit clipboard upload requests available until the paste provider consumes them, covering delayed macOS paste dispatch.

### Tests

- Added regression coverage for desktop shortcut declarations and delayed explicit paste requests.

## 0.7.0

### Added

- Added optional SHA-256 content-addressed upload paths with duplicate image reuse. The default timestamp naming strategy remains unchanged.
- Drag and drop one or more image files into Markdown or MDX editors. Images are inserted at the drop position and use the existing upload progress, cancellation, and cleanup flow.

### Improved

- GitHub uploads, file lookups, deletions, and configuration checks now share a timeout-aware request layer with cancellation support.
- Network failures and transient GitHub responses (`408`, `429`, `500`, `502`, `503`, and `504`) are retried automatically with bounded exponential backoff. GitPaste also honors `Retry-After` and GitHub's rate-limit headers.
- GitHub errors now distinguish request timeouts and network failures, preserve actionable permission guidance, and include the remaining API quota and reset time when available.

### Fixed

- Keep **Delete GitPaste Image** available in Markdown and MDX editor context menus even when the cursor context has not finished updating. The command still validates the image syntax, repository mapping, and supported extension before deleting anything.
- Treat the end of a Markdown image and the end of its URL as outside the image, preventing boundary-position misclassification.

### Tests

- Added coverage for automatic recovery during uploads and file lookups, plus rate-limited deletion and API quota reporting.

## 0.6.1

### Improved

- GitPaste commands in the editor context menu and Command Palette now use a clear `GitPaste: ...` prefix, making them easier to distinguish from VS Code and other extensions.
- Removed redundant command categories so GitPaste commands do not display a duplicated prefix in the Command Palette.

## 0.6.0

### Added

- Added **Delete GitPaste Image** to the Markdown/MDX editor context menu and Command Palette. When the cursor is on a managed image URL, GitPaste confirms the target, deletes the GitHub file, and removes the local Markdown reference.
- Added a guidance prompt for image pastes in Plain Text or other unsupported language modes. The prompt explains that Markdown or MDX is required and can open the language mode selector directly.

### Improved

- The delete command only operates when the current URL maps to the configured GitHub repository, branch, public URL template, and image directory, with a supported image extension.
- Ordinary text pastes and existing Markdown/MDX upload and replacement workflows remain unchanged.

### Safety and Compatibility

- Image deletion requires explicit confirmation and creates a GitHub deletion commit; it can break other references to the same URL and does not erase Git history.
- Added regression coverage for command registration, menu conditions, URL recognition, unsupported-language paste guidance, and the existing upload/replacement flows.

## 0.5.0

### Improved

- Image paste uploads now use a two-stage editor flow in desktop VS Code and VS Code for the Web. GitPaste immediately inserts a GitHub-style `![Uploading filename...]()` placeholder, then replaces it with the final Markdown image link after the upload completes.
- Uploads now begin only after the placeholder has been accepted by the editor, so users receive immediate feedback and can continue editing while the image is uploaded.
- Image replacement uses the same placeholder flow, keeping the replacement target stable while the upload runs.

## 0.4.1

### Fixed

- Command-based uploads now keep the insertion target captured when the command starts and track edits before that target instead of following later cursor movement.
- Paste uploads now verify that the editor applied the returned Markdown and offer cleanup when a canceled paste completed its remote upload.
- Image replacement now tolerates unrelated document edits while canceling safely if the target image itself changes.

## 0.4.0

### Fixed

- **Replace Image at Cursor** now works in VS Code for the Web by accepting the next pasted image as the replacement, while desktop continues to use the file picker.
- Pending Web replacement requests now expire after 60 seconds and are canceled when the target changes.

## 0.3.0

### Added

- Added workspace-scoped repository configuration. **Configure GitHub Repository** now lets each project use its own repository, branch, and image directory while preserving global settings as the fallback.
- Added **GitPaste: Check Configuration** to validate repository syntax, write permission, branch access, repository paths, conflict settings, and filename, public URL, commit message, and output templates without creating a test commit.
- Added **GitPaste: Replace Image at Cursor** for inline Markdown images. It uploads a replacement, updates the Markdown, and can optionally delete the old GitHub file when the old URL maps unambiguously to the configured repository.
- Added `gitpaste.github.conflictStrategy` with `rename`, `overwrite`, and `prompt` modes. The default `rename` mode preserves existing files by adding a numeric suffix.

### Improved

- Multi-image uploads can now retry a failed image, skip it and continue, or stop the batch.
- Stopped and incomplete command-based uploads can clean up files newly created earlier in the same operation.
- Existing remote files are read before overwrite and deletion operations so GitHub receives the current file SHA.
- Configuration errors now fail early with actionable messages instead of surfacing during the first upload.
- Expanded the English and Chinese documentation with workflow guidance, safety boundaries, complete setting descriptions, and template variable references.

### Safety and Compatibility

- Cleanup never deletes overwritten files because GitPaste does not retain their previous contents.
- Cleanup verifies that a newly uploaded file still has the same SHA and refuses to delete a file changed by another process.
- Old-image deletion requires explicit confirmation and is only offered for URLs associated with the active GitPaste repository configuration.
- GitHub deletion creates a deletion commit; it does not erase the file from Git history or immediately invalidate every CDN cache.
- Desktop clipboard behavior is unchanged. `gitpaste.uploadOnPaste` remains Web-only, and desktop users continue to use the dedicated clipboard shortcut.
- Existing global settings remain valid. Workspace settings override global values only while that workspace is open.

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
