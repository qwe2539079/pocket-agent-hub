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

The repository currently contains a validated scaffold plus the repository baseline needed for long-term maintenance. Runtime features are intentionally incomplete and will continue to follow the product and system decisions documented locally on the workstation.

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

## Feishu Codex Usage

The current verified mobile workflow is `Feishu -> Codex -> automatic completion notification`.

Use this format in Feishu to start a real Codex task:

```text
/dev /codex /project pocket-agent-hub <task description>
```

Use this format to check the latest task status manually:

```text
/dev /codex /project pocket-agent-hub 查看当前项目状态
```

Current behavior:

- the first message starts a real background `codex exec` run on the workstation
- Feishu returns an immediate `started task` response with a run id
- you can query status manually while the task is still running
- when the run completes or fails, Feishu now pushes the result back automatically
- follow-up messages in the same Feishu chat continue the active session by default
- `/current` shows the active session bound to the current conversation
- `/reset` clears the active session for the current conversation
- `/new` forces the next request to start fresh without reusing the last conversation session

A detailed Chinese operating guide is kept locally on the workstation at `docs/feishu-codex-guide.md`.

## Acknowledgements

This project reuses ideas from the following repositories and adapts them to a local-first, single-workstation control plane:

- [`claude-to-im-plus`](https://github.com/JiangJingC/claude-to-im-plus) for the daemon bridge pattern and persistent mobile access model
- [`cc-connect`](https://github.com/chenhg5/cc-connect) for explicit session controls, conversation isolation ideas, and IM-oriented agent UX
- [`Claude-to-IM-skill`](https://github.com/op7418/Claude-to-IM-skill) for the earlier bridge workflow that helped shape the channel-agent integration direction

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
