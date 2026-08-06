# T19 live delivery-gate proof — evidence capture (R5.3, R1.2)

Committed capture of the live proofs for `workflow-validator-cohorts/R5.3`
(one context gated by two specialist validator assignments with distinct
profiles against one frozen candidate) and `workflow-validator-cohorts/R1.2`
(an implementer lane staffed with a non-default profile).

The narrative record is the shared document
`.cc/graph-workflow-docs/live-delivery-gate-proofs.md`. This directory is the
part that must survive: the primary artefacts, and the exact inputs needed to
re-run the proof.

## Provenance — read this before citing anything below

The execution described here **really ran**, on 2026-08-05, and was verified at
the time against SQLite rows, workflow events, backend transcripts, git objects,
and the rendered inspector. It ran on a second dev server (port 3055) built from
this branch at `036ca1cf`, against a throwaway project at `/tmp/ccT19/cohortproof`,
session `gatedrun`, with `CC_CONFIG_DIR=<worktree>/.config`.

**Its live artefacts no longer exist.** The proof run's own cleanup deleted the
CC session (`DELETE /api/projects/cohortproof/sessions?sessionName=gatedrun`),
then `rm -rf /tmp/ccT19` and `rm -rf .config`. Deleting the session cascades:
`graph_workflow_executions`, `graph_workflow_archived_executions`, and
`graph_workflow_events` are all `FOREIGN KEY … ON DELETE CASCADE` on
`sessions(project_path, session_name)`. So the execution rows, the events, the
lane conversations, the four backend transcripts, the scratch git repository,
and the inspector screenshots are all gone. Nothing in the original record is
re-derivable from live state today.

Everything quoted below is the **verbatim harness-generated output** of the
verification commands as they ran, recovered from the proof conversation's
transcript:

```
~/Library/Application Support/cc/transcripts/79dfafc3-3428-4042-aa64-e4d748af25a6.jsonl
```

These are `tool_result` records — `sqlite3` stdout, `git cat-file` stdout,
Playwright `eval` output — produced by the tools, not written by the model.
That is a weaker guarantee than live re-derivation (the capture is fixed; you
cannot ask it a new question) but a much stronger one than a summary, and it is
the distinction this document is careful to preserve. To answer a *new*
question, re-run the proof with the inputs in this directory.

## The run

| | |
| --- | --- |
| project / session | `cohortproof` / `gatedrun` (throwaway, deleted after the run) |
| definition | `e328ba6e-075d-481b-9b84-f7803b7c743c` — "T19 cohort and persona live proof" |
| execution | `0847749d-433a-43a9-88b6-b887958d8234`, status `completed`, one iteration |
| context | `greeting` — add `greet.js` + `greet.test.js`, five literal acceptance criteria |
| implementer | assignment `implementer` → `global:persona-implementer@1`, claude/sonnet |
| cohort | `contract-lens` → `global:contract-lens-reviewer@1`; `coverage-lens` → `global:coverage-lens-reviewer@1`; both `conversation` strategy, claude/sonnet |
| landed commit | `e2485c3` "Graph workflow context greeting"; published at `061571c` |

Each of the three profiles carries a marker token and nothing else distinctive:
`PERSONA-ECHO-7734:` (implementer), `CONTRACT-LENS-4211:` (contract lens),
`COVERAGE-LENS-8899:` (coverage lens). No task instruction, acceptance
criterion, or charter field contains these tokens, so a token appearing in an
output is attributable to the profile block and to nothing else. That is what
makes the markers evidence rather than decoration — the same discipline the
write-envelope and prompt-authority suites use.

## R5.3 — two specialists, one frozen candidate

### One frozen candidate, confirmed against git rather than engine bookkeeping

`contextStates.greeting.validationRound` (seq 1) held one candidate shared by
both seats:

```json
"candidate": {
 "candidateTreeHash": "330fe8a7a4ec14041bff618f5d271ee1df5ca7ce",
 "headSha": "7d16a404009b5998c3be0f1a6fd52a71a475ec5e",
 "taskStateHash": "dabd1def35b874c519751aaa1f3443feafd34448a50a34fa70891ba4e4ad6775"
}
```

`git cat-file -p e2485c3` and `git cat-file -p 330fe8a7…` returned:

```
tree 330fe8a7a4ec14041bff618f5d271ee1df5ca7ce
parent 7d16a404009b5998c3be0f1a6fd52a71a475ec5e
author Live Test <livetest@example.com> 1785938796 -0400
---
100644 blob 61c3eb2d2dc73e262fc9f8b63b686b6eb1d2ebad	README.md
100644 blob 07ab6231a3d80c5d540047ad55e37194c13c4e0d	greet.js
100644 blob da21a1cf7b0cbc7aa9dac5df6cfcf6b3d8a6bfba	greet.test.js
```

The recorded `candidateTreeHash` **is** the git tree the lane landed, and
`headSha` is that commit's parent — the base the round pinned. Both specialists
are seats in this one round; there is no second candidate either could have
reviewed.

