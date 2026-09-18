# Probes

Explicit, operator-run programs that exercise Command Center against real
providers. Nothing here is reached by a registered validation command: each
probe spends real credit, so it runs when someone types it and not otherwise.

## checkpoint-continuation

Certifies one backend adapter for CC checkpoint compaction (spec
`cc-checkpoint-compaction`, R9.4). It drives the production conversation
manager and the real adapter through three checkpoint cycles over one
conversation — one of them delivered from the message queue — against an
isolated scratch datastore, config directory and git worktree beneath
`.cc/temp/checkpoint-probes/`.

```sh
scripts/probes/run-checkpoint-continuation.sh --backend claude --scope session
scripts/probes/run-checkpoint-continuation.sh --backend codex  --scope project
```

The source is the continuity corpus in
`src/lib/conversation-checkpoints/fixtures/continuity-corpus.ts`, whose expected
facts are authored from the original dialogue rather than from any checkpoint
output. Continuity claims are settled against durable state — provider
references, seed hashes, receipts, the archive on disk and this run's structured
log; model answers grade retrieval quality only.

Each run is bounded to 12 ordinary and 6 compaction provider calls and stops
before exceeding either. It writes two artifacts under its run directory:

- `evidence/protected-evidence.json` — includes raw provider references, mode 0600
- `evidence/public-report.json` — references replaced by digests, answers excerpted

Exit codes: `0` every check passed, `1` a check or an expectation failed,
`2` the probe could not complete.

## checkpoint-handoff

The optional-handoff harness reuses the production-manager continuation probe
and its independent image/tool continuity corpus. It delivers that original
corpus to the source runtime and adds exact identifiers, an explicitly ambiguous
hypothesis, a rejected approach, and an unfinished file-action canary. Baseline
and capture runs receive the same source facts.

```sh
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope session --scenario cycles --capture off --model sonnet
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope project --scenario cycles --capture on --model sonnet
scripts/probes/run-checkpoint-handoff.sh --backend codex --scope session --scenario failures --case skip --model gpt-6-astra
```

`--backend`, `--scope`, and `--scenario` are required. Cycles also require
`--capture off|on`; failure runs optionally select one `--case`. Each invocation
uses a new isolated config and project beneath `.cc/temp/checkpoint-probes/`.
`--run-id` must be a safe path component and may not overwrite existing evidence.
An optional `--model` records the selected model; native capture initialization
records the observed Claude model separately, without resolving aliases by guess.

Cycles permit at most 12 ordinary, 6 generation, and 0/3 capture submissions for
off/on respectively. Separate failure runs permit 16 ordinary, 12 generation,
and 8 capture submissions. The guards consume a slot before dispatch; rejected
or failed calls remain spent. Native inference retries are separate and reported
as unavailable when the SDK does not expose a count. Capture uses the production
zero-repair policy and unchanged production limits. A cap or unavailable case
produces `incomplete`, never a passing unrun scenario.

Protected records contain raw provider references and capture output and are
written with mode 0600. Public reports carry reference digests, frozen seed/source
hashes, correlated audit inventory, stage and omission metadata, usage provenance,
and a digest of the protected artifact. In-process manager evidence and the dev
lane's authenticated route evidence must be attributed separately: the dev lane
uses its own datastore. The route helper resolves the correct lane through
`cctl dev ensure`/`doctor` and reads that instance's token.

The deterministic `checkpoint-handoff/evidence.test.ts` exercises parsing and
accounting without provider calls. The explicit shell entry is never invoked by
registered validation. Exit codes retain the continuation probe meanings: 0
passed, 1 failed, 2 incomplete.

Capture-on cycles spend their six generation slots on three checkpoints and mark
artifact independence as pending. Certify it afterward in a separate bounded run:

```sh
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope session --scenario failures --case artifact --from-run .cc/temp/checkpoint-probes/claude/RUN-session/evidence/protected-evidence.json --run-id artifact-check
```

