# Roadmap

## Planning Baseline

The repository now has a scaffold, but feature work should follow the formal planning documents in this directory rather than ad hoc implementation momentum.

## Milestone 0: Design Freeze

Goals:

- finalize PRD
- finalize system design
- finalize security model
- finalize channel strategy
- confirm MVP boundaries before more runtime work

Exit criteria:

- planning docs exist and are internally consistent
- README points to the planning baseline
- implementation priorities are explicit

## Milestone 1: Runtime Foundation

Goals:

- config loading and validation
- project registry model
- file-based persistence for sessions and audit events
- stable router and policy interfaces

Exit criteria:

- daemon can start with local config
- sessions survive restart
- audit events are persisted locally

## Milestone 2: Feishu Operational Path

Goals:

- inbound Feishu connector
- outbound replies and notifications
- actor mapping
- basic `daily-assistant` and `dev-control` routing on Feishu

Exit criteria:

- primary user can send a message from Feishu and receive a routed response
- task summary and continue flows work on Feishu

## Milestone 3: Personal WeChat Companion Path

Goals:

- personal WeChat gateway connector
- actor mapping and conservative policy defaults
- status, summaries, and low-risk assistant flows

Exit criteria:

- primary user can use WeChat for daily-assistant interactions
- WeChat can retrieve summaries for known tasks
- high-risk behavior remains policy-gated

## Milestone 4: Agent Integration

Goals:

- real Codex adapter
- real Claude Code adapter
- task status normalization
- project-aware continuation flow

Exit criteria:

- phone can continue an active Codex or Claude Code task against a known project
- summaries reflect real local task state

## Milestone 5: Notifications And Quality Of Life

Goals:

- proactive task notifications
- scheduled summaries
- project defaults and aliases
- better error reporting

Exit criteria:

- user receives useful push-like updates without polling
- mobile operation feels better than remote desktop for the target scenarios

## Deferred Until After MVP

- web admin panel
- multi-user tenancy
- advanced UI controls
- cloud execution
- voice interface
