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