### The roster froze both seats before either ran

```json
"roster": [
 { "assignmentId": "contract-lens", "profileRef": {"tier":"global","id":"contract-lens-reviewer"},
   "revision": 1, "strategy": "conversation",
   "resolvedInstructionHash": "sha256:37604fe6c3c5d05f299392f0a3a7e86c21234869da9b375301ac3898b4a97751" },
 { "assignmentId": "coverage-lens", "profileRef": {"tier":"global","id":"coverage-lens-reviewer"},
   "revision": 1, "strategy": "conversation",
   "resolvedInstructionHash": "sha256:7129576704a9ef4d02dfe0be4b60565d24dfb4c25745f6301426295a321221ed" }
]
```

Distinct `resolvedInstructionHash` values are what make "distinct profiles" a
mechanical fact rather than a naming convention.

### Two independent verdicts, grouped by assignment

`validationRound.specialists` carried one entry per assignment, each with its
own `state`, `summary`, `issues`, `sessionRef`, and `reviewArtifact`:

| assignment | state | own conversation | summary opens with |
| --- | --- | --- | --- |
| `contract-lens` | `verdict_pass` | `fdcd4fa2-6cb1-464c-8dd2-33ef523816b4` | `CONTRACT-LENS-4211:` |
| `coverage-lens` | `verdict_pass` | `d8117afa-95e4-48e0-af9a-638ee0ad2169` | `COVERAGE-LENS-8899:` |

The two summaries are substantively different reviews, not two renderings of
one. Contract-lens argued the exported shape and the literal return strings
(criteria 1–3); coverage-lens argued the test file and the passing `node --test`
run (criteria 4–5). Each ran `node --test` itself.

Events `37` and `38` were `graph-workflow-validation-specialist-result`, one per
assignment, each carrying `assignmentId`, `profile {tier,id,revision}`,
`resolvedInstructionHash`, `pass`, `summary`, `issues`, and its own `sessionRef`
and `reviewArtifact`. Event `39` was the aggregate
`graph-workflow-validation-result` with `roundSeq: 1`, `pass: true`,
`issues: []`, `reopenTaskIds: []`, a concatenated summary carrying **both**
markers, and a `specialists[]` array reproducing each member's profile ref,
revision, instruction hash, and verdict. The aggregate is derived from the
members, not from one reviewer's verdict.

### One round, one charge

```
iterationCount: 1 consecutiveFailureCount: 0 status: completed
```

Cohort size did not multiply the iteration budget.

### Per-assignment lanes are separate, and the inspector shows them apart

`laneStates.greeting` is keyed per assignment, not per role:

```
context_validator:contract-lens   sha256:37604fe6…|conversation|true||claude|sonnet|medium  → fdcd4fa2…
context_validator:coverage-lens   sha256:71295767…|conversation|true||claude|sonnet|medium  → d8117afa…
implementer                       sha256:b11222b5…||true||claude|sonnet|medium              → a56f3a16…
```

Each validator lane also persisted its own `conversations.profile_snapshot`, so
the seats are distinguishable at the conversation layer too, not only inside the
round record.

In the inspector's **History** tab, the "Validation Round #1" card
(`data-testid="cohort-round"`) rendered — Playwright `eval` output, verbatim:

```json
{
 "profiles": ["global:contract-lens-reviewer@1", "global:coverage-lens-reviewer@1"],
 "states":   ["Passed", "Passed"],
 "agg":      "Cohort passed 2 validators · candidate 330fe8a7"
}
```

with two `cohort-member` rows, each carrying its own profile ref, strategy,
state, a per-member **View Transcript** action, and that member's own summary.
The aggregate line names the candidate hash, so "same frozen candidate" is
legible in the UI and not only in the database.

## R1.2 — implementer on a non-default profile

The seeded default implementer is `builtin:general-implementer`
(`SEEDED_WORKFLOW_DEFAULTS`); this context staffed `global:persona-implementer`.

**The lane's persisted seeded snapshot carries that profile.** Selecting
`profile_snapshot` across every conversation in the run returned:

```
f7a76750…|gatedrun 1|         |standard-agent        |Standard Agent         |1|sha256:82e0e8e2…|2026-08-05T14:05:15Z
a56f3a16…|gatedrun 2|iteration|persona-implementer   |Persona Implementer    |1|sha256:b11222b5…|2026-08-05T14:05:53Z
fdcd4fa2…|gatedrun 3|validator|contract-lens-reviewer|Contract Lens Reviewer |1|sha256:37604fe6…|
d8117afa…|gatedrun 4|validator|coverage-lens-reviewer|Coverage Lens Reviewer |1|sha256:71295767…|
```

The implementer lane (`a56f3a16…`, role `iteration`) persists the persona
snapshot with `profile_locked_at` set, and its `resolvedInstructionHash`
(`sha256:b11222b5…`) equals the `assignmentFingerprint` prefix on the
`implementer` lane state — the execution-seeded snapshot was replayed into the
lane, not re-resolved there.

