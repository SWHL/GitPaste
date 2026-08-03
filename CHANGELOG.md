# Changelog

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
