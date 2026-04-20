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

`src/config/load-config.ts` supports a recursive `extends` chain: a config JSON may set `"extends": "<relative-path>"` and its fields deep-merge over the parent. Cycles are detected and rejected at load time. `config/app.config.local.json` (gitignored) typically extends `config/app.config.example.json`. `bootstrap.ts` resolves the default config by trying `config/app.config.local.json` first, then the example. `storageDir` is resolved relative to the config file's directory — runtime state lands next to the config, not next to `process.cwd()`.

Project aliases (`projects[].aliases?: string[]`) resolve to the canonical project id in `ProjectRegistry` / `HubRouter`; `/project hub` and `/project pocket-agent-hub` produce the same downstream audit, session, and run records.

Per-persona sandbox (`personas[].sandboxOverride?`) wins over the agent's `AgentConfig.sandboxMode` when a run is started under that persona. Example ships with `daily-assistant = read-only`.

`POCKET_AGENT_HUB_SKIP_WARMUP=1` skips the boot-time warmup route so smoke tests and CI don't burn agent quota.

Do not commit `config/app.config.local.json`, tokens, or anything under `runtime/` (both are gitignored).

## Architecture

Five explicit layers wired together in `src/app/bootstrap.ts`:

- `channels/` — inbound/outbound transports (`feishu`, `weixin`). Feishu has two modes: `websocket` (default, uses `@larksuiteoapi/node-sdk` `WSClient` for outbound long-connection) and `webhook` (fallback HTTP server). WeChat connector is still a placeholder.
- `core/` — canonical `HubMessage`/`HubResponse` (`core/message.ts`), `HubRouter` (`core/router.ts`), `SessionRegistry` (`core/session.ts`), `ProjectRegistry` (`core/project.ts`).
- `agents/` — `AgentAdapter` implementations. `RunAdapter` (`src/agents/run-adapter.ts`) is the shared base that owns the full run lifecycle: spawn child CLI in project cwd, persist per-run state under `<storageDir>/<agent>/<sessionId>/<runId>/` (`run.json`, `<agent>.log`, `last-message.txt`), track `latest.json` and `current.json`, serve `listRuns` / `getRun` / `setCurrent` / `consumeCurrent` / `reconcileZombieRuns`, and notify via `NotificationCenter` on completion. Subclasses (`CodexAdapter`, `ClaudeAdapter`, `GeminiAdapter`) implement only `buildArgs(ctx)` and `attachStdio(child, outputStream, lastMessagePath)`. `ctx.sandboxMode` is the persona-override-aware effective mode.
- `policies/` — `PolicyEngine.assertAllowed()` gates by `PolicyKind` (`safe-chat` blocks `/shell`; `guarded-dev` blocks destructive shell patterns like `rm -rf`, `mkfs`, `shutdown`, `reboot`).
- `storage/` — `FileStore` (JSON read/write + JSONL append under `storageDir`), `AuditLog` (appends to `audit/events.jsonl`). `SessionRegistry` persists the full session set to `sessions/index.json` on every upsert.

`NotificationCenter` (`src/notifications/notification-center.ts`) is a cross-cutting dispatch bus: channel connectors register a `sendTextMessage`-style handler at startup and remember the outbound `chatId` per `(channel, actorId[, conversationId])` when a message arrives. Agents (like `CodexAdapter`) call `notifyActor(...)` on background completion to push results back to the originating chat. Long payloads are truncated at 3000 chars with a `[message truncated]` marker.

### Message flow

1. Channel connector receives an event, builds a `ParsedFeishuMessage` (or equivalent), then a `HubMessage` via `buildHubMessage` in `channels/feishu/protocol.ts`.
2. `HubRouter.route()`:
   - Handles session commands (`/current`, `/reset`, `/new`, `/list`, `/running`, `/resume <run-id>`) first and returns immediately.
   - If the message has no directives, inherits `persona`/`targetAgent`/`projectId` from the latest session for this `(channel, sender, conversation)` (falling back to latest-by-actor). This is the "follow-up continues the active task" behavior — tests cover it in `tests/runtime-foundation.test.ts`.
   - Validates and canonicalizes `message.projectId` via `ProjectRegistry.get` (accepts aliases). Agent selection order: `resolved.targetAgent` (from explicit directive or inherited session) → `project.defaultAgent` when the persona allows it → `personaConfig.allowedAgents[0]`. Then validates persona `allowedAgents` membership, writes an `audit` event (`allowed`/`blocked`), runs `PolicyEngine.assertAllowed()`, and dispatches to the selected `AgentAdapter`.
   - Upserts a session record keyed by the adapter's returned `sessionId` (adapters currently build this as `"<agentId>:<senderId>"`, which intentionally makes follow-ups share one session per sender).
