# 09 — One owner per policy: closing the 2026-08 agentic-principles audit

Status: proposed (design only — no implementation in this document's branch)
Audit: 2026-08-17, five-dimension review of `src/cli/` against the
`agentic-engineering-principles` skills (cli-tools-for-agents, query-output-disclosure,
progressive-disclosure-tooling, agent-feedback-tiers, mechanical-guardrails,
agent-structured-output, agent-offloading, logging-for-agent-debugging).

## 1. Diagnosis

The audit surfaced ~25 findings. Almost none of them are isolated bugs. They cluster into
one structural cause: **a policy the CLI already committed to is implemented at N call
sites instead of owned by one module**, and the call sites have drifted.

- Tier arbitration (instruction suppresses hint) is implemented twice — `render()`
  (`src/cli/shared.ts:315`) and `failure()` (`shared.ts:368`) — and the two copies
  disagree in text mode.
- Job waiting is implemented four times (`agent run`, `validate run`, `workflow wait`,
  `dev ensure`) with four different budgets, parse-failure behaviors, and forensic
  payloads.
- Output egress (write stdout, exit) is one line of `index.ts` that no module owns, so
  nothing guarantees the bytes actually leave the process (the 64KB pipe truncation).
- Group dispatch derivation exists (`dispatchGroup`) but the root and the `ticket`
  family hand-roll it, exactly where the registry guarantee lapses.
- Omission disclosure (`total/returned/truncated` + reveal command) is a steering-doc
  law with one typed implementation (spec) and hand-rolled or absent everywhere else.
- Build-parity refusal is client-side after the response, so it fires after the server
  already committed the mutation.

The fix is therefore not 25 patches. It is seven module changes — each one deepens or
creates a single owner and deletes the hand-rolled variants — plus a small set of
ratchets for the conventions construction cannot reach, and a short list of one-off
corrections. Every audit finding maps to exactly one owner (§10).

Design stance (Ousterhout): prefer deleting a foot-gun API over adding a test that
polices its use; prefer deriving a surface from data over contract-testing two copies
into agreement; add a ratchet only where neither is possible.

## 2. M1 — Egress: the process adapter and the disclosure primitive

**Owner:** `src/cli/index.ts` (flush semantics) + new `src/cli/disclosure.ts`
(bounded output policy).

### 2.1 Flush before exit

`index.ts:136-138` writes stdout and calls `process.exit` immediately. On a pipe the
kernel buffer is ~64KB; the remainder is discarded — the verified root cause of the
recorded `cctl … --json | jq` truncation, and it corrupts JSON exactly when it feeds
code. Fix in the adapter, once:

```ts
const drain = (stream: NodeJS.WriteStream, text: string) =>
  new Promise<void>((resolve) => {
    if (text === "") return resolve();
    stream.write(text, () => resolve());
  });
await Promise.all([drain(process.stdout, result.stdout), drain(process.stderr, result.stderr)]);
process.exit(result.exitCode);
```

`process.exit` stays (undici keep-alive agents and signal listeners can hold the loop
open), but only after the write callbacks confirm the kernel accepted every byte.
Verification is an e2e child-process test: spawn the entry with a stub server returning
a >64KB envelope, pipe stdout through a deliberately slow reader, assert byte-complete
valid JSON. A unit test cannot see this defect — it lives in process teardown.

### 2.2 The disclosure primitive

Generalize the pattern `spec show` already proved (60KB budget, spill-to-artifact,
manifest receipt) into one module every query command composes:

```ts
// disclosure.ts
export interface Omission {
  total: number;
  returned: number;
  truncated: boolean;
  /** Exact follow-up command that reveals the omitted rows. Required when truncated. */
  reveal?: string;
}
export function boundedRows(rows: string[], cap: number, reveal: string):
  { lines: string[]; omission: Omission };   // text lines end with "N total, M shown — rest: <reveal>"

export interface ArtifactManifest {
  path: string; format: string; bytes: number; sha256: string;
  reason: "stdout_budget_exceeded" | "requested";
}
export async function emitLarge(host: CliHost, content: string, opts: {
  budgetBytes?: number;        // default 60_000, matching spec show
  dir?: string;                // default ".cc/temp"
  format: string;
}): Promise<{ kind: "inline"; text: string } | { kind: "artifact"; manifest: ArtifactManifest }>;
```

The `Omission` fragment is spread into JSON envelopes and rendered identically in text,
so text/JSON parity holds by construction. `reveal` is typed as required-when-truncated
— "a cap without disclosure is a defect" becomes unrepresentable at the primitive, not
a review item.

**Consumers migrated in this design:**

- `workflow get --full` / `workflow live get --full` (`workflow.ts:809-821, 2026-2048`):
  route the dump through `emitLarge` — past budget, an artifact manifest instead of a
  corrupt pipe.
- `ticket attachment get` (`ticket.ts:1278-1284`): size is known before rendering;
  past budget (or always, for base64/binary) write the artifact and print the manifest.
- `ticket list` (`ticket.ts:494-570`): leading `N tickets` count line, bounded default
  via `boundedRows` with the filter flags as the reveal path. The per-ticket
  attachment-index N+1 fetch is folded into the same change (fetch once or render from
  the list payload — implementation detail, but the bounded default makes the cost
  visible).
- `spec/read.ts` `boundedSection` (`:400-420`): migrate onto `boundedRows` so the
  omitted rows' reveal command is named (`cctl spec show <slug>` / the owning list
  verb). Spec's ladder and 60KB budget are unchanged — spec becomes a consumer of the
  primitive it pioneered.
