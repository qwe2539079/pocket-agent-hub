# Architecture

## Goal

Turn a continuously running Ubuntu workstation into a phone-driven agent hub without requiring remote desktop control.

## Core Constraints

- the workstation is the source of truth for repositories, tools, credentials, and long-lived sessions
- the phone is a command surface, not an execution environment
- development workflows and daily chat must have separate policy boundaries
- the first mobile channels are Feishu and personal WeChat

## Runtime Model

1. a channel connector receives a message
2. the router resolves the channel, user, persona, and target project
3. a policy evaluates whether the action is allowed
4. the selected agent adapter converts the request into a local CLI or SDK action
5. output is streamed back through the channel connector
6. the event and session state are persisted locally
