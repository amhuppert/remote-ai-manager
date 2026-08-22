# Current code map

Paths and symbols were checked on baseline commit
`fa6bf4306f52926be195bef101e09598494dac3e`. Re-run searches on the target
checkout; line numbers in the ticket research may have drifted.

## Canonical backend seam

| Path | Why it matters |
| --- | --- |
| `src/lib/shared/schemas.ts` | Canonical `agentBackendSchema`, `AgentBackendId`, and `AgentSessionRef`. Add Cursor only after unknown-backend coercion is fixed. |
| `src/lib/agent-backends/descriptor.ts` | Descriptor facets and capability promises, including required managed-skills/MCP/error fields and separate conversation/task filesystem declarations. |
| `src/lib/agent-backends/conversation.ts` | Neutral runtime creation, turn input, event, metrics, and result contracts. |
| `src/lib/agent-backends/continuity.ts` | Start/validate/resume-or-recover/fork contract over opaque refs. |
| `src/lib/agent-backends/task.ts` | Neutral task contract; Phase 1 should not register Cursor here. |
| `src/lib/agent-backends/runtime-config.ts` | Neutral capability cascade translation boundary. |
| `src/lib/agent-backends/errors.ts` | Failure and continuation classification helpers. |
| `src/lib/agent-backends/transcript.ts` and `transcript-projections.ts` | Lossless envelope and neutral projection boundaries. |
| `src/lib/agent-backends/registry-core.ts` | Provider-neutral registration and lookup. |
| `src/lib/agent-backends/registry.ts` | Production descriptor bootstrap. |
| `src/lib/agent-backends/catalog.ts` | Client-safe metadata, capabilities, filesystem maps, model compatibility, and selection defaults; currently closed over Claude/Codex in several maps. |
| `src/lib/agent-backends/conformance.ts` | Parameterized behavior checks for descriptor promises. |
| `src/lib/agent-backends/consumer-locality.test.ts` | Existing testfake third-backend end-to-end proof. |

## Adapter references

Use Codex as the closest process/SDK adapter reference, but copy behavior only
when Cursor evidence supports the same declaration.

| Path | Reusable idea |
| --- | --- |
| `src/lib/agent-backends/codex/descriptor.ts` | Metadata/capability literals and injected descriptor construction. |
| `src/lib/agent-backends/codex/conversation-runtime.ts` | Per-turn runtime materialization, cancellation, queueing, result handling. |
| `src/lib/agent-backends/codex/continuity.ts` | Opaque ref validation/recovery and synthetic fork pattern. |
| `src/lib/agent-backends/codex/transcript-projections.ts` | Provider-owned native frame interpretation. |
| `src/lib/agent-backends/codex/failure-classifier.ts` | Provider markers normalized below the seam. |
| `src/lib/agent-backends/codex/runtime-config.ts` | Provider translation of neutral runtime config. |
| `src/lib/agent-backends/codex/managed-skills-bridge.ts` | Ownership-attested `.agents/skills` bridge to generalize after live Cursor proof. |
| `src/lib/agent-backends/codex/fs-write-envelope.ts` | Standard of proof for an enforced allowlist; do not claim Cursor equivalence from API names alone. |
| `src/lib/agent-backends/claude/build-prompt-blocks.ts` | Existing post-validation schema/prompt contract pattern. |
| `src/lib/agent-backends/structured-output*.ts` | Shared extraction, validation, prompt, and repair flow to reuse. |
| `src/lib/shared/child-env.ts` and `src/lib/agent-gateway/session-env.ts` | Existing environment contract construction; use instead of ad hoc env mutation. |

## Known closed-world/product surfaces

| Path | Required treatment |
| --- | --- |
| `src/lib/commands/route-handlers.ts` | Fix two `requestedBackend === "codex" ? "codex" : "claude"` coercions before adding Cursor. |
| `src/lib/config/schemas.ts` | Raw and normalized backend profile records currently name Claude/Codex. Add a Cursor profile with sparse raw form and deterministic defaults. |
| `src/lib/config/loader.ts` | Default materialization and profile merging currently materialize two profiles. |
| `src/features/config/sections/BackendsSection.tsx` | Fetches a catalog but then locates/renders exactly Claude and Codex. Render registered entries while preserving provider-specific fields behind owned subcomponents. |
| `src/lib/mcp/backend-capabilities.ts` | Add an honest Cursor capability record and registry entry; keep unsupported/non-authoritative until proven. |
| `src/lib/shared/session-ref-codec.ts` | `LEGACY_HANDLE_KEY` is a total backend map and legacy arms are provider-specific. Cursor needs canonical round-trip coverage, not a fake historical legacy arm. |
| `src/lib/agent-backends/catalog.ts` | Total `Record<AgentBackendId, ...>` maps, custom-model handling, and `codexFastMode` defaults need deliberate Cursor behavior. |
| `src/components/workflow-config/AssignmentEditor.tsx` | Backend/model/effort selection and eligibility. Phase 1 must not make Cursor appear task-capable. |
| `src/features/project-detail/spawn-card/useSpawnCard.ts` and quick-ticket components | Session kickoff/backend selection surfaces. |
| `src/lib/commands/service.ts`, `src/lib/commands/query-keys.ts`, and prompt slash-command popup | Command/skill discovery still contains Claude-vs-Codex assumptions. Generalize ordinary selection, retain honest capability behavior. |
| `src/lib/agent-capabilities/` | Capability-cascade discovery is parity work, not Phase 1. Do not add a large Cursor twin early. |
| `scripts/seam-adoption.ts` and `scripts/seam-baselines.json` | Identity/deep-import/enumeration ratchets. Review survivors; never raise ceilings just to make checks pass. |

## Intentional two-backend walls

Do not generalize these as part of ticket #59:

- `src/lib/workflows/collaboration/backend-pair.ts`
- `src/lib/workflows/collaboration/`
- `src/features/session/conversation/collab/`
- `src/stores/collaboration.store.ts`
- Collaboration-specific UI/types/stories that intentionally encode
  Claude×Codex

Ticket decision D19 keeps Collaboration Mode a curated pair. Cursor support in
ordinary backend-neutral consumers does not change that product decision.

## Useful searches after checkout

```sh
rg -n 'requestedBackend === "codex"|"claude" \| "codex"|Record<AgentBackendId|agentBackendSchema\.options' src scripts
rg -n 'codexFastMode|fastMode' src
rg -n 'backend === "claude"|backend === "codex"|backend !== "claude"|backend !== "codex"' src scripts
rg -n 'agentBackends|defaultAgentBackend' src/lib/config src/features/config
rg -n 'AgentSessionRef|persistedAgentSessionRefSchema|LEGACY_HANDLE_KEY' src
```

Classify each hit as adapter-owned, explicit product selection, intentional
Collaboration policy, legacy decode, or an actual neutral-seam leak. Do not
mechanically remove every provider identity check.

## Test and evidence map

- Adapter unit tests colocated under `src/lib/agent-backends/cursor/`.
- Real native-frame fixture contract modeled after
  `claude/transcript-frames.contract.test.ts`.
- `src/lib/agent-backends/conformance.test.ts` and consumer-locality tests.
- `src/lib/shared/session-ref-codec.test.ts` plus repository/state round trips.
- Config schema/loader/route tests and backend catalog route tests.
- Settings stories/tests and selectors used by session/project creation.
- Command discovery route tests for absent/valid/invalid backends.
- Live proof for concurrency isolation, restart/load, cancellation/process-tree
  cleanup, MCP as declared, auth/version/model failures, and persistence.