- `dev list` (`dev.ts:49-55`): text gains `error:` and `log:` lines when non-null, so
  no fact is JSON-only.

### 2.3 Legacy unbounded `--json` (deletion condition)

`workflow status --json` and `spec status --json` remain the two documented volume
exceptions. They are recorded in the declare-or-fail exception registry (§8) and
retired in the final phase (§11) by giving `status` the same selector ladder as
`live get`: bounded envelope by default, `--full` through `emitLarge`. Until then they
are the likeliest 64KB tripwires, which is why §2.1 lands first.

## 3. M2 — Guidance: one renderer for success and failure

**Owner:** `src/cli/shared.ts` — a single envelope→lines function.

`render()` and `failure()` both implement the tier policy; only `render()` implements
it correctly (instruction suppresses hint in both modes; `failure()` suppresses in
JSON but renders both in text — the one code defect the tiers audit found). Collapse:

```ts
function arbitrate(envelope: JsonEnvelope): JsonEnvelope;      // tier policy: instruction ⇒ no hint;
                                                               // asserts hint is single-line
function guidanceLines(envelope: JsonEnvelope): string[];      // "reminder: …"×N then "hint: …" | "instruction: …"
```

`render()` and `failure()` become thin composers over these two. The asymmetry class is
deleted, not patched: there is no longer a second place to get the ordering wrong.
Pin with a `shared.test.ts` case passing both `hint` and `instruction` through
`failure()` in both modes.

