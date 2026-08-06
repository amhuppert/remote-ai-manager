# Agent profiles

A profile is **prompt identity only** — name, description, instructions,
advisory `recommendedFor`, tags. It carries no runtime (backend/model/effort)
and no policy (tools, MCP, skills, permissions, output schemas, continuity,
questions). `agentProfileSchema` is `.strict()`, so those keys fail to parse
rather than being ignored.

Three tiers are **sibling scopes**, not a shadowing chain: a profile is
addressed only as `{tier, id}`, and `builtin:general-reviewer` and
`project:general-reviewer` coexist as different profiles. The compact `tier:id`
spelling exists only at text and CLI boundaries; `parseAgentProfileRef`
normalizes it at parse and refuses a bare id with a located failure. Everything
persisted is the structured form.

## Modules

| Module              | Owns                                                                         |
| ------------------- | ---------------------------------------------------------------------------- |
| `schemas.ts`        | identity (ids, the slug default, the immutability rule), tiers and their mutability rule, refs and the shorthand parser, stored records and editable content, snapshots (private + redacted), the hash envelope format |
| `hashing.ts`        | `computeContentHash` — `sha256:<hex>` over NFC-normalized UTF-8              |
| `builtins.ts`       | the six curated records, read-only through CRUD                              |
| `composer.ts`       | the rendered profile layer: delimiters, the five-level precedence contract, the subordination language, and the snapshot builder |
| `storage.ts`        | scoped revisioned records for the mutable tiers: compare-and-swap behind a per-record keyed mutex, quarantine of unreadable documents |
| `library-service.ts`| the library boundary consumers call: combined listing with tier provenance and diagnostics, fail-closed qualified resolution, authoring and the identity contract, deletion impact |
| `route-handlers.ts` | CRUD over HTTP for both storage scopes, the refusal→status mapping, and the change event |
| `query-keys.ts` / `queries.ts` / `sse-reactions.ts` | the client half: scoped library reads and the invalidation the change event drives |

`computeContentHash` lives apart from `schemas.ts` so client-side schema
consumers (pickers, forms) never pull `node:crypto` into the browser bundle.

## Storage and resolution

Mutable records persist as one atomic JSON document per record under
`<configDir>/agent-profiles/<scopeKey>/<id>.json`, where `scopeKey` is the
reserved `global.shared` or `base64url(projectPath)`. `atomicWriteJson` is
atomic per write but explicitly does **not** serialize concurrent writes to one
target, so `storage.ts` owns a keyed mutex over the absolute record path: every
create, read-check-write, and delete for one record runs alone. Without it two
callers both read revision N and both write N+1, and the compare-and-swap
contract would be decorative. Update **and** delete require `expectedRevision`;
a stale expectation raises `AgentProfileRevisionConflictError` carrying the
winning revision.

A record that fails to parse is quarantined rather than fatal: it is excluded
from listing and resolution and reported as a diagnostic naming the record and
the reason, while its siblings stay fully usable. A create cannot reclaim a
quarantined id — the check is file existence, not readability, so corrupt bytes
survive for an operator to inspect.

**A record's identity is the key it is filed under.** A document is only that
record if its `id` agrees with its storage key, and a mismatch is quarantined
like any other corruption. Without that binding an `alpha.json` declaring
`id: "beta"` would list as `beta` *and* answer `get(scope, "alpha")` — one
document holding two identities, neither of them true — which is precisely the
silent substitution qualified identity exists to prevent. The rule is enforced
at the read boundary, so it holds for hand-edited and externally-written files,
not only for documents this module wrote.

`library-service.ts` is the only module consumers call. Resolution fails closed:
an unknown, deleted, or quarantined reference raises
`AgentProfileNotResolvableError` naming the qualified reference, and never falls
back to a similarly named profile in a sibling tier. It also re-checks that the
record it got back carries the id that was asked for — storage already binds
that, but a reference resolving to a profile nobody addressed would run an agent
under unselected instructions, so the fail-closed contract is kept by the module
that owns it rather than delegated. `resolve` returns the **stored**
`sourceContentHash` rather than recomputing it, which is what keeps
`buildAgentProfileSnapshot`'s fail-closed hash check meaningful.

## The API and the change event

The route TREE is the scope. `/api/agent-profiles` runs with no project in
play; `/api/projects/[name]/agent-profiles` runs inside the project its
`RouteResolution` step resolved. That is what makes cross-project isolation
structural rather than a check — a project-tier record is only addressable
through its own project's route, so another project's route has no parameter
that could name it.

| Method | Path (per scope) | |
| --- | --- | --- |
| `GET` | `…/agent-profiles` | listing + quarantine diagnostics |
| `POST` | `…/agent-profiles` | create in the scope's own tier |
| `POST` | `…/agent-profiles/duplicate` | `{ source, targetTier?, targetId? }` |
| `GET` | `…/agent-profiles/[tier]/[id]` | the authorized read |
| `PUT` | `…/agent-profiles/[tier]/[id]` | `{ expectedRevision, content }` |
| `DELETE` | `…/agent-profiles/[tier]/[id]` | `{ expectedRevision, confirm }` |

