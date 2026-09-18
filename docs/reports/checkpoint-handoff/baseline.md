# Optional checkpoint handoff regression baseline

Recorded before production edits on 2026-09-18T04:00:38.780318+00:00

- HEAD: `42946e4cc18de1b729653f679b042db6339a7279`
- Initial dirty-path inventory: clean (no tracked or untracked changes).

Registered checks run sequentially. Verdicts below retain the first JSON object; CLI runner text may follow it. Baseline failures are attribution evidence, not a waiver of later gates.

## typecheck

```json
{
  "ok": true,
  "code": "validation_passed",
  "commandName": "typecheck",
  "kind": "passed",
  "runId": "vrun-5abbdb55-ea0b-44f8-89ec-a01c516bb3c4",
  "exitCode": 0,
  "output": "",
  "requestedScope": "changed",
  "effectiveScope": "full",
  "queuePositions": []
}
```

## seams

```json
{
  "ok": true,
  "code": "validation_passed",
  "commandName": "seams",
  "kind": "passed",
  "runId": "vrun-90c1aa0e-0bf0-4731-80c8-4d0c6eb82c2d",
  "exitCode": 0,
  "output": "",
  "requestedScope": "changed",
  "effectiveScope": "full",
  "queuePositions": []
}
```

## lint

```json
{
  "ok": true,
  "code": "validation_passed",
  "commandName": "lint",
  "kind": "passed",
  "runId": "vrun-0e699af2-c7b4-4432-ba57-cf5c5b74606c",
  "exitCode": 0,
  "output": "",
  "requestedScope": "changed",
  "effectiveScope": "changed",
  "queuePositions": []
}
```

The initial lint run used changed scope on the clean tree; a full-scope lint verdict will be collected for the baseline.

## Full test suite

Command: `cctl validate run test --scope full --require-match --queue-if-busy --json`

```json
{
  "ok": true,
  "code": "validation_passed",
  "commandName": "test",
  "kind": "passed",
  "runId": "vrun-567d78d6-20b5-4684-9082-393804dca07a",
  "exitCode": 0,
  "output": "",
  "requestedScope": "full",
  "effectiveScope": "full",
  "queuePositions": []
}
```

## Full lint

Command: `cctl validate run lint --scope full --queue-if-busy --json`

```json
{
  "ok": true,
  "code": "validation_passed",
  "commandName": "lint",
  "kind": "passed",
  "runId": "vrun-6ef891e2-73fa-49a6-9b09-69608b2145a9",
  "exitCode": 0,
  "output": "",
  "requestedScope": "full",
  "effectiveScope": "full",
  "queuePositions": []
}
```

## Attribution and invariant check

All required registered checks settled successfully. No pre-existing failures were reported. The successful JSON envelopes expose no test count; full scope and `--require-match` were requested explicitly.

Post-validation `git diff --name-only` returned no paths: no tracked source, fixture or snapshot changes.

The only added path is this baseline report. The `one-owner` invariant is unchanged: no runtime, queue, repository, or backend production code was added or modified. No tests were added because this task records existing behavior without changing it.
