# Cursor capability delivery: implementation and verification

Ticket: command-center#113. Investigated 2026-09-07 against checkout
`396ff9fb5c1cf6de5c66c72fe89112cb3d791127` and installed `@cursor/sdk` 1.0.28.

The installed SDK can discover skills through project settings and accept
explicit custom agent definitions. Its public options do not provide a
selective skill or plugin input independent of ambient settings. Enabling
project settings to deliver skills also loads unrelated project rules. This
was observed in an authenticated probe, not inferred from CC's descriptor.

## Evidence

The probe uses the installed SDK directly with a caller-owned JSONL store and
fixture directories under `.cc/temp/cursor-capability-probe/`. It supplies a
skill in `local.cwd`, another in `local.dirs`, an always-applied project rule,
and an explicit `agents` entry. No probe prompt contains the fixture markers.
All three runs finished. Results were written and read back from each
scenario's `result.json`. These are SDK probes, not application acceptance
tests or proof of complete capability delivery.

| Scenario | SDK options | Observed response |
| --- | --- | --- |
| `empty` | `settingSources: []`, extra directory, `tools: []` | No skills or verification markers reported. |
| `project` | `settingSources: ["project"]`, same fixture layout, `tools: []` | Both `orchid-ledger` / `ORCHID_42817` and `cobalt-ledger` / `COBALT_73192` appeared. The response also appended `RULE_96538`, as the unrelated project rule instructed. |
| `agents` | `settingSources: []`, `tools: ["task"]`, explicit `agents` | `violet-auditor` and `VIOLET_28463` appeared alongside Cursor's built-in subagents. Skills remained absent. No task was invoked. |

The first two probes disable all tools. They establish context visibility and
rule application, not skill-file reading or custom-agent execution. Custom
agents were absent with the task tool disabled; the third probe establishes
their visibility with that tool available. None establishes resume behavior,
mid-conversation updates, hermetic task behavior, or plugin execution.

Local reproduction:

```sh
node .cc/temp/cursor-capability-probe/probe.mjs empty
node .cc/temp/cursor-capability-probe/probe.mjs project
node .cc/temp/cursor-capability-probe/probe.mjs agents
```

`CURSOR_API_KEY` must be present. The script and private stores/results remain
in git-ignored scratch for investigation. Each SDK agent was disposed after
its run. No application sessions or capability overrides were created by these initial SDK probes.
Test-first was skipped for this throwaway diagnostic; no production code was
changed.

## Installed source contract

- `node_modules/@cursor/sdk/dist/esm/options.d.ts:96`: `AgentDefinition`
  contains description, prompt, optional model, and optional MCP servers.
- `options.d.ts:116`: `local.dirs` adds workspace folders to `cwd`, including
  their project rules and skills. It does not replace or filter the primary
  workspace.
- `options.d.ts:143`: `local.settingSources` controls ambient layers. The
  public create/resume options expose `agents`, but no selected skill roots,
  per-skill suppression map, or explicit plugin attachment list.
- The installed `357.js` module
  `../cursor-sdk-local-runtime/dist/agent-host/default-local-workspace-runtime.js`
  uses the `project` setting-source flag for
  project extensibility, project hooks, and project MCP loading. The
  `core/local-extensibility.js` module builds rules and skill services from
  the same allowed workspace roots. `dirs` does not isolate these services.
- `core/setting-sources.js` normalizes an empty list into all layers disabled.
  The SDK's internal controls are finer-grained than its public options;
  depending on bundled private modules would introduce an unsupported SDK
  dependency.

## Baseline CC composition points

`managed-skills/publisher.ts` already publishes immutable bundles.
`managed-skills/service.ts` owns their process-visible reference. Cursor
should consume that bundle rather than introduce another publisher or point
at the server checkout.

`agent-capabilities/runtime-composer.ts` already resolves plugins before
their children through the global/project/session/conversation cascade.
`default-deps.ts` and `route-defaults.ts` own discovery wiring; the cascade
schema, descriptor, and metadata registry govern API/UI availability and
application timing. A Cursor adapter can extend these existing surfaces.

`cursor/worker/sdk-port.ts` owns create/resume translation. Explicit agent
definitions can enter there after CC selection. `cursor/policy.ts` currently
keeps settings sources empty, and `cursor/runtime-config.ts` rejects
undeclared capabilities. Those truthful refusals should remain until the
replacement delivery path is implemented and tested.

`cursor/descriptor.ts` has no task facet. Testing custom Cursor
subagents does not establish CC task-launch support. Task-runner ownership
must be reconciled with the parent parity work before claiming that matrix.
Provider-native definitions remain separate from CC agent profiles.

## Approved delivery and implementation

Alex approved CC delivery for the managed bundle and configurable user/plugin
skills. The adapter keeps `settingSources: []`. It sends a skill catalog once
per conversation, then relies on explicit file reads for skill bodies and
supporting files. Selected native agent definitions enter the SDK's public
`agents` option on both create and resume. These definitions remain separate
from CC agent profiles.