A record is addressed by its QUALIFIED reference because `global:reviewer` and
`project:reviewer` are different profiles and a bare id would have to guess.
The tier segment is a routing input, not a permission: mutability is the
service's rule, so a builtin mutation is refused by `assertMutableProfileTier`
(403) rather than re-derived at the route. `library.list(null)` is the honest
answer for a scope with no project — the project tier does not exist to be
listed there, which is different from being empty.

Two response rules carry contracts:

- **Mutations answer with the LISTING projection, not the record.** The author
  already holds the text they just sent, and R6.3 confines instruction text to
  the authorized `GET`; echoing it back would widen that surface for nothing.
  The item carries the new `revision`, which is what a caller needs next.
- **`agent-profile-library-changed` publishes strictly after the service call
  returns**, through `events/publication.ts` and best-effort (the record is
  already durable, so a wire failure must not fail the request). A refused or
  conflicted write publishes nothing at all.

The event's `scope` describes the CHANGED RECORD, not the route it arrived on:
a global-tier profile edited from inside one project is visible to every
project, so it invalidates every project's library queries. `projectPath` is
present exactly on the project variant — structurally, via a discriminated
union — because a project-tier change that could not name its project would
force consumers to choose between over-invalidating everything and missing the
right one. Query keys are addressed by project NAME (the route's shape), and
`agentProfileProjectNameFromPath` bridges the two: the resolver builds a path
as `join(baseDir, projectName)`, so the trailing segment is the name.

## The two hashes

- `sourceContentHash` covers a library record's instruction content **as
  stored**. Computed at record write; snapshots copy it.
- `resolvedInstructionHash` covers a snapshot's `renderedInstructionBlock`
  **exactly as delivered**. The hash and the block are written together, and a
  restart replays the stored block rather than re-rendering, so the hash cannot
  drift from what the model received.

Neither hash covers any other prompt layer. The `sha256:` envelope prefix makes
a future algorithm change an explicit migration.

## Delivery, as it actually works

The composed block is appended as **one entry** in the existing backend-neutral
`sessionInstructions: string[]`. Per-backend semantics differ and are documented
rather than papered over:

- **Claude** joins the entries into the appended system prompt at runtime
  creation (`agent-backends/claude/conversation-runtime.ts`).
- **Codex** delivers them inside a fenced `## System Instructions` header in the
  first turn's prompt input (`agent-backends/codex/conversation-runtime.ts`) —
  weaker, textual semantics, identical to what the Alignment charter already
  receives.

Because of the Codex fence, `RESERVED_INSTRUCTION_SEQUENCES` reserves the triple
backtick alongside the block delimiters: profile instructions containing either
are refused with a typed error at save and at compose, so no profile can
terminate its own block on either path. Scope and tool enforcement stay
mechanical and outside prompt prose — the subordination language is a contract
statement, not the enforcement.

## Wiring obligations owned downstream

T1 delivered the domain core with two capabilities no production code called
yet, because the approved plan assigns their call sites to later tasks.

- **`assertMutableProfileTier` → T3 — discharged.** Every mutation entry point
  in `library-service.ts` (`create`, `update`, `delete`, `duplicateToScope`)
  calls it and none re-derives "is this a builtin". It now narrows rather than
  returning void, so past the call the tier is writable in the type system too
  and a mutation path cannot forget the check. T7 (`…-task-api-events`) reaches
  these refusals over the wire and maps them to statuses without re-checking
  tiers — `route-handlers.ts` has one `refusalResponse` table and no tier logic.
- **`composeProfileBlock` / `buildAgentProfileSnapshot` → T5 — discharged.**
  `src/lib/conversations/profile-resolution.ts` is the one caller: it defaults a
  missing selection to `builtin:standard-agent`, resolves through
  `library-service.resolve`, and composes the snapshot every construction site
  persists before its provider runtime exists. `profile-change.ts` does the same
  at a pre-lock swap. Nothing else in the codebase composes a block, so the
  frame a conversation runs under has one author.

Composition is proven at three boundaries: the domain (`composer.test.ts`), the
adapters (each backend delivering a stored block through its own instruction
seam, from an in-memory snapshot AND from one read back out of SQLite), and the
production conversation-start path.

R6.3 (no instruction text outside the authorized read) is split across two
tasks by construction, because it names two different sets of surfaces. T7 owns
and proves the LIBRARY half — the sentinel never reaches a listing, a mutation
response, a change event, or a log line, while the redacted identity does. T4
(`…-task-conversation-persistence`) owns the CONVERSATION half: the stored /
public conversation schema split, the mandatory projector, the conversation and
feed and SSE surfaces, and the type-level test that the public conversation
schema rejects an instructions field. Neither half is evidence for the other.

Authoring guards the composer's containment invariant: `library-service`
re-checks `findReservedSequence` on every create, update, and duplicate, so a
profile whose text could terminate its own block (or the Codex
system-instruction fence) is refused before it is ever stored.