**Advisories join the envelope.** The `.cc/temp` payload advisory
(`core.ts:239-249`) is today a fourth vocabulary (`note:`), stderr-only, invisible to
`--json` consumers. It is reminder-shaped — a keep-true invariant ("payload files
belong under `.cc/`, or a lane commit sweeps them"), with recorded evidence. It becomes
a client-authored reminder merged into the result envelope before rendering. `cli.md`'s
"the server authors reminders" rule is amended to: server-authored, plus a single
enumerated client advisory list in one constant (declare-or-fail; adding a client
reminder means editing that list, with its evidence line, in review).

**Prefix vocabulary contract.** Allowed text guidance prefixes: `reminder:`, `hint:`,
`instruction:`, `next:` (the disclosure/receipt drill-down pointer, machine-composed —
`spec` receipts and `Omission.reveal` render through it), `context:` (help garnish).
`workflow-ledger.ts`'s hand-rolled `note:` lines migrate onto the disclosure primitive.
An arch test greps `src/cli/**` string literals for stray guidance prefixes against
this set.

**Tier-fit sweep** (three misfiled items, all mechanical once the vocabulary is firm):
`conversation.ts:665` "already fresh" moves from hint to primary body;
`workflow.ts:1814-1818` remaining-task count moves into the `completed <task>` primary
body (the rotation instruction is unchanged); the validate skipped-by-policy text
(`validation/service.ts:932`) is re-tiered from `instruction` to a reminder or reworded
to a genuine do-now action.

**Hints that name commands resolve against the registry.** A contract sweep extracts
`cctl <verb-path>` tokens from guidance string literals in `src/cli/**` and resolves
each path prefix through `resolveHelpEntry`. The sweep is lexical and tolerant of
placeholders — it will not catch every template, but it catches the real defect class
(a hint naming a retired command shipping silently).

## 4. M3 — Build parity: refuse mutations where mutations happen

**Owner:** `src/middleware.ts` (the decision moves server-side, pre-handler).

Today the skew check is client-side and post-response (`shared.ts:1123, 1172`): the
handler runs, the mutation commits, and the CLI exits 4 while discarding a 2xx — the
recorded "exit 4 still committed" double-mutation trap. Information-hiding reading: the
CLI cannot own the "was this safe" decision because the mutation happens on the server;
checking after the fact is the leak.

- Middleware: on stamp mismatch and method ∈ {POST, PUT, PATCH, DELETE}, respond
  409 `{ error, code: "build_skew", details: { serverBuild, serverCliPath } }`
  **before** invoking the handler.
- CLI: maps `build_skew` to exit 4 with a message that can now truthfully say
  **"no changes were made — run <serverCliPath>"**.
- Reads: the client-side hard-fail on skew is retained as defense-in-depth (a stale
  parser misreading a new envelope is its own hazard, and the strictness was a
  deliberate choice per `doctor.ts:135-137`) — but the exit-4 text no longer needs an
  ambiguity caveat, because reads are side-effect-free.

**Taxonomy becomes data.** The exit-code table gains one authoritative form next to the
`EXIT_*` constants (code, meaning, recovery pointer) and is derived into: a
`cctl help exit-codes` registry node (help is the recovery path, and the taxonomy
was absent from the CLI's own help), and the cc-cli SKILL.md table via the existing
generator/drift gate. The three currently-false statements (`shared.ts:125`,
SKILL.md:66/:160-162, `cli.md:94` — all still describing warn-only exit-4) are
corrected by that derivation, and can no longer drift independently.

## 5. M4 — One job waiter

**Owner:** new `src/cli/job-wait.ts`.

Four hand-rolled wait loops, four contracts. `workflow wait` is the good one (budget +
continuation command with cursor); `agent run` swallows unparseable status responses
into an infinite-looking poll and then reports "still running"; `validate run` has no
budget at all (`for (;;)`); `dev ensure` and `fixture prompt` drop their forensic
pointers exactly on the failure path. One module owns the policy:

```ts
export interface JobWaitSpec<S> {
  poll(): Promise<{ ok: true; status: S } | { ok: false; parseError: string }>;
  classify(status: S): { terminal: false } | { terminal: true; result: CliResult };
  timeoutMs: number;                          // wired to --timeout; per-command default (30m convention)
  onTimeout(elapsedMs: number): FailureInput; // MUST name the continuation command ("cctl … status <id>")
  forensics?(last: S | null): string[];       // transcript/db/log pointers appended to any failure
  onAbort?(signal: string): Promise<CliResult>; // validate's SIGINT-cancels-owned-run hook
  pollIntervalMs?: number;
  maxConsecutiveParseFailures?: number;       // default 3 → loud "unexpected status response" failure
}
export async function awaitJob<S>(host: CliHost, spec: JobWaitSpec<S>): Promise<CliResult>;
```

Migrations and what each one fixes by construction:

| Command | Gains |
|---|---|
| `agent run --wait` | parse failures fail loud after 3 consecutive misses instead of masquerading as "still running" |
| `validate run` | `--timeout` with a `wait_timeout` failure naming `cctl validate status <runId>`; SIGINT cancel preserved via `onAbort` |
| `workflow wait` | unchanged contract, shared machinery; its cursor continuation becomes the `onTimeout` reference implementation |
| `dev ensure` | timeout failure carries the last-known status + `recentOutput` and hints `cctl dev list` via `forensics` |
| `fixture prompt --wait` | the `error` outcome carries `transcriptPath`/`dbPath` (already computed at `fixture.ts:537`) like the success path does |

**Validation queue admission uses `--queue-if-busy`.** `validate run` always blocks to
a verdict; this flag only opts a busy submission into the strict FIFO admission queue.
`agent run --wait` and `workflow run --wait` retain `--wait` because those flags toggle
blocking. Ticket `remote-ai-manager#12` recorded agents launching duplicate validation
commands after misreading the shared spelling, satisfying the earned-guidance rule with
an observed failure. The CLI registry, generated skill block, `AGENTS.md`, steering, and
lane instructions cut over together; the old validation spelling is not retained as an
alias.

## 6. M5 — Registry-derived dispatch everywhere

**Owner:** `src/cli/dispatch.ts`, extended to the root; foot-guns deleted.

- **The root becomes a group like any other.** `dispatchCli`'s hand-written if/else
  chain (`core.ts:253-345`) is replaced by the `dispatchGroup` construction over the
  registry's level-1 entries (leaves `ask`/`notify`/`doctor`/`version` included in the
  handler map). Construction throws on disagreement at import — the same guarantee
  every other group already has. The contract test extends to drive every level-1
  entry through `runCli` and assert the result is not `unknown command`.
- **`ticket` routes through `dispatchGroup`** at its three hand-rolled sites
  (`ticket.ts:315-355`, attach kinds `:831-851`, attachment verbs `:1343-1354`); the
  attach kinds become registry children with handlers. Today's lists are verified
  in-sync — this change makes staying in sync structural rather than observed.
- **`checkFlags` takes the registry key, not a string array.** Signature becomes
  `checkFlags(flags, entryPath)`; it derives the allowlist via `flagNamesFor`
  internally. The `readonly string[]` parameter — the one remaining way to hand-write
  an allowlist — is deleted. ~99 call sites migrate mechanically.

Side effect: `core.ts` shrinks toward its charter (dispatch, help resolution, identity
plumbing), which also shrinks the `commands/<name>.ts` placement risk the steering doc
documents (G8) without a new ratchet.

## 7. M6 — Prose payloads: file sources derived from flag metadata

**Owner:** the help registry (one metadata bit), the parser, and one shared resolver.

Load-bearing prose currently travels only as shell argv on: `workflow task complete
--summary`, `task add --instructions`, `collab request --brief`, `ticket create
--description`, `ticket attach note` (positional body), `spec reply --body`,
`spec question --text`. Shell substitution has already corrupted such content in
production (the recorded backtick-blanking failure). Rather than hand-adding seven
`--x-file` flags that can drift:

- `CommandHelpEntry` flag metadata gains `fileSource?: true`.
- The parser derives the paired `--<name>-file <path>` flag (with `-` = stdin, matching
  the existing readers), `checkFlags` allowlists it automatically, and the help
  renderer appends the "(or `--<name>-file`)" line — all from the one bit.
- A shared `resolveProseArg(flags, host, name)` reads flag-or-file, enforces mutual
  exclusion and a sanity byte cap (exit 2).

One decision, every surface derived — the same move that made help drift impossible.

## 8. M7 — `cctl logs`: expose the existing analysis engine

**Owner:** new `src/cli/commands/logs.ts` as a thin adapter.

A bounded log-analysis CLI already exists (`src/lib/logging/log-analysis/cli.ts`) but
is unreachable from the agent's tool contract — no `cctl` verb, no failure text or help
pointing at it. Add a `logs` group whose verbs mirror the engine's capabilities
(report/trace/compare — exact verb set taken from `LogAnalysisCliRuntime` at
implementation time), delegating wholesale. The engine stays owned by
`src/lib/logging/log-analysis` (the CLI knows nothing of DuckDB); envelopes and text go
through M1/M2 so budgets and tiers apply. Help gets `related` edges `doctor ↔ logs`.
Failure-path hints pointing at `logs` are added only where an observed debugging
failure earns them — not sprayed speculatively.

## 9. Validate verb depth (crosses the server schema)

The "zero files matched = silent green" trap and the invisible pass verdict are one
missing fact plus one missing line:

- **Server:** the validation result schema (`src/lib/validation/schemas.ts:259-264`)
  gains `filesMatched?: number` on the passed/failed kinds — the service already
  resolves the scope, so it owns the count. (Persisted-field change ⇒ repository
  mapping + round-trip contract fixture per the persistence rules.)
- **CLI, both modes:** a stable verdict line —
  `validation passed: test (scope changed→changed, 12 files, run r-…)` — rendered
  before any relayed output. On `filesMatched === 0` the verdict says
  `0 files matched — vacuous pass, verify the scope path`, and the envelope carries the
  count. Exit code stays 0 by default (merge gates depend on green semantics); a
  `--require-match` flag exits 1 for callers that want the ratchet.
- **Pass-mode output relay** is bounded to a tail (the failure arm already relays in
  full); the verdict line makes an empty-output green run unambiguous.
- `validate run`'s leaf help gains the two earned failure modes (typo'd path = vacuous
  green; verdict is in the JSON envelope) — both have recorded incidents, so they meet
  the admission rule.