This command reopens only the original run's isolated config after checking real
paths inside this worktree's scratch tree. It never prepares or deletes that
run. It snapshots all saved seeds and the accepted provider reference, refreshes
the production reading artifact, reloads durable state, and requires identical
seed bytes, hashes, checkpoint receipts, and provider continuity. Its protected
and public evidence goes to a new `evidence/artifact-ID/` directory. Capture-off
cycles retain the original initial-artifact checks.

`--scenario failures --case routes` runs one selected-backend capture/continuation journey
through the authenticated worktree dev instance in either scope. It verifies
`cctl dev ensure nextjs` and `doctor` agree on this worktree's isolated config,
temporarily selects the scratch project directory, disables automatic naming,
and restores the prior dev configuration after stopping the fixture. Remote
capture and generation upper bounds are reserved before checkpoint POST and
reported as reservations, separately from observed receipt pass counts. The
small tool-free source fixture keeps generation in one window; oversized or
tool-using setup is refused before checkpoint submission. Raw route responses
are protected in `route-evidence.json`; public responses are digests.

Failure cases include pending-action, skip, cancel and natural output-limit
challenges; a challenge that does not hit its intended bound reports incomplete.
Claude setup-control-rejection injects a rejection at the real SDK Query control
boundary before capture dispatch. Provider-interruption sends SIGTERM through the
observed owned capture child's SDK handle. Execution-limit suspends that child
and resumes it after the unchanged 60-second deadline to exercise settlement.
All preserve actual SDK/provider execution and record their explicit fault origin.

The separate `--case output-limit-injected` is excluded from the default case
list. After a real successful SDK capture result, it privately saves the original
frame and appends only whitespace to a marked forwarded answer until it reaches
6,145 bytes. Original usage, cost and correlation fields remain unchanged. This
checks the shipped raw-output bound; it is **not provider-authored overflow**.
Natural output-limit challenge reports remain separate.

`--case daemon-restart` is an explicit Claude/Codex route scenario. It stops only the
observed isolated dev daemon during initialized capture, collects its observed
process tree, restarts through cctl, and checks that queued input stays held.
After observed cleanup it submits the production stopped-execution acknowledgement
as explicit test-operator testimony, then requests separate baseline recovery.
The probe verifies no capture replay, exact held-queue acceptance and archive
prefix preservation, restores dev configuration and collects replacement
processes. Protected `restart-evidence.json` separates testimony from process
observations; no human approval state is fabricated.

`--reasoning none` omits the effort parameter. Actual model policy may reject that
selection (Sonnet); the tested Haiku selection supports it. Record native model
initialization and never infer a resolved model from an alias. Claude findings,
including incomplete natural overflow and failed semantic retention, are in
`docs/reports/checkpoint-handoff/claude.md`. Helper tests alone do not certify any
live scenario.

Codex cycles use normal callable tools, first prove an actual scratch write, then
leave a source action unfinished during instruction-only capture. Native attempt
windows and filesystem effects supplement transport notifications; abstention is
a behavioral result, never evidence of absent tools. The installed SDK app-server
metadata is authoritative for runtime version.

Codex explicit `--case tool-violation` and `--case output-limit-challenge` replace
only the capture prompt with an attributed fault challenge before production
byte measurement. The former asks for a real scratch write; the latter asks the
provider to generate an answer over 6,144 bytes. Output is not injected, numeric
limits are unchanged, and these cases are excluded from default runs. Inspect
actual native calls and effects; rejection does not undo a write. Provider loss
and deadline faults record owned PID/start checks and preserve uncertainty holds
when cleanup is unverified.

`--backend codex --scope session --scenario failures --case running-terminal`
performs one ordinary call with a yielded owned sleep process. It observes the
exact PID/start at native turn completion, then checks that production close
collected the terminal and app-server. It never requests capture or bypasses
source eligibility. `terminal-public.json` and protected terminal/native records
retain the observations. Codex results, including retained incomplete runs and
semantic failures, are in `docs/reports/checkpoint-handoff/codex.md`.
