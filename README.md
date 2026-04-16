# Pocket Agent Hub

`Pocket Agent Hub` is a local-first control plane for a permanently-on Ubuntu workstation. It exposes coding agents and a daily assistant through mobile chat channels instead of remote desktop tools.

## Why This Exists

The target workflow is specific:

- the main Ubuntu workstation stays on for long periods
- real work happens locally with `Codex`, `Claude Code`, and later `Gemini`
- the user often needs to leave the desk and continue from a phone
- the phone should act as a natural chat entry point, not a remote desktop session

The project is inspired by:

- [`claude-to-im-plus`](https://github.com/JiangJingC/claude-to-im-plus)
- [`cc-connect`](https://github.com/chenhg5/cc-connect)
- [`Claude-to-IM-skill`](https://github.com/op7418/Claude-to-IM-skill)

It is not a direct fork of those repositories. The goal is a more opinionated product for one permanently-on personal workstation with two phone channels: `Feishu` and personal `WeChat`.

## Current Status

The repository currently contains a validated scaffold and formal planning baseline. Runtime features are intentionally incomplete until the planning documents are treated as the source of truth.

## Planning Baseline

Start here before implementing features:

- [PRD](./docs/product-prd.md)
- [System Design](./docs/system-design.md)
- [Security Model](./docs/security-model.md)
- [Channel Strategy](./docs/channel-strategy.md)
- [Roadmap](./docs/roadmap.md)

## Working Model

The product is organized around two personas.

- `dev-control`: phone-driven continuation of real development tasks with policy gates
- `daily-assistant`: low-risk assistant behavior for chat, summaries, writing, and research

The architecture is organized into five layers.

- `channels/`: Feishu and WeChat transport adapters
- `core/`: canonical messages, sessions, routing, task state
- `agents/`: Codex, Claude Code, and Gemini adapters
- `policies/`: persona boundaries, approvals, and action restrictions
- `storage/`: local persistence for sessions, audit events, and project metadata

## Repository Layout

```text
config/
docs/
src/
tests/
```

## Local Development

```bash
npm install
npm run check
npm test
npm run dev
```