The adapter composes the existing immutable bundle publisher and capability
cascade. Discovery, configuration routes, tabs, slash-command discovery and
runtime construction share the Cursor catalog. Configurable cascades are
`cursor-skills`, `cursor-plugins` and `cursor-agents`, all declared
next-conversation. Global, project, session and conversation overrides use the
existing resolver; disabled plugins force their skills and agents off.

Discovery covers project/user `.cursor/skills`, `.agents/skills`,
`.cursor/agents`, and user `.cursor/plugins/local`. Project sources win over
user sources; `.cursor` wins over `.agents` within a scope. Plugin children
use `plugin:child` identities. The `command-center` namespace is reserved and
managed entries cannot be disabled by user overrides. Managed bridge links
are excluded from configurable discovery. Symlink cycles, escaping plugin
paths, duplicate names and unreadable sources produce bounded diagnostics.

CC delivery supports skill name/description plus descriptive license and
compatibility fields. Other skill frontmatter is disclosed as unsupported and
the skill is omitted, including invocation or tool controls CC cannot enforce.
Agent definitions support description, body prompt and optional model; other
fields are disclosed and omitted rather than silently ignored. Local plugins
contribute supported skills and agents only. Their rules, hooks, commands,
MCP configuration, variables and other components do not run. Remote
marketplace activation is not imported; the UI explicitly describes this
scope.

A crash-durable `cc-capabilities.json` beside the CC-owned Cursor agent store
pins the catalog, displayed skill commands, selected definitions and resolved selections. Accepted
turns persist a delivery receipt; normal subsequent turns and process-resume
do not prepend another copy. Pending overrides do not replace a resumed
snapshot. The capability view carries the applied selection separately from
pending intent, so slash-command filtering retains the conversation's actual
selection, including the managed bundle version in autocomplete. Fresh creation replaces stale catalog entries and points to the
current published bundle. Existing conversations keep their immutable bundle
version. This adapter creates no backend configuration files or checkout
skill links.

The catalog writes shared roots once and contains no skill bodies. It refuses
catalogs above 16,384 characters with an instruction to disable skills in CC;
it never silently truncates the selected catalog. The measured application
catalog was 7,882 characters with the managed bundle and discovered user
skills. A controlled catalog containing seven managed skills, one user skill
and one plugin skill was 5,324 characters. These are catalog character counts,
not total provider context or token counts. Reading a skill subsequently adds
its body to the conversation.

Worker protocol version 3 carries explicit agent definitions. Version skew is
rejected instead of permitting an older worker to drop selected agents.

## Authenticated implementation evidence

All runs used the installed SDK 1.0.28 and Cursor Composer 2.5 with fast=true.
They ran in worktree-local scratch repositories and stores. No other provider
executed a verification turn.

| Scenario | Observed behavior and durable evidence |
| --- | --- |
| CC application creation | Conversation `89d7f745-c6bb-4892-a71f-fa1c761ba777` read the published `command-center:dev-server-setup` SKILL.md and selected fixture SKILL.md. It explained CC port assignment and returned `LANTERN_837194`, present only in the fixture body. It delegated to native agent `auditor` and returned its prompt-only phrase `AGENT_LIME_431`. SQLite records backend cursor, prompt count 2 and awaiting status. |
| Four-layer cascade and pending update | Global disabled selected-probe; project enabled it; session disabled it; conversation enabled it. The first delivery selected it. A subsequent conversation override disabled it: durable runtime state records `deferred-next-conversation` with distinct applied/pending hashes. The API view reports effective=false and appliedEnabled=true. A subsequent real turn still read the selected skill. |
| Fresh application conversation | Conversation `0befb19c-d25a-450f-95fc-f684b627e749` inherited both fixture skills disabled, reported neither in the catalog and still used the managed skill. Its persisted catalog contains neither fixture entry; neither secret fixture token occurs in its transcript. SQLite records backend cursor and prompt count 1. |
| Plugin delivery and process resume | A production `CursorConversationRuntime` used the real supervised worker and SDK with a scratch local plugin. It read `review:check` and returned body-only `PLUGIN_SYCAMORE_239`. The worker was closed, a fresh runtime resumed the same SDK reference/store with an empty desired cascade, and the original selection remained usable. Both results have failure=null and the receipt reads delivered=true. |
| UI and routes | Browser checks showed Cursor Skills/Agents/Plugins at global and conversation scope, the CC delivery disclosure and deferred-next-conversation labels. Next.js MCP reported no configuration or session runtime errors. |

Application fixture commands used `cctl dev ensure nextjs` and the returned
`http://localhost:3001`, then `cctl fixture session create`, `cctl fixture
prompt --wait`, and deletion through `cctl fixture session delete`. The dev
config and database resolved inside this worktree's `.config`. Fixtures used
a scratch project under `.cc/temp/cursor-app-projects`, not the main checkout.
An extra fresh Claude conversation was created by the generic creation route
but never prompted; it supplies no parity evidence.