3. Adapter returns `HubResponse { sessionId, text, requiresApproval? }`; the connector renders it back (Feishu appends `Session: …` and optional approval notice via `renderFeishuReply`).

### Feishu text directives

`parseCommandText` in `channels/feishu/protocol.ts` extracts:

- Persona: `/dev` → `dev-control`, `/daily` → `daily-assistant`.
- Agent: `/codex`, `/claude`, `/gemini`.
- Project: `/project <id-or-alias>` (consumes next token).
- Session commands: `/current`, `/reset`, `/new`.
- Run history: `/list`, `/running`, `/resume <run-id>` (`/resume` consumes the next token as the run id).
- Desktop takeover: `/desktop` (aggregate native sessions across adapters), `/takeover <session-id>` (consumes the next token as the native session uuid). Takeover writes a one-shot `native.json` pointer next to `current.json` in the storage dir; `RunAdapter.handle()` consumes it atomically (rename-then-read) before building the prompt, skips hub-side prompt injection, and passes the uuid through `BuildArgsContext.resumeNativeSessionId`. `ClaudeAdapter.buildArgs` turns that into `--resume <uuid>`. Only Claude implements `listNativeSessions()` today — it scans `$POCKET_AGENT_HUB_CLAUDE_SESSIONS_DIR || ${CLAUDE_CONFIG_DIR || $HOME/.claude}/projects` for `*/*.jsonl`.

The presence of any directive sets `hasDirectives=true`, which disables the "inherit from latest session" logic in the router. If no text remains after stripping directives, the original input is used as the prompt.

### Agent adapter specifics

Each subclass is thin and defines just its CLI shape:

- **Codex** — `codex exec -C <projectPath> [--profile <name>] --sandbox <mode> --output-last-message <path> <prompt>`. `--profile` is only added when `~/.codex/config.toml` contains `[profiles.<defaultProfile>]`. Codex writes the reply itself via `--output-last-message`, so `attachStdio` just pipes stdout+stderr into `codex.log` and does **not** pre-open `last-message.txt`.
- **Claude** — `claude -p --output-format text [--permission-mode <mode>] <prompt>`. `--permission-mode` comes from mapping `ctx.sandboxMode`: `danger-full-access` → `bypassPermissions`, `workspace-write` → `acceptEdits`, `read-only` → `plan`. `attachStdio` tees stdout into both `claude.log` and `last-message.txt` because claude prints the reply to stdout.
- **Gemini** — baseline `gemini -p <prompt>` (CLI shape is a reasonable default; adjust `buildArgs` if the deployed gemini CLI uses different flags). Same stdout-tee strategy as Claude.

All three share the base-class behavior: status queries detected by `isStatusQuery()` read `latest.json` instead of starting a new run; on `close` the base reads `last-message.txt`, writes the terminal `run.json` / `latest.json`, and calls `NotificationCenter.notifyActor(...)` with the reply and a shorter signal text. Completion-notification errors log `run`, `actor`, `channel`, and `conversation` so disk state can be cross-referenced.

## Tests

Use the Node built-in test runner (`node:test`, `assert/strict`) with `tsx` as the loader. Tests import source as `../src/.../*.js` — keep the `.js` specifier even for `.ts` files (ESM NodeNext requirement).

- `runtime-foundation.test.ts` — canonical router/session integration, directive routing, project alias canonicalization, `/list` / `/running` / `/resume` branches
- `codex-adapter.test.ts`, `claude-adapter.test.ts`, `gemini-adapter.test.ts` — per-agent run lifecycle exercised through a `fake-<agent>.mjs` script written to a temp dir (no real CLI calls)
- `project-registry.test.ts` — alias resolution and conflict detection
- `feishu-protocol.test.ts` — directive parsing including `/list /running /resume`
- `load-config.test.ts` — `extends` merge and cycle rejection
- `policy-engine.test.ts` — policy gates
- `feishu-webhook.test.ts` — webhook-mode event parsing and verification token
