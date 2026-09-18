# cctl adoption of cli-for-agents

## Objective and scope

Move the existing Command Center CLI onto `cli-for-agents`. Agents retain access
to CC's operations and scope controls while the library owns command parsing,
help, payload admission, result envelopes, guidance arbitration, bounded output,
artifacts, and process delivery.

Alex chose adoption of the library's conventions, including necessary flag and
output changes, and authorized focused improvements to the shared library when
integration exposes a reusable gap. The selected working distribution approach is
a committed yalc package snapshot. Public registry publication, deployment of the
managing CC server, new domain features, and compatibility aliases are outside
this migration.

The starting registry contains 162 leaves and 32 groups. Library built-ins replace
the existing `version` and `exit-codes` leaves; the other 160 application operations
remain covered. Generated payload validation twins add read-only operations.

## Ownership

| Concern | Canonical owner after cutover |
| --- | --- |
| Input names, shapes, examples, command paths, help and invocation references | Static, finite library command declarations in CC |
| Parsing, required inputs, prose file alternatives, JSON/Standard Schema payload admission | Library runtime |
| HTTP, credentials and their source, principal identity, target scope, build parity | CC transport and context modules |
| Domain permission checks, persistence, scheduler admission, workflow policy | Existing CC server services |
| Job observation, timeouts, owned cancellation, continuation details | CC job observer using the runtime clock and signal |
| Successful data and primary text projection | Typed CC DTOs and `runner`/`writeRunner` renderers |
| Exit taxonomy, envelope assembly, guidance arbitration, byte bounds and atomic artifacts | Library runtime |
| Workflow reminder facts and predicates | Server state snapshots and shared CC domain rules; CLI evaluates through the library guidance API |
| Caller filesystem advisory | CC's local rule and firing sink |
| Final stdout/stderr draining and exit | Library `main` |

Command modules return structured outcomes. They do not invoke the old CLI or
decode previously rendered stdout. Shared CC helpers return typed contexts and
errors rather than terminal strings. HTTP success decoding stays at each domain
boundary; the library validates JSON transportability, not domain semantics.

## Command declarations and input

Use literal command specs with finite argument tuples and flag keys. A lazy
binding explicitly returns the selected handler as a data property; importing
declarations must not load handlers, schemas, HTTP, logging, or application state.
The declaration tree supplies the runtime registry and generated command reference.

Scalar writes remain scalar. Existing prose inputs use the library's bounded
`fileSource` alternative. Structured payload commands use required `--file` and a
real domain Standard Schema decoder. In particular, `ask` becomes file-only; its
inline question/option sugar is retired in the coordinated guidance update.

A payload write's generated validation twin appends `-check` to its final path
token (`ask-check`, `agent run-check`). It shares decode and prepare, and cannot
commit. Existing semantic preflights such as `workflow validate` remain separate
when their contract covers more than one mutation's preparation.

Keep existing natural flag names by making the library resolve domain flags at
the selected leaf. Global and framework options remain usable around command-path
tokens; command-specific options follow the complete leaf path. Cross-leaf kind
and selector ownership differences are legal, while collisions within one leaf
or with its globals remain errors. This addresses the actual `config`, `summary`,
and `status` conflicts without a second parser or widened authoring API.

The library owns `--out`: structured full-detail reads declare artifact-eligible
levels, and finite binary exports return `binaryArtifact`. Explicit export content
and its media type remain domain decisions. Familiar command names are retained
where compatible with these declarations.

## Results, effects and recovery

Inline success data lives at `payload.data`, alongside the library's `ok`,
`effect`, guidance and recovery fields. Errors use the library error object;
CC server codes and structured domain detail remain available inside its details.
JSON mode emits one envelope. Validation logs do not trail that envelope.

Reads report read effects. Successful writes report acknowledged application and
real resource references: question batch IDs, run IDs, document IDs, or the known
target of an acknowledged operation. Refusals before a mutation report
`not_applied`. A lost acknowledgment reports uncertainty and inspection/recovery
information; the client never retries a mutation to repair an output failure.
An operation that starts a job and later observes failure preserves the launch
receipt and known effect.

Domain DTOs and primary text expose the same selected detail. Literal domain prose
stays unchanged when safe; control characters and protocol-looking lines are
quoted for display while structured data and artifacts retain the original.
Protocol lines belong to structured guidance, errors, or artifacts. The runtime's
byte budget applies after serialization.
Existing bounded domain projections remain useful; their omission metadata and
continuations are expressed through the library's page and invocation contracts.

## Guidance and authority

Transport an authenticated server refusal's existing instruction with
`instruction("cc-server-refusal", text)`. This preserves the server decision and
does not claim a rule fired. The same principle applies to the explicit context
rotation outcome. Ordinary refusal services and their policy schemas remain in
their existing owners.

Lane routes return ordinary `laneReminderState` facts from the post-operation
execution or the halt snapshot. The CLI validates those facts and their verb,
then evaluates the shared CC lane rules with the local payload filesystem rule
in one library guidance evaluation. Rule predicates, evidence, wording, and
priority stay in the domain rule owner. Server domain logs retain the selected
rule IDs; the CLI logs the actual library rule firings. Neither side transports
library candidates or synthesizes evaluation provenance.

Keep existing rule wording and predicates unless a concrete contract requires a
change. Required ask and decision-review handoffs remain command-owned
instructions. Advisory navigation uses typed invocations; explanatory prose stays
in data, primary text or help. General guidance cleanup is a separate concern.

Explicit target overrides travel with CLI-authored follow-ups without copying
credentials. Server instructions that exceed the reserved instruction slot, or
contain multiline prose, remain complete in structured error detail; a bounded
mandatory instruction directs the caller to that detail or the response artifact.

