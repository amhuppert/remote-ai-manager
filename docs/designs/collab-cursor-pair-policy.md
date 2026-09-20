# Collaboration Mode: generalized pair policy (Cursor parity, ticket #119)

Collaboration Mode was designed and evidenced as a Claude × Codex pair, and its
eligibility, default pairing, lane dispatch, continuity, and card accents all
named those two backends. This design replaces that restriction with an
explicit participation policy that includes Cursor, without spreading
backend-name branches through the orchestrator or the UI.

## Decisions

### D1 — Participation is an explicit enum, not registration

`collaborationAgentSchema` (`src/lib/workflows/collaboration/types.ts`) lists
`claude`, `codex`, and `cursor`. A backend is added there only once its
participation is evidenced. Registering a task runner or a task facet admits
nothing: `collaborationBackendAdmission` refuses an outsider for the policy
reason (`pair_policy`) before it asks any facet question, and the manager's
`requireCollaborationAgent` throws `CollaborationBackendNotEligibleError` for
either lane before anything durable happens.

### D2 — Lane dispatch is policy data

`COLLABORATION_LANE_DISPATCH` maps each participant to how its lane runs:
Claude as a `conversation_turn` (it resumes the originating Claude
conversation with full context and holds background subagents open), Codex and
Cursor as a `task_run`. `callPrimitive` builds the request from this map, and
the admission gate reads the facet the dispatch uses — Claude needs the
conversation facet, task participants need the task facet.

### D3 — Default partners and the supported-pair matrix

`COLLABORATION_DEFAULT_PARTNER` (`backend-pair.ts`) names the suggested Agent
Two for each Agent One: Claude → Codex, Codex → Claude, Cursor → Claude. It is a
suggestion only; an explicit Agent Two (including the same backend) wins.
`COLLABORATION_SUPPORTED_PAIRS` writes out every ordered pair the flow admits —
today all nine, including same-backend pairs — and a test pins it to the full
cross product of the enum so a new participant must be placed in every
position deliberately. The manager consults `collaborationPairRefusal` after
resolving both backends.

Graph-workflow collaboration configures only `secondAgent`;
`resolveGraphCollaborationBackends` derives Agent One as that agent's default
partner and refuses a configured backend outside the policy. Configuring Agent
One in graph workflows is a follow-up (it needs a config-schema field and a
cascade entry), so Cursor takes the graph `agent_one` position only as the
partner of a Cursor second agent is Claude — Cursor appears in graph
collaboration as `agent_two`.

### D4 — Task lanes share one autonomous settings block

Every task lane, whatever backend runs it, executes under
`AUTONOMOUS_TASK_LANE_SETTINGS` (`danger-full-access`, no approvals, no live
web search, network on, git check skipped) in the session worktree. Codex
enforces these natively, Cursor delivers them as instructions and logs
`cursor.task_policy_instruction_only`, and Claude's task runner reports the
fields it does not model. The lane resumes only a ref its own backend recorded
on the lane (`resumeRef.backend === request.backend`), and one synthetic
continuity adapter is built per participant from the enum.

### D5 — Cursor continuity

A Cursor task ref is a JSON envelope of task id, agent id, cwd, and CC scope.
Standalone `/collab` grants the originating session scope, so a Cursor Agent
One seeded from the conversation's agent id resumes that agent as a hosted
conversation; later phases resume the recorded task ref. Cursor's failure
classifier already maps a missing agent to `stale_resume_ref`, which the
WorkflowAgentCaller retries once fresh. Provider-side limit: a Cursor worker
that is already serving the originating conversation under a different owner
refuses the attach; the run then fails with the classifier's verdict rather
than silently starting a fresh agent.

### D6 — UI renders participants from the catalog

Card labels come from `backendLabel`, and identity accents key on the
catalog's `toneToken` via `data-tone` selectors (cyan, violet, amber) instead
of `Record<CollaborationAgent, …>` maps. The `/collab` row's second-agent
picker reads `collaborationBackendRefusal` from the live catalog and shows the
selected second agent's execution warnings, so Cursor's instruction-only limits
are disclosed where it is chosen. Cost display is unchanged: a lane whose
backend reports no `costUsd` shows none.

## Honest limits

- Cursor filesystem, network, and approval limits in a collaboration lane are
  instruction-only. Nothing is enforced beyond what the Cursor SDK provides.
- Cursor reports token usage but no cost; per-lane cost for a Cursor lane is
  unknown, not zero.
- Graph-workflow collaboration cannot yet place Cursor as Agent One (see D3).
