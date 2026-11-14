# Changelog

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
