# Changelog

## 0.5.2

- Always review dot-rc JavaScript/TypeScript files, setup hooks and pre-commit configs in addition to the existing execution-config policy.
- Add `/ask` and `/agent` as explicit overrides without a mode picker or forced-edit retries.
- Increase the default round limit from 12 to 20; show the current request and remaining rounds independently of browser status messages. Explicitly configured limits remain respected.
- Remove the redundant session-to-page map and use the browser's single active page directly.
- Add new-chat lifecycle, retry and cancellation coverage alongside the existing stale-sync race tests. Reject cancellation received during web preparation or immediately before agent construction.

## 0.5.1

- Remove word-triggered forced-edit retries. Unknown edit wording retains normal tools; explicit explanation/advice questions and read-only shortcuts cannot apply changes. Report the actual applied-file count separately from model text.
- Expand mandatory review to executable test/tool configs, pytest/tox/nox files, Cargo settings and Gradle/Maven wrappers. Group command-review changes by current versus earlier request without dropping earlier evidence.
- Reuse the current automation tab for history/new-chat navigation, prune closed references and preserve manually written web drafts.
- Invalidate pending history sync on chat selection, new chat, task start and cancellation. Reject stale snapshots even after switching away and back to the same session.
- Extract conversation, model-selection and file-change/command controllers from the extension entry point.
- Keep the 12,000-character default. Bound tool batches to 1–4 calls by input budget (2 at the default), explicitly defer excess calls, and inspect fewer source files initially.
- Pin all direct runtime/development dependencies to the exact lockfile versions.

## 0.5.0

- Keep the first request queued through login/MFA, new authentication tabs and composer hydration. Retry only confirmed pre-submit resets; restore failed tasks without overwriting new drafts.
- Deduplicate semantically identical JSON across response widgets and key order while rejecting genuinely conflicting actions.
- Replace the Ask/Plan/Agent picker with natural-language intent routing. Retain read-only analysis and explicit change/command approvals.
- Read account-visible web model menus, including nested More menus, and apply selections through the web UI.
- Render assistant Markdown headings, lists, tables and code with copy buttons. Disable raw HTML, script links and remote images.
- Map local sessions to web conversation URLs. Poll the current rendered web conversation while idle, merge manual web turns without replaying actions, and reopen linked chats from local history. No full-account archive/deletion synchronization.

## 0.4.0

- Inspect the workspace locally before the first model request: rank project/source files and send bounded real file reads automatically, without requiring attachments or an initial model tool call.
- Add a browser-independent project check that reads source and creates/reads/deletes its own temporary file to verify local write access.
- Raise the default text-file limit from 128KB to 16MB (configurable up to 128MB). Charge edit payload size rather than the complete resulting file against the batch budget.
- Page within long lines using startColumn/nextColumn; support scoped directory listings/search and UTF-16 BOM source files.
- Accept tool arguments in standard nested object/JSON-string wrappers while retaining path/hash protections.
- Do not report requested edits complete when no file changes were applied. Show read counts, the selected project and explicit review-wait status.

## 0.3.1

- Collect rendered JSON from tenant-specific code widgets, highlighted spans, open shadow roots and child frames, beyond pre/code tags.
- Parse balanced JSON objects surrounded by language headings/copy controls. Normalize editor whitespace only outside JSON strings.
- Ignore disabled/unrelated Stop controls and stabilize the parsed JSON rather than changing copy/footer text.
- Reject outgoing prompt echoes, stale IDs and conflicting current-turn responses. Protocol examples now use placeholder IDs.
- Add response-stage diagnostics with candidate counts, ID matches, parsing and generation state; never log captured response bodies.

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
