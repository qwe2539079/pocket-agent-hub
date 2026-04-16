# Product Requirements Document

## Product Name

Pocket Agent Hub

## Problem Statement

The user has a permanently-on Ubuntu workstation that serves as the primary development machine. Core coding work happens locally with tools such as `Codex`, `Claude Code`, and later `Gemini`. The user is frequently away from the desk and needs a mobile-first way to continue, redirect, inspect, and manage ongoing agent work without falling back to remote desktop tools such as RustDesk.

A second need exists alongside development control: the same workstation should expose a low-friction daily assistant experience through phone chat, similar to a consumer AI app, but backed by the user's own machine, tools, and local context.

## Product Vision

Turn the Ubuntu workstation into a persistent personal agent hub that can be reached from a phone through `Feishu` and personal `WeChat`, with clear separation between high-risk development control and low-risk daily assistant behavior.

## Reference Inspiration

This product is informed by three reference repositories, but is not a direct fork of any one of them.

- `claude-to-im-plus`: IM bridge, mobile handoff ideas, local coding-agent orientation
- `cc-connect`: multi-agent routing, long-running daemon model, channel abstraction, policy boundaries
- `Claude-to-IM-skill`: lightweight local daemon, approval-oriented chat bridge, simple operating model

## Primary Users

- single primary operator: the workstation owner
- future optional trusted operators: not in MVP, but should not be structurally blocked

## Core Goals

1. Continue active coding tasks from a phone.
2. Start new development tasks from a phone against known projects.
3. Inspect status of long-running tasks without opening remote desktop.
4. Use a safe daily-assistant chat mode for non-coding requests.
5. Keep execution, repositories, credentials, and state anchored to the Ubuntu workstation.
6. Support more than one local agent backend over time.

## Non-Goals For MVP

- multi-user shared tenancy
- browser-based admin panel
- voice interaction
- autonomous background agents modifying many repos without explicit user instruction
- cloud-hosted execution plane
- replacing native IDE workflows on desktop

## Key Scenarios

## Scenario A: Development Handoff

The user starts a coding task at the workstation, leaves the desk, and later asks from Feishu or WeChat:

- what is the current task state
- what files changed
- what is blocked
- continue with a new instruction
- stop the current task

## Scenario B: Mobile-Initiated Development Task

The user sends a message from the phone such as:

- open project `foo` and investigate failing tests
- continue the API refactor in `bar`
- summarize current diff in `baz`

The hub should map the request to a known project and route it to an allowed local agent.

## Scenario C: Daily Assistant

The user asks non-coding questions such as:

- explain a technical concept
- summarize notes
- draft a message
- plan travel steps
- compare products

This mode should avoid dangerous workstation actions by default.

## Scenario D: Notification And Check-In

The workstation proactively reports:

- task completion
- blocked approvals
- test failures
- scheduled summaries
- repository drift or pending changes

## Product Modes

## Mode 1: `dev-control`

Purpose:
Use the phone as a control surface for real local development work.

Properties:

- project-aware
- may invoke local agents and tools
- approval-oriented
- higher risk
- auditable

## Mode 2: `daily-assistant`

Purpose:
Use the phone as a general-purpose assistant entry point.

Properties:

- low risk
- no direct shell-style command execution
- optimized for chat, writing, summarization, and research

## Supported Channels For MVP

- `Feishu`
- personal `WeChat`

## Supported Agent Backends

Priority order for implementation:

1. `Codex`
2. `Claude Code`
3. `Gemini`

Rationale:

- `Codex` and `Claude Code` are already in the user's active workflow
- `Gemini` is planned, but should not shape MVP complexity too early

## Functional Requirements

1. The system must run as a long-lived local daemon on Ubuntu.
2. The system must accept inbound messages from Feishu and personal WeChat.
3. The system must route each inbound message to a persona and a target project context.
4. The system must preserve session state for ongoing tasks.
5. The system must let the user inspect recent task summaries from the phone.
6. The system must allow explicit continuation of an existing task.
7. The system must expose a safe daily-assistant mode with strict action limits.
8. The system must log important events for later inspection.
9. The system must allow agent adapters to be added without rewriting channel logic.
10. The system must allow channel adapters to be added without rewriting agent logic.

## Safety Requirements

1. `daily-assistant` must never execute shell-style commands.
2. destructive command patterns must be blocked or require approval in `dev-control`.
3. mobile identity must be mapped to explicit allow rules.
4. high-risk actions must be logged with actor, time, channel, and target context.
5. secrets must remain stored locally on the workstation.

## Success Criteria For MVP

- the user can continue a known coding task from the phone
- the user can get a meaningful task summary from the phone
- the user can use a separate safe assistant mode for non-coding chat
- both channels can reach the daemon reliably
- the architecture can add `Gemini` later without redesigning the whole product

## Release Strategy

## v0.1 Planning Baseline

- formalize scope, architecture, and safety model
- keep current code as scaffold only

## v0.2 Operational MVP

- working Feishu connector
- working WeChat connector through a local gateway
- basic Codex adapter
- task sessions and summaries
- daily-assistant routing

## v0.3 Multi-Agent Control

- Claude Code adapter
- richer approvals
- better project registry
- notifications and scheduled summaries