Raw evidence is retained in git-ignored scratch:

- `.cc/temp/cursor-app-evidence/`: preserved transcripts, extracted response
  text and capability receipts for both application conversations.
- `.cc/temp/cursor-app-db-evidence.json`: read-only SQLite row projections.
- `.cc/temp/cursor-app-config-evidence.json` and
  `cursor-app-pending-evidence.json`: cascade mutations, read-back API views
  and durable state.
- `.cc/temp/cursor-live-delivery/plugin-evidence.json`: real worker
  create/resume results and events, including skill reads.
- `.cc/temp/cursor-capability-probe/`: local reproduction scripts. The SDK
  worker bundle was rebuilt from this branch before the final authenticated
  process probe. The registered validation surface has no live Cursor command
  enabled, so these were explicit authenticated diagnostics, not a registered
  acceptance-suite pass.

## Registered validation

Behavior regressions were reproduced before their fixes: multiline skill
descriptions, catalog discovery and suppression, snapshot delivery, runtime
catalog use, pinned command filtering, explicit agent models and unsupported
skill invocation controls. Schema/descriptor/UI/protocol wiring and throwaway
live fixtures do not have independent behavior to pin and were not test-first.
Focused tests used registered `cctl validate run test` with individual file
paths and `--require-match --json`.

Focused registered passes:

| Check | Run ID |
| --- | --- |
| Catalog, collisions, suppression, supported fields (11 tests) | `vrun-6d9a5afe-0ed5-48cb-af79-80b52c47d963` |
| Delivery receipt, resume, hermetic exclusion and bundle cleanup (5 tests) | `vrun-533b0c16-c271-461d-91f0-6348b461e158` |
| Command filtering and pinned bundle commands (12 tests) | `vrun-8bce1e23-fb37-4e49-907d-b5931bf7d877` |
| Worker create/resume with explicit agents | `vrun-b43b206e-e85f-4f46-a343-1e47b32f0229` |
| Project-conversation cascade acceptance | `vrun-0b079015-c633-4f0d-b22d-65c1ce88afcc` |
| Four-layer plugin suppression and resumed runtime state | `vrun-cb4bee1a-4b86-4638-88f5-be38220df7eb` |
| Backend conformance | `vrun-aa4ed382-231b-4327-ad30-41ee13fbd54f` |
| Worker protocol | `vrun-0210412d-d314-44bf-bc30-e0edf9ca1287` |
| Lint | `vrun-ca4cd270-7ae7-4c85-b7fa-fb888b1dc151` |
| Architecture seams | `vrun-58b63208-c6a8-410c-8f71-999c2c7a429a` |

The broader changed-scope checkpoint
`vrun-60ee788d-8828-4655-8d65-948745ac9a71` finished with 11,017 passing tests,
two failed assertions and one skipped file before the runner's failure bail.
Its failures were stale expectations of exactly five cascades and of worker
attach options without explicit agents. Both were corrected and their entire
files rerun successfully above. This is not a claim that all 1,314 selected
files completed. Final targeted checkpoints passed:

- Runtime, SDK options, supervisor and capability metadata:
  `vrun-e016e81d-fbc7-496c-92f4-a80b68502da0`.
- Command discovery, command routes, project autocomplete and capability routes:
  `vrun-58adb90c-448e-4d78-a855-de4a54e3dae3`.
- Full-project typecheck: `vrun-dce98d64-5bb3-40b9-8948-c6f3371b09b5`.
- Final format: `vrun-d6830a96-0fb6-4706-bdb2-4dcb95269308`.

Both application fixture sessions were deleted through `cctl fixture`, their
evidence preserved in scratch, and the worktree dev configuration restored.
The session dev server and browser page were closed after verification.

## Remaining boundaries

- The Cursor descriptor still has no CC task facet. Ticket #115 owns the task
  runner and production continuity bindings. Ticket #113's task-launch matrix
  depends on that work. Hermetic delivery returns no skills, agents or snapshot
  reuse; current admission rejects unsupported isolated/governed/task launches
  before delivery. This is a tested refusal, not task execution parity.
- Privileged instructions and exact filesystem confinement remain #117's
  provider boundary. Skill suppression controls automatic discovery and
  delivery; it is not a filesystem access prohibition.
- Full native plugin loading is not provided. Broader plugin components or
  unsupported definition controls require an additional public SDK mechanism
  and authenticated verification, not enabling every ambient settings layer.
- Resume pins selection and managed bundle version; user-owned skill bodies
  remain ordinary mutable files. A crash after provider acceptance but before
  the delivery receipt is persisted can repeat the catalog on retry. Native
  compaction recovery is not established by these tests.

The approved conversation-delivery implementation is available for review.
The ticket remains in progress for the task-launch dependency and its final
matrix; this report does not claim full Cursor parity.
