# Channel Strategy

## Purpose

Define the role of each phone channel so the product does not collapse into one ambiguous chat surface.

## Channel Principles

1. each channel must have a clear reason to exist
2. persona behavior must stay consistent across channels
3. transport differences should not redefine security boundaries
4. one channel may be operationally primary without preventing the other from being useful

## Feishu Strategy

Role:
Primary operational control channel.

Reasons:

- better suited for structured bot workflows
- easier to operationalize for long-lived webhook integrations
- clearer automation affordances for approvals, notifications, and task summaries
- stronger fit for development-control conversations

Primary uses:

- task continuation
- status checks
- approvals
- proactive notifications
- project-targeted control

Desired characteristics:

- stable message delivery
- support for structured replies
- better future path for richer controls

## Personal WeChat Strategy

Role:
Convenient ambient access channel.

Reasons:

- highest personal reachability for the user
- useful when the user wants a low-friction phone entry point
- strong fit for quick questions, summaries, and lightweight handoff

Primary uses:

- quick daily-assistant chat
- short task summaries
- simple continue or pause instructions
- mobile check-ins when Feishu is not convenient

Constraints:

- should start with a more conservative security posture
- should not be the first place for the richest privileged control flows
- gateway dependency should stay isolated behind a connector layer

## Persona Mapping

Recommended default posture:

- `daily-assistant` available on both Feishu and personal WeChat
- `dev-control` available on Feishu first
- `dev-control` on personal WeChat can be enabled after connector stability and actor verification are proven

This allows the product to ship useful WeChat value early without forcing the highest-risk controls into the least formal channel from day one.

## Notification Strategy

Recommended split:

- important task-state notifications go to Feishu by default
- summary digests and convenience reminders may also mirror to personal WeChat

Reasoning:

- Feishu should become the operational source of truth
- WeChat should remain a high-convenience companion surface

## Failure Strategy

If one channel is unavailable:

- task execution remains on the workstation
- state remains local
- the other channel can still inspect or continue tasks where policy allows

The channel layer must never become the single holder of task state.

## Evolution Plan

Phase 1:

- Feishu first-class operational channel
- WeChat first-class convenience channel

Phase 2:

- parity for basic summaries and task continuation
- channel-specific formatting improvements

Phase 3:

- richer approvals on Feishu
- more selective dev-control enablement on WeChat
