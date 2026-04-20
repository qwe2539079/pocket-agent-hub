# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Scope

`Pocket Agent Hub` is a local-first control plane for a long-running Ubuntu workstation. It bridges mobile chat channels (Feishu, personal WeChat) to local coding agents (`Codex`, `Claude Code`, later `Gemini`) and a daily assistant. Execution stays on the workstation — the phone is a control surface, not an execution environment. Two personas are enforced throughout: `dev-control` (guarded real development) and `daily-assistant` (low-risk chat). See `README.md` for product framing; `docs/` is gitignored and contains workstation-local design notes that may be richer than what lives in the repo.

## Commands

Node `>=22.0.0`, ESM with `NodeNext` resolution, run via `tsx` (no bundler).

```bash
npm install
npm run check          # tsc --noEmit; run this before committing
npm test               # node --test --import tsx (all tests under tests/)
npm run dev            # tsx src/index.ts; uses config/app.config.local.json if present, else example
npm run dev:local      # tsx src/index.ts ./config/app.config.local.json (explicit)
npm run build          # tsc → dist/
```

Run a single test file or single test:

```bash
node --test --import tsx tests/codex-adapter.test.ts
node --test --import tsx --test-name-pattern='router continues' tests/runtime-foundation.test.ts
```

Pre-commit per `CONTRIBUTING.md`: always run `npm run check` and `npm test`. Commit message prefixes in use: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`.

## Configuration Model

`src/config/load-config.ts` supports a recursive `extends` chain: a config JSON may set `"extends": "<relative-path>"` and its fields deep-merge over the parent. `config/app.config.local.json` (gitignored) typically extends `config/app.config.example.json`. `bootstrap.ts` resolves the default config by trying `config/app.config.local.json` first, then the example. `storageDir` is resolved relative to the config file's directory — runtime state lands next to the config, not next to `process.cwd()`.

Do not commit `config/app.config.local.json`, tokens, or anything under `runtime/` (both are gitignored).

## Architecture

Five explicit layers wired together in `src/app/bootstrap.ts`:

- `channels/` — inbound/outbound transports (`feishu`, `weixin`). Feishu has two modes: `websocket` (default, uses `@larksuiteoapi/node-sdk` `WSClient` for outbound long-connection) and `webhook` (fallback HTTP server). WeChat connector is still a placeholder.
- `core/` — canonical `HubMessage`/`HubResponse` (`core/message.ts`), `HubRouter` (`core/router.ts`), `SessionRegistry` (`core/session.ts`), `ProjectRegistry` (`core/project.ts`).
- `agents/` — `AgentAdapter` implementations. `CodexAdapter` is the only production-track one; it spawns `codex exec` as a child process, persists per-run state under `<storageDir>/codex/<sessionId>/<runId>/`, and notifies on completion via the `NotificationCenter`. `ClaudeAdapter` and `GeminiAdapter` are stubs that echo the message.
- `policies/` — `PolicyEngine.assertAllowed()` gates by `PolicyKind` (`safe-chat` blocks `/shell`; `guarded-dev` blocks destructive shell patterns like `rm -rf`, `mkfs`, `shutdown`, `reboot`).
- `storage/` — `FileStore` (JSON read/write + JSONL append under `storageDir`), `AuditLog` (appends to `audit/events.jsonl`). `SessionRegistry` persists the full session set to `sessions/index.json` on every upsert.

`NotificationCenter` (`src/notifications/notification-center.ts`) is a cross-cutting dispatch bus: channel connectors register a `sendTextMessage`-style handler at startup and remember the outbound `chatId` per `(channel, actorId[, conversationId])` when a message arrives. Agents (like `CodexAdapter`) call `notifyActor(...)` on background completion to push results back to the originating chat. Long payloads are truncated at 3000 chars with a `[message truncated]` marker.

### Message flow

1. Channel connector receives an event, builds a `ParsedFeishuMessage` (or equivalent), then a `HubMessage` via `buildHubMessage` in `channels/feishu/protocol.ts`.
2. `HubRouter.route()`:
   - Handles session commands (`/current`, `/reset`) first and returns immediately.
   - If the message has no directives, inherits `persona`/`targetAgent`/`projectId` from the latest session for this `(channel, sender, conversation)` (falling back to latest-by-actor). This is the "follow-up continues the active task" behavior — tests cover it in `tests/runtime-foundation.test.ts`.
   - Validates the persona's `allowedAgents` and the project id, writes an `audit` event (`allowed`/`blocked`), runs `PolicyEngine.assertAllowed()`, then dispatches to the selected `AgentAdapter`.
   - Upserts a session record keyed by the adapter's returned `sessionId` (adapters currently build this as `"<agentId>:<senderId>"`, which intentionally makes follow-ups share one session per sender).
3. Adapter returns `HubResponse { sessionId, text, requiresApproval? }`; the connector renders it back (Feishu appends `Session: …` and optional approval notice via `renderFeishuReply`).

### Feishu text directives

`parseCommandText` in `channels/feishu/protocol.ts` extracts:

- Persona: `/dev` → `dev-control`, `/daily` → `daily-assistant`.
- Agent: `/codex`, `/claude`, `/gemini`.
- Project: `/project <id>` (consumes next token).
- Session commands: `/current` (show active session), `/reset` (clear active session), `/new` (force a fresh session on the next turn).

The presence of any directive sets `hasDirectives=true`, which disables the "inherit from latest session" logic in the router. If no text remains after stripping directives, the original input is used as the prompt.

### Codex adapter specifics

- `codex exec -C <projectPath> [--profile <name>] --sandbox <mode> --output-last-message <path> <prompt>`; `--profile` is only added when `~/.codex/config.toml` contains `[profiles.<defaultProfile>]`.
- Every run writes `run.json` and updates `latest.json` under `<storageDir>/codex/<sessionId>/`. stdout+stderr stream to `codex.log` in the run dir.
- Status queries are detected by `isStatusQuery()` (Chinese + English phrases like `查看当前项目状态`, `status`, `summary`); these read the latest run from disk instead of starting a new one.
- On `close`, reads the last-message file, persists the terminal state, and calls `NotificationCenter.notifyActor(...)` to push the completion (or failure with log tail) back to the originating Feishu chat.

## Tests

Use the Node built-in test runner (`node:test`, `assert/strict`) with `tsx` as the loader. Tests import source as `../src/.../*.js` — keep the `.js` specifier even for `.ts` files (ESM NodeNext requirement). `runtime-foundation.test.ts` is the canonical router/session integration test; `codex-adapter.test.ts` exercises the Codex run lifecycle with a fake `codex` binary; `feishu-protocol.test.ts` covers directive parsing; `load-config.test.ts` covers the `extends` merge; `policy-engine.test.ts` covers policy gates.
