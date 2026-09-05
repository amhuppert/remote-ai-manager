# Ticket #80: planning instruction contracts

Date: 2026-09-05. Scope: the planning-instruction work authorized by notepad `4fa1061b-dd19-4392-ad37-67aa07c343b5`, revision 83. Native-SDD simplification steps 4–6 remain in #109.

## Design

The planner establishes feasible obligations, the reviewer checks their premises, and execution agents close the whole known defect class. These decisions belong in the existing skills and prompt builders; they need no schema fields, lexical lints, or engine transitions.

| Change set | Owner | Contract | Evidence that earned it |
| --- | --- | --- | --- |
| Premise and class enumeration | `role-instructions.ts` blocking contract | Enumerate sibling defects within the context and mandate before returning. Group by class, splitting only for distinct task/criterion ownership so the verdict can reopen every owner. | Consolidated retrospective FM-5/R3: `81d48065`, `24771b4f`; memory CLI sibling findings across rounds. |
| Premise and class enumeration | `iteration-prompt.ts` initial and follow-up prompts | A self-discovered gap against this context's criteria keeps its task open; a residual in the handoff does not discharge it. One shared string reaches both turn types. | FM-8/R3: `memory-policy-cascade` and July checklist churn. |
| Premise and class enumeration | Planning skill, Acceptance Criteria | Verify the authoritative record/field, lifecycle transition, or embedder control. Label relevant premises verified with `file:symbol` evidence or inferred in existing prose fields. An inferred premise is not execution-ready. Explicitly assign the producer of intentionally introduced state. | FM-1/R2: `81d48065` unretained history, `6068bd10` revision identity, `24771b4f` provider settings. |
| Premise and class enumeration | Review skill, feasibility lens | Open cited sources independently. Return changes requested on an inferred or unsupported premise. Enumerate multi-surface proof obligations with named tests or split them. | FM-1/FM-2/R2: the same premise incidents, memory CLI and `29e46e86` notepad breadth. |
| Defaults and documentation | Planning skill and validation reference | Explain task-boundary rotation; select cheap gates for valid `full` contexts, preserve barrier rules for enveloped contexts, and bound test runs. Final verification declares ownership, baseline/non-regression, or escalation for existing failures. | FM-6/FM-7/R4/R5: `24771b4f` token peaks and gate waits; `e39cc5c0` unrelated cleanup; `29e46e86` unsettled check. |
| Defaults and documentation | Workflow Model, prerequisites, placement pointer | Teach ordinary-edge output delivery, runtime discovery of project skills, and committed lane visibility. | FM-9/R7: tournament guesses #1/#4 and memory-delivery planning report. |

The review remains advisory under its existing receipt/acknowledgement protocol. Feasibility blocks the reviewer's approval; it introduces no mandatory review or launch gate. Provider residual disclosure applies to state outside the embedder's control; it never excuses an implementer's gap against an owned criterion.

The authoring defaults do not change the engine's seeded empty script-gate selection. Registered names come from the target project's `cctl validate list`, without assuming CC's own command registry or scope wrappers. `full` contexts on an ordered shared lane retain context gates; `owned` and `readOnly` follow the lane barrier. A captured baseline cannot make a selected failing gate pass.

The single authored source is `plugins/command-center/command-center/skills/`. The publisher creates an immutable runtime bundle; Claude attaches it as a local plugin and Codex links its skills into the launch checkout. Repository-local planning and review copies under `.claude/skills` and `.agents/skills` are removed. Their display metadata lives beside the canonical skills. The planner core stays within its existing 400-line budget.

Agent-facing guidance is portable across managed projects: use illustrative paths, discover registered checks, and explain constraints directly. Incident evidence belongs in this design and its source reports, not in the shipped skills. The documentation contract rejects duplicate project copies and project-specific historical references; help points to the plugin source.

## Source checks and corrections

The incident source is [the consolidated retrospective](../reports/2026-09-03_graph-workflow-planning-retrospective.md), especially R2–R5 and R7. Mutable mechanism claims were checked against production code:

- `context-outputs.ts:resolveUpstreamInputs` returns the captured value, and `iteration-prompt.ts:buildUpstreamInputsSection` renders it verbatim. The retrospective's claim that prompt injection substitutes references above 64 KiB is incorrect. That ceiling belongs to `projectGraphWorkflowResultOutputs` and `result-output-contract.ts`, on the result-query envelope. The skill documents both surfaces accurately.
- `prerequisite-probes.ts:createPrerequisiteProbes` delegates skill probes to runtime `discoverCommands`, including project-local discovery.
- `scripts/validate/common.sh:resolve_validation_diff` selects the diff against the target-branch merge base. Changed-scope validation can therefore cover the whole feature on a workflow lane.
- `iteration-orchestrator.ts` stops follow-ups when `rotateBeforeNextTurn` is scheduled; `execution-tool-context.ts` evaluates task-completion rotation. Task grain remains the planning mitigation for oversized turns.

The separate [execution audit](../reports/2026-09-05_graph-workflow-773a058c-audit.md) assesses `773a058c` and records evidence limits. It is a delivery run that implemented the tooling, not a benchmark of planning after the tooling shipped. Its findings are supplementary; the earlier incidents already justify these instruction changes.

## Verification

Each contract change began with a failing assertion on the absent instruction, followed by the smallest implementation and a passing run through the registered test command:

- `src/lib/workflow-graph/role-instructions.test.ts`: default acceptance and specialist blocking seats require the whole finding class while preserving ownership.
- `src/lib/workflow-graph/iteration-prompt.test.ts`: initial and continuation turns retain self-discovered gaps even with task addition disabled.
- `scripts/graph-workflow-planner-docs.test.ts`: premise labels, feasibility verdict, defaults, baseline, output/prerequisite/visibility contracts, one plugin source, portability, and the existing core-size bound.
- `src/lib/agent-backends/codex/managed-skills-bridge.test.ts`: publish the real plugin, load both planning packages and their references/metadata through the managed link in an unrelated project, and keep that project's git status clean.
- `src/cli/commands/workflow.help.test.ts`: planning and review help references address the canonical plugin skills.

The prompt contracts and validator runner passed together in run `vrun-2c829c85-eec1-476b-be19-fc816ece7140`. After source consolidation, registered `format`, `lint`, `typecheck`, and `seams` passed; eight targeted test files passed in `vrun-f609b5bd-31ed-47a3-85d3-93bc0b446263`, covering the planner docs, workflow help, help rendering, Codex bridge, Claude attachment, bundle publisher, native-spec documentation, and generated CLI reference. The real-plugin delivery check independently passed in `vrun-2ae5c2c8-80e6-483c-a44d-6ff25db374c1`.

These tests verify the instructions delivered to agents and the documented tooling contracts. Whether subsequent agents reduce validation churn requires a future execution; this change does not claim that outcome from string tests.
