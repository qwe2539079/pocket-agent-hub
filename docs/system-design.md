# System Design

## Objective

Define the technical baseline for a single-user, phone-driven, local-first agent hub.

## High-Level Architecture

The system is split into five layers.

1. `channels`
Inbound and outbound transport adapters for Feishu and personal WeChat.

2. `core`
Canonical message types, session model, routing, orchestration, and task lifecycle.

3. `agents`
Adapters for local agent backends such as Codex, Claude Code, and Gemini.

4. `policies`
Permission rules, persona restrictions, approval requirements, and actor checks.

5. `storage`
File-based persistence for config snapshots, session state, audit events, and project registry.

## Runtime Flow

1. a channel adapter receives an inbound message event
2. the channel adapter normalizes it into a common `HubMessage`
3. the router resolves actor, persona, target project, and target agent
4. the policy engine validates whether the request is allowed
5. the agent adapter handles execution or continuation
6. the system stores session and audit updates
7. the channel adapter sends a reply or incremental updates back to the phone

## Core Domain Concepts

## Actor

Represents the mobile identity making a request.

Fields:

- channel
- platform user id
- display name
- trust level
- allowed personas

## Persona

Represents an operating mode.

Initial personas:

- `dev-control`
- `daily-assistant`

## Project

Represents a known local working context.

Expected fields:

- stable project id
- local path
- default agent preference
- risk profile
- allowed commands or capabilities

## Session

Represents a continuing unit of work, not just a chat transcript.

Expected fields:

- session id
- project id
- persona
- target agent
- summary
- last activity time
- status
- channel thread mapping

## Task State

Represents the current execution state.

Expected statuses:

- `idle`
- `running`
- `waiting-approval`
- `blocked`
- `completed`
- `failed`
- `cancelled`

## Channel Layer

Responsibilities:

- receive platform events
- verify inbound authenticity where supported
- map platform message structure to internal messages
- send outbound replies, summaries, and notifications
- preserve minimal transport-specific metadata only

Non-responsibilities:

- business logic
- routing decisions
- agent execution semantics

## Agent Layer

Responsibilities:

- convert internal requests into local agent operations
- normalize output into a shared response model
- expose capability metadata such as `supportsContinue`, `supportsInterrupt`, and `supportsDiffSummary`

Non-responsibilities:

- channel protocol handling
- actor authorization
- long-term storage strategy

## Routing Model

The router should resolve requests in this order:

1. actor validation
2. persona resolution
3. project resolution
4. agent resolution
5. policy validation
6. execution or summary path

Resolution hints may come from:

- explicit command prefixes
- saved default project for a channel thread
- named project aliases
- current active session for the actor

## Storage Model

The first implementation should stay file-based for simplicity and inspectability.

Suggested persisted artifacts:

- `runtime/sessions/*.json`
- `runtime/audit/*.jsonl`
- `runtime/projects/projects.json`
- `runtime/channel-state/*.json`

Reasoning:

- easy local debugging
- low operational overhead
- easy backup and migration
- suitable for single-user MVP

## Deployment Model

MVP target:

- Ubuntu systemd user service or system service
- one always-on daemon process
- local config file and local runtime state directory

## Technical Stack Baseline

Current scaffold uses `Node.js + TypeScript`.

Reasons to keep it for MVP:

- fastest path for adapter iteration
- easy JSON-based config and state handling
- good fit for chat integration and local process orchestration
- low friction with existing environment on the workstation

Conditions that may justify later migration of some components:

- if the daemon needs stronger process isolation primitives
- if long-term transport adapters need a standalone binary distribution story
- if memory footprint or concurrency characteristics become a real constraint

## Design Constraints

1. transport adapters must stay thin
2. persona logic must not leak into channel code
3. agent-specific quirks must stay inside adapters
4. all dangerous behavior must route through policy checks
5. summaries must be first-class outputs, not derived ad hoc later

## MVP Technical Deliverables

1. config loading and validation
2. project registry model
3. session registry with persistence
4. Feishu adapter
5. personal WeChat adapter
6. Codex adapter
7. policy engine with explicit approval hooks
8. task summary formatter
9. notification service