The control matters as much as the positive: the ordinary session conversation
created in the same session (`gatedrun 1`) carries `standard-agent`. The persona
is the context's staffing, not an instance-wide default.

**The lane's behaviour reflects its instructions.** Both persisted task
summaries begin with the profile-only token:

```
write-greet        PERSONA-ECHO-7734: Created greet.js at repo root as plain CommonJS…
write-greet-tests  PERSONA-ECHO-7734: Created greet.test.js at repo root using node:test…
```

and the lane's final message ended:

```
Running as the Persona Implementer profile.
```

— the profile's second instruction. Both are durable (`taskStates[*].summary` in
the execution row; the lane transcript), and neither string is derivable from
anything but the profile block.

**The inspector shows the implementer's profile identity.** With the context
selected, the resolved-setup strip rendered — Playwright `eval` output, verbatim:

```json
{
 "impl":  "GLOBAL:PERSONA-IMPLEMENTER@1",
 "strip": "GLOBAL:PERSONA-IMPLEMENTER@1 · CLAUDE SONNET · MEDIUM
           VALIDATOR · CONTRACT-LENS · CLAUDE SONNET
           VALIDATOR · COVERAGE-LENS · CLAUDE SONNET"
}
```

(`data-testid="setup-implementer-profile"`). Identity is the profile ref **and**
its revision, which is what separates "which instructions did this lane actually
receive" from "which profile is named in config" after a library edit.

## Re-running the proof

`plan.json` and `profiles.json` in this directory are the exact inputs the run
used, recovered verbatim. `plan.json` is machine-verified to still parse against
this branch's `workflowSemanticDefinitionSchema`, with the two-seat cohort and
the non-default implementer intact.

1. Start a dev server from this branch **with an explicit own-port server URL**:
   `env -u CC_API_TOKEN -u CC_SESSION -u CC_PROJECT -u CC_CONVERSATION_ID \
    CC_SERVER_URL=http://127.0.0.1:3055 PORT=3055 bun run dev`
2. Create the three profiles at **global** tier (`POST /api/agent-profiles`),
   one body per element of `profiles.json`.
3. Create a scratch git project **outside this worktree** (the run used
   `/tmp/ccT19/cohortproof`) with a `README.md` and one initial commit, register
   it as a CC project, and create a session.
4. Build this branch's `cctl` (`bun build src/cli/index.ts …`) and drive it at
   the dev server: `workflow validate` → `create` → `start` with `plan.json`.
5. Verify against `<worktree>/.config/command-center.db` — `validationRound`,
   `graph_workflow_events`, `conversations.profile_snapshot` — and the inspector
   at `/projects/<project>/<session>/workflow`.

**If you re-run it, do not delete the evidence.** Keep the scratch repository
and the dev config dir until the artefacts have been copied somewhere durable;
that omission is the only reason this file is a capture rather than a pointer.

### Two environment traps, neither a defect in this spec

**1. A long project path breaks the base64url scope key.** Project-scoped
storage directories are named `base64url(projectPath)`
(`agent-profiles/<scopeKey>/`, `workflows/<scopeKey>/`). Once the path exceeds
~191 bytes the encoded name passes the 255-byte filename limit and the request
fails with a raw 500 `ENAMETOOLONG` — observed verbatim as
`ENAMETOOLONG: name too long, mkdir '…/.config/workflows/L1VzZXJzL2FsZXgv…'`.
This is pre-existing and CC-wide (`workflows/` has always been keyed this way).
It is why the proof staged its project at `/tmp/ccT19` and authored the profiles
in the **global** tier. Worth a located refusal rather than an ENAMETOOLONG
surfaced as "request failed", but out of scope here.

**2. A manually started second dev server hands lane agents no server URL.**
When the dev server inherits an ambient `CC_SERVER_URL` pointing at another CC
instance, the boot self-probe correctly detects the identity mismatch and
`getServerBaseUrl()` flips to null — refuse-to-inject. The lane agent then gets
`CC_SERVER_URL=""`, `cctl` fails, and the agent goes looking: the first attempt
at this proof found the production config dir and re-pointed itself at the main
instance before it was aborted. The refuse-to-inject behaviour is right; the
downstream failure mode is an agent improvising toward whatever CC it can find.
Start the second server with an explicit own-port `CC_SERVER_URL` and confirm
with a one-line `printenv CC_SERVER_URL` turn before starting any workflow.

## What this capture does not establish

- **Deterministic round semantics** — one charge per round, stale-candidate
  rejection, infra-vs-semantic conclusion — are out of scope here by the
  approved strategy note; the engine tests own them. This proof establishes only
  that the wired system does in production what those tests assert in isolation.
- **A failing cohort round.** Both specialists passed. Remediation grouping and
  the single `consecutiveFailureCount` increment on a semantic failure are
  covered by the engine tests, not by this run.
- **Codex-backed cohorts.** Every lane in this run was claude/sonnet.
