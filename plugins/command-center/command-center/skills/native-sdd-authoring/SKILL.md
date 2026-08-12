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

## Placement: shared lanes and disjoint ownership

Every context you leave placement-free takes its own solo lane — one worktree, one join, one merge. When a group of contexts is already edge-ordered into a chain, put the whole chain on one lane: it then costs one worktree and one join instead of N and N, and its members may write the same paths freely, because ordering is what makes sharing safe.

Members of one lane that no edge orders must be `mode: "owned"` with disjoint `ownedPaths`; a `full` member unordered against a write-capable lane-mate is refused outright. Ownership is compared as segment-boundary prefix cover at directory grain — `src/lib` covers everything beneath it but not the sibling `src/libraries`, and there are no globs — so two contexts that can run at the same time must not claim prefixes that cover each other. When several members need one shared surface, home it upstream in a context they all depend on rather than splitting that file's ownership by intent.

`readOnly` is not yet authorable at the plan tier. A read-only context delivers only through a structured output contract, and the delivery-plan document cannot author one, so lint refuses the grade at propose and names the gap instead of letting a launch discover it. That puts the reserved `session` lane out of reach here too — it admits read-only contexts only — so every lane a plan names is a lane it pays a worktree for. When the shape is unclear, omit `placement` entirely: the materializer gives that context a solo lane with full access, which is the pre-placement behavior byte for byte and never refuses.

The rest of the model — the three grades, the ownership envelope an implementer runs under, and the accept-time refusal codes — is the graph-workflow-planning skill's "Lane Placement and File Ownership" section; read it before authoring a lane several contexts share. Inspect the authored field with `cctl spec plan edit --help` and `cctl spec schema delivery-plan`. For the generated compile, lint, and evidence registries, run `cctl spec schema guidance`.

## Ranked sources of truth a lane can read

Keep the plan's own spec ranked first exactly as `cctl spec plan open` seeded it: locator `.cc/graph-workflow-docs/spec/<slug>.md`, `accessPolicy: "worktree-relative"`. Launch materializes the pinned revision into that path in every lane worktree, so implementers and validators can open the contract they are judged against. Never re-point that entry at a `cctl spec` invocation; a command is not a locator, and nothing in a lane can read it as a path.

Reserve `external-readonly` for sources that genuinely live outside the worktree — another repository, a URL, an issue attachment. The charter gates those behind explicit human permission, so spelling your own spec that way leaves rank 1 unreadable and every validator judging from memory. Author the rest of `governance.sourcesOfTruth` freely; a source a prior attempt carried forward comes back beneath the seeded entry with its rank shifted, and `plan/spec-source-unreadable` blocks propose until an unreadable duplicate of this spec is retired.

Inspect the seeded entry with `cctl spec plan open --help` and the document with `cctl spec schema plan-edit`. For the generated compile, lint, and evidence registries, run `cctl spec schema guidance`.

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

## Importing a spec authored outside CC

Bring a spec authored outside CC in whole with `cctl spec import --file <bundle.json>`. The imported spec is born approved at design on import provenance: it records that an agent imported the content and from which source, and no approval of any kind is written, so every human gate on it stays as strong as on a spec authored here.

Run the act in one order. Check `cctl spec list` and `cctl spec search --all <query>` and stop if an existing spec already covers the work. Author the bundle from the source documents yourself: you are the parser, and the server never reads a source file. Iterate with `--dry-run` until it reports no blocking finding and prints the handles it would allocate, so bundle-local refs resolve against the real numbering. Then import once and read the receipt. Treat a refusal as unfinished work — nothing was written, so follow the named remedy and import again.

Import creates new specs only; change an existing spec with `cctl spec amend` instead. Import is never an approval shortcut for work authored here — content drafted in conversation earns its approval through `cctl spec propose` and human sign-off. Import is also not the legacy delivery-plan seed: `cctl spec plan open <slug> --seed-from last` seeds delivery on a spec that already exists here, while import is for content that has never been in CC at all.

Author the bundle so a delivered import owes a human no review pass. `delivered` defaults to true and records external-delivery provenance rather than machine proof, which the delivery gate never reads; opt out with `"delivered": false` when the source carries no acceptance criterion to record delivery against. Import a question already answered when the source holds the answer, and import an assumption with its real disposition — confirmed included — when the source shows it held. Carrying a source's disposition across is provenance capture, not the human disposition act: disposing an assumption here stays a Spec Studio act, so never invent a disposition the source does not show. An import authored this way arrives with zero open review items.

Inspect the act with `cctl spec import --help` and its document with `cctl spec schema import-bundle`. For the generated compile, lint, and evidence registries, run `cctl spec schema guidance`.

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
