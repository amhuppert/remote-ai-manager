# Legacy plan import fixtures

Captured production history, not authored test data. Two real specs delivered
through the legacy spec→graph compiled path before `DeliveryPlanAttempt`
existed; these files are what the shadow parity harness holds the importer and
the materializer to.

| Fixture | Spec | Legacy `spec_executions` row | Archived graph-workflow execution |
| --- | --- | --- | --- |
| `dynamic-graph-primitives.*` | `dynamic-graph-primitives` revision 10 | `9a80ae41-5695-4ca7-a422-a81376fa06cc` | `0610d70e-7823-49a6-8b9d-09448ae21afe` (aborted) |
| `workflow-validator-cohorts.*` | `workflow-validator-cohorts` revision 11 | `f3644b0d-e174-48c9-9fcd-3f8127f1c700` | `6462969a-9395-41ca-8a7d-8f8a24163116` (completed) |

`*.legacy-plan.json` carries the spec row, the legacy execution row (including
its validated `scope_json`), and the whole approved revision snapshot — the
importer's only inputs.

`*.launched-definition.json` carries the definition the archived execution was
LAUNCHED with: the saved definition record named by the archived execution's
`seedDefinitionId` at its `seedDefinitionRevision`. The capture asserts that
identity, so the file cannot silently become a later revision of the same
record.

The archived execution's own `workingDefinition` is that seed plus whatever the
run amended after launch, so it is not a compilation basis. What those
amendments were is recorded in `postLaunchAmendments` — per context, the field,
both lengths, both digests, and whether the archived text merely extends the
seed — so the difference between "what the compiler produced" and "what the run
ended up executing" stays visible without carrying a second copy of every
instruction.

Both definitions also carry authored edits made to the saved record BEFORE
launch (a workflow-config validator selection on `dynamic-graph-primitives`, an
`iterationPolicy` on one `workflow-validator-cohorts` context). Those are edits
to a definition, not outputs of compilation; the parity report classifies them
under `pre-launch-authored-edits` rather than as compilation differences.

These files are listed in `.prettierignore`: they are captured bytes, and a
formatter rewriting them would make it impossible to tell a capture from an
edit.
