# Changelog

## 0.3.0

- Add bounded line-range reads and exact partial edits for files up to 128KB. Reject unseen, ambiguous, overlapping or stale edit anchors.
- Always require review for execution configs, dependency manifests, build/CI files and shell scripts, even when normal edit review is disabled.
- Show agent-modified files and native diffs alongside command approval.
- Decode terminal output as streams; support UTF-8 and CP949 with matching Windows code pages.
- Search directly on disk without opening files in the editor. Expand credential/state/config exclusions.
- Extract webview rendering and review policy modules, fix indentation and enforce ESLint checks.
- Run the VS Code extension-host integration test in CI and guard packages/source archives against tracked test profiles.

- Replace the custom `m365-agent` response fence with standard `json`, retaining legacy response parsing.
- Compact requests into one paragraph with JSON-escaped file contents; reduce the default prompt cap from 48,000 to 12,000 characters.
- Verify rich-editor text using DOM text and paragraph structure, preserving code indentation while tolerating editor paragraph gaps and nonbreaking spaces.
- Read native input limits before filling. Rebuild context only after a confirmed pre-submit size rejection; never retry a clicked/unconfirmed Send.
- Distinguish actual truncation from other input changes, expose character counts in diagnostics, and clean only identifiable unsent automation drafts.
- Recover recognizable protocol drafts left by older versions while preserving ordinary user drafts.

## 0.2.0

- Fix requests left in the M365 composer: detect and click Send, wait for enabled state, and confirm submission before waiting for a response. Never blindly retry an unconfirmed submission.
- Chat-first sidebar with Enter / Shift+Enter, Korean IME support, code blocks, file attachments, tool progress and actionable errors.
- Ask and Plan modes enforce read-only tools; Agent mode supports reviewed edits and individually approved shell commands for tests/builds.
- Local conversation history (20 sessions), follow-up context, draft preservation and `/plan`, `/review`, `/test` shortcuts.
- Review changes by default; open native VS Code diffs, apply/reject, and undo the most recent edit batch while protecting subsequent user edits.
- Tests cover non-submitting Enter, disabled/unresponsive Send, read-only modes, command results, webview controls and VS Code integration.

Known limitation: authenticated company-tenant UI integration still requires verification in the user's environment. No inline completions, background agents or full parity with commercial coding agents.

## 0.1.0

- Initial experimental preview for Windows and Microsoft Edge.
- Automatic request and response exchange with an authenticated M365 Copilot web session through Playwright.
- Workspace file listing, reading, literal text search, file creation and file replacement.
- Optional diff review and automatic save after validation.
- File hash conflict checks, dirty-editor protection and workspace path boundaries.
- Local Edge protocol tests and a VS Code extension-host integration test.

Known limitation: authenticated company-tenant UI integration has not yet been verified. M365 page changes may require selector adjustments.
