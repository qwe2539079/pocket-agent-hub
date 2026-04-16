# Security Model

## Security Goal

Provide useful phone-driven control over a personal development machine without turning chat messages into unrestricted remote shell access.

## Threat Model

Primary risks for MVP:

- unauthorized person sends messages through a configured channel
- authorized user accidentally triggers destructive actions from the phone
- a daily-assistant conversation crosses into development control without clear escalation
- channel credentials or local config leak from the workstation
- logs expose secrets or overly sensitive repository details

## Trust Assumptions

- the Ubuntu workstation is controlled by the primary user
- the initial deployment is single-user
- both mobile channels are user-operated, but neither should be treated as inherently trusted without explicit allow rules
- local agent CLIs may be powerful, so the hub must treat them as privileged capabilities

## Security Principles

1. separate low-risk chat from high-risk development control
2. default deny where intent is ambiguous
3. require explicit mapping from mobile identity to allowed personas
4. log privileged actions and important state changes
5. prefer project-scoped actions over machine-wide actions
6. preserve the workstation as the only place where secrets live

## Persona Boundaries

## `daily-assistant`

Allowed:

- question answering
- summaries
- drafting text
- planning and research
- asking about existing task status

Not allowed:

- shell-style command execution
- raw filesystem mutation
- arbitrary project switching with write intent
- destructive operations

## `dev-control`

Allowed in principle:

- continue known agent sessions
- request project summaries
- request investigation tasks
- request code changes through approved local agents

Restricted:

- destructive shell patterns
- operations outside registered project boundaries
- commands requiring elevated host privileges
- any action that bypasses explicit policy checks

## Actor Authentication And Authorization

Each mobile identity must map to a local actor record.

Required checks:

- channel identity is recognized
- actor is allowed on that channel
- actor is allowed to use the requested persona
- actor is allowed to access the requested project

MVP assumption:

- one trusted actor record for the primary user
- no wildcard open access

## Approval Model

Three approval levels are recommended.

## Level 0: auto-allow

Examples:

- status request
- summarize current task
- explain a concept in `daily-assistant`

## Level 1: confirmation required

Examples:

- continue a task with code modification intent
- switch active project
- run a non-destructive investigation command through an agent

## Level 2: blocked by policy

Examples:

- destructive shell patterns
- commands outside known project scope
- privileged host operations
- any shell-style request in `daily-assistant`

## Secrets Handling

Secrets should be stored only on the workstation.

Rules:

- channel credentials live in local config files or environment variables
- secrets must never be echoed in logs
- debug outputs must redact token-like fields
- no secrets are sent back to mobile chat replies

## Logging And Audit

Audit events should include:

- timestamp
- actor id
- channel
- persona
- target project
- target agent
- action type
- decision result

Sensitive fields should be redacted or summarized.

## Project Isolation

The product should move toward project-aware confinement rather than broad machine control.

MVP approach:

- maintain a project registry
- require project id or previously active project for write-intent tasks
- reject ambiguous write targets

## Operational Guidance

1. do not expose a catch-all shell command surface on mobile
2. do not share channel tokens across unrelated tools
3. do not use personal WeChat as the only path for high-risk actions once multiple channels are available
4. keep audit logs local and inspectable
5. add explicit cooldown or confirmation steps before dangerous transitions

## Future Security Enhancements

- per-project capability profiles
- signed approval challenge flow
- richer redaction pipeline
- local credential vault integration
- read-only mode for travel periods