## 10. Ratchets, doc derivation, and one-off corrections

Ratchets — only where construction can't reach:

| Ratchet | Convention it holds |
|---|---|
| `json-volume-exceptions.ts` declare-or-fail list (two legacy entries, each with deletion condition); stale entries fail | "`--json` never changes volume" + its documented exceptions (a third exception now requires a reviewed edit) |
| Registry-driven sweep: every leaf × stub host ⇒ stdout parses as one JSON object with boolean `ok` | universal `--json` envelope shape |
| `stopInstruction` allowlist grep pinned to its two current files | legacy spelling containment |
| Single-line assertion on `hint` at the `arbitrate` seam | hint tier contract |
| Exit-3 construction routed through one `connectionFailure()` helper appending the doctor pointer; `workflow wait`'s continuation line recorded as the one approved survivor | "exit-3 output points at `cctl doctor`" |
| SKILL.md prose linter: `cctl` usage lines outside the generated block must resolve against registry usage shapes | hand-prose drift (three confirmed instances get fixed in the same change) |

One-off corrections folded into the phases that touch their files: the three false
exit-4 statements (§4 derivation); stale help-module comments (`meta.help.ts` doctor
location claim; "ported from legacy" narration moves to this design series); the
unbounded server-issue rendering in `shared.ts:1288-1303` adopts spec's cap-plus-
"and N more" (M2 owns it); the read-scope auto-widening carve-out (conversation
commands resolving a foreign conversation's scope from its id) gets recorded in
`cli.md` as intended policy.

## 11. Sequencing

Each phase lands independently, TDD-first (every behavior change starts from a failing
test; the M1 drain fix starts from the failing e2e pipe test).

1. **Truthfulness** — M1 drain fix; M2 renderer collapse (+ tier-fit sweep); M3
   middleware gate + truthful exit-4 text + taxonomy derivation; validate verdict line
   (client side). Small diffs, all four recorded live incidents closed.
2. **Job waiter** — M4 + five migrations; `filesMatched` server schema + vacuous-pass
   disclosure.
3. **Dispatch derivation** — M5 (root group, ticket, `checkFlags` key signature).
4. **Disclosure** — M1 primitive + consumers (`workflow --full`, ticket, spec sections,
   `dev list` parity, ledger `note:` migration).
5. **Payloads & logs** — M6 file sources; M7 `logs` group.
6. **Ratchets & docs** — §10 table, SKILL.md prose cleanup, `cli.md` amendments
   (client-advisory list, `next:` vocabulary, carve-out, this doc referenced).
7. **Debt retirement** — `workflow status` / `spec status` selector ladders; delete
   both entries from the exception registry (their deletion conditions).

`cli.md` and the cc-cli SKILL.md are updated in the same change as each phase that
alters a surface they describe (the existing rule), and every phase runs `seams` +
the registry contract suite.

## 12. Decisions Alex may want to veto

1. **Reads still hard-fail on build skew** (only mutations gain the pre-execution
   server refusal). Alternative: warn-and-proceed on reads.
2. **Validation queue admission is `--queue-if-busy`**; `validate run` always blocks
   to a verdict, while `agent/workflow run --wait` still decides whether to block (§5).
   The cutover is intentionally breaking; there is no validation `--wait` alias.
3. **Vacuous green stays exit 0** with loud disclosure + opt-in `--require-match`
   (§9). Alternative: exit 1 by default — stricter, but changes merge-gate semantics.
4. **Client-authored reminders become legal** via one enumerated, evidence-carrying
   list (§3) — an amendment to `cli.md`'s "server authors reminders" rule.

## 13. Score

Method: A Philosophy of Software Design rubric (deep modules, information hiding,
one owner per decision, comments as design intent).

- **Current CLI: 7/10.** The help registry, identity contract, structured-error
  threading, and spec disclosure ladder are reference-grade (the steering doc is
  itself unusually honest about ownership). Held back by: tier policy and job-wait
  policy duplicated at call sites and drifted; egress owned by no one; the registry
  guarantee lapsing exactly at the root and `ticket`; four steering-doc laws held by
  prose; two truthfulness defects (post-commit exit 4, invisible verdict).
- **This design: 9.5/10.** Every duplicated policy gets one owner; the two worst
  defect classes (truncated envelopes, post-commit refusals) become unrepresentable;
  conventions are enforced by derivation or declare-or-fail data rather than review.
  The remaining half point: the two legacy `--json` dumps persist until phase 7, the
  omission-disclosure guarantee for *new* queries still rests on per-command contract
  tests plus the checklist (a fully fixture-driven registry sweep was judged not worth
  its complexity), and the hint-token sweep is lexical, not total.
- **To 10/10:** land phase 7, and if a new query ever ships a silent cap despite the
  primitive, upgrade the disclosure sweep to fixture-driven then (earned, not
  speculative).
