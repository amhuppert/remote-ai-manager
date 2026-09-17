# CLI (`cctl`) implementation

`cctl` is the primary interface agents use to act on Command Center. Its runtime,
parser, help graph, output envelope, guidance arbitration, and artifact delivery
come from `cli-for-agents`. The migration decisions live in
`docs/design/cc-cli-library-migration.md`.

## Principle ownership

Load the relevant agentic-engineering-principles skill before changing this surface:

- `cli-tools-for-agents` owns the generic agent CLI contract.
- `query-output-disclosure` owns bounded defaults, stable handles, omission metadata,
  drill-down, and file spillover.
- `progressive-disclosure-tooling` owns help as a disclosure graph derived from the
  command declarations.
- `agent-feedback-tiers` owns the hint/reminder/instruction vocabulary and reminder
  admission rule.

This file describes CC's concrete owners and stricter local invariants.

## Static declarations and lazy handlers

`src/cli/index.ts` passes `createCommandCenterCli()` to the library's `main`.
`src/cli/framework/application.ts` composes every command family. Command
specifications and `defineGroup` declarations live beside their lazy handler
modules under `src/cli/commands/`; the shared `ccCommands` family and application
error definitions live in `src/cli/framework/family.ts`.

Declare flags, arguments, payload schemas, examples, related commands, and effect
classification once in the command specification. Library parsing, file twins,
help, generated check commands, and typed invocations derive from those declarations.
Do not add a parallel parser, allowlist, dispatcher, help registry, or envelope.

Keep help available offline and unauthenticated: declarations load without loading
handlers or resolving server identity. Server state belongs in reads and doctor
commands. A command's help must explain its inputs and output selection without
requiring the reader to know a sibling's help.

Prose vulnerable to shell expansion declares `fileSource` with an explicit byte
limit. The library owns the derived `--<flag>-file` twin, mutual exclusion, literal
file contents, and input failures. Structured payloads use the library payload
contract and generated check surface. A handler must not parse shell quoting or
silently trim file prose.

When changing a command:

1. Update its typed specification, examples, and useful related edges.
2. Return domain data through `runner` or mutation reports through `writeRunner`.
3. Exercise behavior with the real `createCommandCenterCli` and library test host.
4. Update first-party callers and portable skill prose for changed contracts.
5. Regenerate the portable command reference with
   `bun scripts/cc-cli-skill-reference.ts` and run its registered contract test.

`scripts/cc-cli-skill-reference.ts` traverses the library help graph to generate the
portable reference. The source skill is under
`plugins/command-center/command-center/skills/cc-cli/`; an installed `.agents` skill
may be a symlink into a shared bundle and is not the source to edit. The library's
`cctl exit-codes` is the canonical published exit table.

## Test ownership

CC tests cover its declarations, domain schemas, transport, identity, routing,
data projections, guidance construction, and job lifecycle. Trust upstream tests
for library parsing, file-twin mechanics, generated check execution, generic
envelopes, guidance arbitration, artifact integrity, and process output delivery.
Keep CC-specific assertions in mixed integration tests and remove library-only
cases or assertions; using the real library to exercise CC wiring is appropriate.

## Data, effects, and bounded delivery

Default output is terse text; `--json` returns one library envelope. The domain DTO
is at `payload.data` for inline delivery. An artifact payload carries a receipt;
callers must inspect the payload kind rather than assume every success is inline.
Do not append arbitrary text after a JSON envelope or write directly to stdio from
handlers. The runtime owns draining, pipe closure, and final exit status.

Text and JSON represent the same selected domain data. Use `page`, `count`, and
typed `invocation` for bounded lists and their continuations. A truncated list must
state its total (or that it is unknown), returned count, and exact reveal command.
Keep filters and explicit target identity in that command. A stable handle printed
in an outline must work in its detail command. Server-owned page cursors stay opaque.

Use the library's output levels and artifact policy for large results. CC's local
artifact directory is `.cc/temp/cctl-artifacts`; `framework/artifact-policy.ts`
owns its creation. `binaryArtifact` delivers original bytes through the same
runtime, with an `output: "binary"` declaration. Do not create a second spill
writer or return base64 content as a substitute for artifact bytes.

