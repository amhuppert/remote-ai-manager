# Product Overview

CC (Command Center) is a web control plane for managing parallel AI coding-agent sessions. Claude and Codex run behind one backend-neutral session model; each worktree-backed session has isolated git state while the UI provides creation, monitoring, interaction, review, and delivery.

## Core Capabilities

- **Project discovery** — scans configurable base directories for git repositories
- **Session lifecycle** — creates, monitors, and deletes worktree-backed sessions through normal or optimistic creation
- **Backend-neutral agent execution** — registered Claude and Codex descriptors provide conversation/task facets, capabilities, continuity, and failure policy
- **Live observability** — lossless backend transcript envelopes, rendered conversation messages, costs/usage when available, and computed git diffs
- **Real-time updates** — typed conversation, ticket, job, notification, workflow, and dev-server events over one SSE connection
- **Background jobs** — durable merge, commit, and conflict-resolution history with user notifications
- **Graph workflows** — declarative multi-context execution with task graphs, validation, retries, gates, and circuit breakers
- **Dev server automation** — per-session spawning, liveness polling, and remote URLs
- **Voice input** — Whisper-based prompt transcription

## Use Cases

- Run and compare parallel coding-agent sessions across multiple repositories
- Monitor transcripts, diffs, workflows, and attention states remotely
- Execute autonomous graph workflows while preserving review and delivery controls

## Value

Command Center turns isolated agent runs into a composable, observable development workflow without coupling product policy to one provider SDK.