## Package distribution

Refresh a selected committed library revision through the CC refresh command.
It builds an immutable archive in `.cc/temp`, records revision and archive hash,
and publishes through a temporary yalc store into this worktree only. The package
snapshot, yalc lock, dependency declaration and Bun lock travel together. A fresh
CC worktree installs them without the external checkout or global yalc store.
The bundled cctl executable remains self-contained.

Upstream improvements are validated and reviewed before selecting their committed
revision for refresh. Generated package files stay outside CC's source formatting,
linting and typechecking inventory; installed declarations still check consumers.

## Implementation and cutover

1. Establish package refresh/install evidence and a production-runtime test of an
   acknowledged write. Establish typed context, transport error, doctor and
   artifact-policy seams.
2. Migrate command families into static declarations, lazy handlers and meaningful
   tests against the new application factory. Preserve their endpoint/domain
   behavior and record intentional CLI shape changes.
3. Integrate server lane facts and local guidance, then exercise their
   composition through actual route-to-runtime tests. Complete job cancellation,
   artifact and binary-export cases.
4. Derive help/reference tooling from the adopted declarations. Update affected
   external tests, portable skills and current CLI steering. Historical design
   documents retain their dated contracts.
5. Switch the executable to library `main`; retire old parsing, help registry,
   dispatch, envelope rendering, output mutation and process delivery. Remove
   superseded command implementations once their replacements are reachable.
6. Verify the finite command coverage, registered checks, packaged executable and
   actual scoped CC flows before reporting completion.

The shipped entry point now invokes the library runtime directly. The former
parser, dispatcher, help registry, envelope renderer, and command implementations
are retired; retained domain and persistence contracts exercise the native entry.

## Acceptance evidence

- Existing application operations remain reachable through the new declarations;
  version/exit-codes use the built-ins, and help works offline without handlers or
  transport acquisition.
- Invalid flags, file inputs and payload shapes fail before HTTP or domain writes.
- Scope tests retain project/session/conversation distinctions, neutralized
  session environment behavior, principal identity separation and build refusal.
- Mutations retain real receipts and effects across network uncertainty and
  output failures. Validation and workflow waits retain resumable observation and
  owned-cancellation behavior.
- Text and JSON disclose equivalent selected data; oversized output yields a
  verified artifact, and binary exports round-trip without conversion loss.
- Required instructions survive failure/spill and suppress hints; server lane
  facts drive the shared rules and compose with local filesystem guidance.
- Registered format, lint, typecheck, seams and affected tests pass. Real
  route/persistence contract tests remain part of the evidence; no fake-only
  replacement removes a durable-state assertion.
- The branch-built executable runs independently of source packages and observes
  the intended isolated CC instance. Installed managing-server cctl behavior is
  not used as evidence for branch changes.

## Simplified library update, 2026-09-17

The consumer now pins `0e99b77b3eaad3aac3df20733ceab16efaf631fe`. This revision
removes remote guidance decoding and multiple authority batches, artifact
retention and sidecars, and defensive registries for trusted in-process callers.
CC uses one local guidance evaluation over domain state instead of rebuilding
the removed protocol. Its artifact policy did not enable retention, and its
other declarations and handlers continue using the supported APIs.

The snapshot is rebuilt from the committed source archive with SHA-256
`5aa62265927dd4bfea09b8a8c888097e3d09415df01ad373ab2856fe886ae410`.

Verification passes: changed-scope tests
(`vrun-c31803a1-d92b-4977-9049-597da42d4376`), focused guidance boundary tests
(`vrun-00c300e7-4bed-4c5e-a863-22b938bf81dc`), and route-to-CLI integration
(`vrun-0c78a19e-1b6c-4ab9-a315-06b221f134de`). Registered format, lint,
typecheck, and seams also pass. The regenerated command reference is unchanged.
The standalone Node bundle passes offline help and authenticated loopback HTTP
checks for task receipts, lane reminders, and halt refusals; these use a test
HTTP peer, not a running workflow. Added tests cover CC state and routing contracts,
not the removed library internals.

## Initial migration verification recorded 2026-09-17

The initial library revision was `126776e4821527e6cd61219f7dc46690bb1b7286`;
the snapshot records its source archive SHA-256. Comparing the original command
inventory with the library help graph accounts for all 160 application operations.
The generated command reference, package refresh contract, and focused domain
regressions pass. Initial migration verification also exercised process output;
library-owned behavior now relies on the upstream library's tests.

Final registered typecheck (`vrun-9a4ac0e8-adf4-4275-8a7f-338c40919260`), lint
(`vrun-e74fb1a9-8bac-41ef-8534-abd40b51a550`), and architecture seams
(`vrun-44adb338-5979-4e86-ae1a-32011badcbd3`) pass.
The full test run (`vrun-f37c4da4-9997-4a37-b548-d5523ca6285a`) passed 2,066 files
and 28,618 tests, with three files skipped. Its only failure was a documentation
test reading the retired `validate.help.ts`; that test now reads the command
declarations and is verified separately. No runtime changes followed that run.

The actual Node bundle was exercised against this session's isolated development
instance. Stored prose round-tripped literally; stale revision writes were
refused without mutation; a 150 KB result produced an artifact with verified
bytes and SHA-256; a registered validation completed; and SIGINT cancelled the
owned validation, confirmed by a separate status read. Initial process checks
also covered large refusal instructions, output draining, and early pipe closure;
those redundant library checks were subsequently removed from CC.
Test notepads, fixture sessions, and scratch projects were removed, the temporary
development configuration was restored, and the development server was stopped.