A successful write returns `effect: "applied"` and real recovery facts: a returned
record id, accepted job id, or addressed target. A refusal before mutation is
`not_applied`; loss of acknowledgement after a possible mutation is `unknown` with
recovery references. A malformed mutation response must not fabricate a success id
or tell the caller that nothing changed. A server job can remain applied even if
its observation later times out.

`framework/request.ts` maps transport outcomes into application errors and keeps
server codes, issue paths, rationale, and structured detail. Use its optional HTTP
classification override for semantic domain refusals instead of reconstructing
an error and accidentally dropping instructions or bounded diagnostics.

## Identity, transport, and instance boundaries

`framework/context.ts` resolves the server, project, session, conversation, lane,
and principal independently. `src/cli/transport.ts` owns HTTP, credentials, build
stamps, and response classification; it does not own parsing or rendering.

Explicit flags override environment identity. Missing session identity is a falsy
check through `readSessionEnv`, since a project conversation receives an explicitly
empty `CC_SESSION`. Never use `??` to convert that value into a session route.
Select project conversation routes for project scope; session-only capabilities
must fail before their request when a session is absent. Exercise project routing
against real route mounts in `project-route-wiring.arch.test.ts`: a permissive
fake HTTP host cannot prove that the selected route exists.

A conversation read can locate an unqualified conversation id after a wrong-scope
404, only when no project/session override was supplied. Mutations never widen
scope silently. Ticket conversation attachment may locate its source conversation
while retaining the explicitly addressed ticket as the mutation target.

CC deliberately enforces binary/server build parity for its managing instance.
The server refuses skewed mutations before handlers execute; reads discard a
mismatched response. `doctor` diagnoses identity, credentials, and parity.

`fixture` addresses the separate worktree dev instance, which has its own database,
logs, transcripts, and token. Those cross-instance requests use the explicit
`unstamped` transport option and schema-validate responses. They must refuse the
managing instance as an explicit fixture target. `dev doctor` shows both instances;
`dev/routing.ts` owns workflow-context dev targeting, and `dev/target.ts` resolves
the running instance. Retain workflow identity across list/start/readiness/stop.

## Jobs and guidance

`framework/observe-job.ts` owns shared polling observations for long server jobs.
Submission and observation are distinct: a client deadline or interruption stops
waiting and names how to recover the accepted job, never implies cancellation.
Fixture prompt completion follows its actual SSE completion event instead of
inventing a polling status route.

`validate run` blocks for its verdict. `--queue-if-busy` controls scheduler admission;
`--require-match` turns a zero-match pass into a refusal. The output must identify
the resolved scope and matched-file count so callers know what passed.

Use library guidance constructors and typed invocations. Authenticated server
instructions are carried through `framework/request.ts`; do not reinterpret them
as locally fired reminder rules. Server lane reminders are evaluated by the real
state rules in `src/lib/workflow-graph/lane-reminders.ts`, which publish evaluated
provenance. The CLI validates and composes those batches in `framework/guidance.ts`.

The client reminder exception is `CLIENT_ADVISORIES` in
`framework/payload-location.ts`: filesystem facts only the caller can observe,
with evidence recorded for each admitted reminder. Input-file metadata comes from
the library context; never reparse argv to infer which file was read. Log actual
rule firings and conflicts, not fabricated provenance. The library arbitrates
instruction, reminders, and hint once for both text and JSON.

## Domain adapters

CLI modules call canonical domain services through their existing server routes
and schemas. They do not acquire ownership of business decisions. In particular,
`commands/logs/` adapts the canonical log-analysis engine under
`src/lib/logging/log-analysis/`: parsing, thresholds, ranking, and trace construction
remain there. Offline log commands reject identity flags that would otherwise
suggest filtering records by a different project/session.

The pinned library package is committed under `.yalc/cli-for-agents` with provenance.
Use `bun run cli:library:refresh --source <checkout> --revision <commit>` to refresh
this consumer deliberately. Do not use a global yalc push that changes neighboring
worktrees. Regenerate the snapshot when an authorized upstream library fix is
committed, then verify the consuming CLI through its public API.
