---
name: native-sdd-authoring
description: Author and review native Command Center specs and graph-shaped delivery plans. Use when drafting, linting, proposing, revising, approving, planning, starting, capturing discoveries for, or amending a native spec through cctl spec and its compiled graph-workflow execution.
---

# Native SDD Authoring

## One-context-provable criteria

Give every selected criterion exactly one owning delivery-plan context. Let that context contain as many ordered tasks as its single validation thesis needs; task boundaries organize work but never manufacture separate validator contracts.

When proof genuinely spans contexts, split the criterion into independently provable criteria or add one bounded integration context as the sole owner of the combined outcome. Keep the authored context boundary aligned with what one validator can prove from production behavior.

Inspect the plan shape with `cctl spec plan edit --help`. For the generated compile, lint, and evidence registries, run `cctl spec schema guidance`.

## Typed integration/closeout ownership

Type a criterion-owning implementation context as `delivery`. Admit a context with no selected criterion only by typing it `integration` or `closeout` and giving it its own observable acceptance contract. Name the production integration or closeout result the context owns; a prerequisite apology or task list is not a contract.

Keep criterion ownership, production-wiring ownership, proof intent, and deterministic validation selection explicit in the authored plan. Inspect the document with `cctl spec schema delivery-plan`; for the generated compile, lint, and evidence registries, run `cctl spec schema guidance`.

## Removal and reintroduction symmetry

Remove draft elements by handle with `cctl spec remove`. When a surviving element refers to the target, update or remove both sides in one `cctl spec draft` batch so the transaction never leaves a dangling reference.

Treat removal as reversible history, not deletion. Reintroduce the same element id with `"reintroduceHistorical": true` and `"baseElementVersion": null`; this restores its original number and handle. Follow the exact recovery printed by the removal receipt.

Inspect both acts with `cctl spec remove --help`, `cctl spec draft --help`, and `cctl spec schema element-batch`. For the generated compile, lint, and evidence registries, run `cctl spec schema guidance`.

## Withdraw-proposal vs dismiss-superseded

Use `cctl spec withdraw-proposal` only to take back a proposal authored by the current conversation before a human has acted. It ends that revision and opens its content as a follow-up draft for repair.

Use dismiss-superseded only for a stranded proposal that a later approved lineage forked past. This is a human act, records the superseding revision and reason, and opens no draft. Never substitute withdrawal when stale content must stay closed.

Inspect the distinct guards and outcomes with `cctl spec withdraw-proposal --help` and `cctl spec dismiss-superseded --help`. For the generated compile, lint, and evidence registries, run `cctl spec schema guidance`.

## Element-id/handle/version semantics

Treat an element id as its globally unique, immutable identity. Treat its handle, such as `R3.2` or `D4`, as the human address assigned within the spec and preserved when the same id is reintroduced. Use ids in typed references and handles in CLI addresses unless a schema says otherwise.

Treat `elementVersion` as a compare-and-swap token local to one revision. Versions restart when approved content is copied into a new amendment revision, so re-read every element before writing and never compare revisions by element version.

Inspect the write contract with `cctl spec draft --help` and the relevant `cctl spec schema <document>` leaf. For the generated compile, lint, and evidence registries, run `cctl spec schema guidance`.

## Consistency sweep and `propose --notes` protocol

Before proposing, run `cctl spec lint`, repair its consistency findings, and sweep reference integrity, criterion coverage, stale handles, and vocabulary the revision claims to supersede. Re-run the mechanical sweep until it is clean.

For every review repair round, write a bounded notes file that maps prior findings to dispositions, names changed elements, and states deliberate non-changes. Attach it with `cctl spec propose <slug> --notes <notes.md>` so the reviewer starts from the disposition and diff rather than reconstructing intent.

Inspect the loop with `cctl spec lint --help`, `cctl spec diff --help`, and `cctl spec propose --help`. For the generated compile, lint, and evidence registries, run `cctl spec schema guidance`.

## Finding classes and bounded terminal rounds

Classify each review finding as `new_risk`, `regression`, or `consistency_drift`. Repair consistency drift and run the mechanical pass before requesting another judgment round. Review any semantic repair only over its bounded changed surface.

Call a round terminal only when every consistency finding is repaired, the mechanical pass is clean, no new-risk or regression finding remains, and the repair diff contains no semantic expansion. A semantic expansion always receives another bounded changed-surface review.

Inspect the current lint and diff surfaces with `cctl spec lint --help` and `cctl spec diff --help`. For the generated compile, lint, and evidence registries, run `cctl spec schema guidance`.

## Three capture paths

Before launch, edit a draft plan or reopen a frozen plan; capture is not a prelaunch planning verb. After launch, choose exactly one path for discovered delivery work:

1. Record non-blocking work with `cctl spec capture` and let the current run continue on its pinned scope.
2. Pass `--blocking-reason` to capture the work, abandon the current run, and open a seeded replacement plan.
3. Add intentional current-run work through `cctl workflow live amend`, with its actor, rationale, policy admission, and old/new hashes audited while the approved candidate remains immutable.

Inspect the choice with `cctl spec capture --help` and `cctl workflow live amend --help`. For the generated compile, lint, and evidence registries, run `cctl spec schema guidance`.

## Notify only from success receipts

Notify the user that an act completed only after its success receipt proves the durable transition occurred. Treat a refusal, redirect, partial-progress receipt, or transport ambiguity as unfinished work: follow the named remedy, then notify only from the eventual success receipt.

Use `cctl <command> --help` when a receipt redirects the flow, and use `cctl spec status --help` to re-read durable state. For the generated compile, lint, and evidence registries, run `cctl spec schema guidance`.
