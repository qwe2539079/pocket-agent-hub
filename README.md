# Pocket Agent Hub

[简体中文](./README.zh-CN.md)

Pocket Agent Hub is a local-first control plane for a permanently-on Ubuntu workstation. It exposes coding agents and a daily assistant through mobile chat channels instead of remote desktop tools.

## Why This Exists

The target workflow is specific:

- the main Ubuntu workstation stays on for long periods
- real work happens locally with `Codex`, `Claude Code`, and later `Gemini`
- the user often needs to leave the desk and continue from a phone
- the phone should act as a natural chat entry point instead of a remote desktop session

The project is inspired by:

- [`claude-to-im-plus`](https://github.com/JiangJingC/claude-to-im-plus)
- [`cc-connect`](https://github.com/chenhg5/cc-connect)
- [`Claude-to-IM-skill`](https://github.com/op7418/Claude-to-IM-skill)

It is not a direct fork of those repositories. The goal is a more opinionated product for one permanently-on personal workstation with two mobile channels: `Feishu` and personal `WeChat`.

## Current Status

- Runtime foundation, Feishu main channel, and agent integration (Codex / Claude / Gemini, all backed by the shared `RunAdapter` base) are production-ready on the workstation.
- Personal WeChat channel is still a placeholder; it has not been wired to a gateway yet.
- Subsequent work focuses on notifications, ergonomics, and documentation rather than core plumbing.

## Working Model

The product is organized around two personas:

- `dev-control`: phone-driven continuation of real development tasks with policy gates
- `daily-assistant`: low-risk assistant behavior for chat, summaries, writing, and research

The architecture is organized into five layers:

- `channels/`: Feishu and WeChat transport adapters
- `core/`: canonical messages, sessions, routing, task state
- `agents/`: Codex, Claude Code, and Gemini adapters
- `policies/`: persona boundaries, approvals, and action restrictions
- `storage/`: local persistence for sessions, audit events, and project metadata

## Repository Layout

```text
.github/
config/
src/
tests/
```

## Documentation Policy

- English is the default language for `README.md`
- Chinese documentation is available from [README.zh-CN.md](./README.zh-CN.md)
- local planning and detailed notes may exist on the workstation, but the `docs/` directory is not part of the published repository

## Local Development

```bash
npm install
npm run check
npm test
npm run dev
```

## Feishu Transport Strategy

The Feishu channel now supports two transport modes:

- `websocket`: primary mode, aligned with the long-connection approach used by the reference repositories
- `webhook`: fallback mode when you intentionally expose a public callback endpoint

The default sample configuration now uses `websocket`, so the workstation initiates the outbound connection itself instead of waiting for Feishu to call back in.

## Feishu Local Setup

The repository supports a private local override file:

- tracked template: `config/app.config.local.example.json`
- private runtime file: `config/app.config.local.json`

Recommended flow:

```bash
cp config/app.config.local.example.json config/app.config.local.json
```

Then edit `config/app.config.local.json` and fill:

- `channels.feishu.appId`
- `channels.feishu.appSecret`
- optionally adjust `channels.feishu.websocketUrl`

Start the local service with:

```bash
npm run dev:local
```

If you keep `mode: "websocket"`, the host only needs outbound network access.
If you switch to `mode: "webhook"`, you will still need a public HTTPS callback URL.

## Feishu Agent Usage

The verified mobile workflow is `Feishu → agent → automatic completion notification`, and all three agents (`/codex`, `/claude`, `/gemini`) share the same lifecycle.

Start a task:

```text
/dev /codex /project pocket-agent-hub <task description>
/dev /claude /project hub <task description>
```

Check the latest status manually:

```text
/dev /codex /project hub 查看当前项目状态
```

Directives recognized in Feishu text:

- persona: `/dev` (dev-control) or `/daily` (daily-assistant)
- agent: `/codex`, `/claude`, `/gemini`
- project: `/project <id-or-alias>`
- session: `/current` (show active session), `/reset` (clear it), `/new` (force a fresh session)
- run history: `/list` (recent runs), `/running` (currently running), `/resume <run-id>` (seed the next message from that run's reply)
- desktop takeover: `/desktop` (list native agent sessions on the workstation), `/takeover <session-id>` (continue one of them from this chat — close the desktop session first to avoid concurrent writes; only Claude is supported so far)

Messages without directives continue the latest active session for the conversation.

Project aliases and per-persona sandboxes are declared in the config — see the next section.

A detailed Chinese operating guide is kept locally on the workstation at `docs/feishu-codex-guide.md`.

## Configuration Essentials

- `projects[].aliases?: string[]` — shorter handles for `/project <alias>`. Example: declaring `"aliases": ["hub"]` on `pocket-agent-hub` lets `/project hub` work. Aliases must not collide with another project's id or with another alias.
- `personas[].sandboxOverride?: "read-only" | "workspace-write" | "danger-full-access"` — wins over the agent's configured `sandboxMode`. The shipped example locks `daily-assistant` to `read-only`, so chat-style interactions cannot edit the project even when routed to an agent that would default to `workspace-write`.
- `extends` chain in config files — any config JSON can set `"extends": "<relative-path>"` and its fields deep-merge over the parent. Cycles are detected and rejected at load time.

### Operational env vars

- `POCKET_AGENT_HUB_SKIP_WARMUP=1` — skips the boot-time warmup route so smoke tests and CI don't burn agent API / subscription quota. Startup log still prints the usual lines, just without a warmup response.

## Acknowledgements

This project reuses ideas from the following repositories and adapts them to a local-first, single-workstation control plane:

- [`claude-to-im-plus`](https://github.com/JiangJingC/claude-to-im-plus) for the daemon bridge pattern and persistent mobile access model
- [`cc-connect`](https://github.com/chenhg5/cc-connect) for explicit session controls, conversation isolation ideas, and IM-oriented agent UX
- [`Claude-to-IM-skill`](https://github.com/op7418/Claude-to-IM-skill) for the earlier bridge workflow that helped shape the channel-agent integration direction

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
