# Delivery review and continuation

Requirements and Design establish what must be built. Delivery records whether the work was accepted and where it shipped, while accommodating changes in execution.

## Human acceptance

An append-only acceptance review contains a revision, actor, decision, optional note, and selected criterion identities with their criterion-and-requirement content fingerprints. A single transaction validates every selected criterion and the latest review token, inserts one batch, and appends its audit event. Satisfaction and evidence waiver remain distinct from automated verdicts. A waiver requires one reason; satisfaction permits a note. A later review may replace or revoke the decision. Unchanged content carries acceptance across workflow replacement; changed governing content reopens only affected criteria.

Spec Studio's Delivery view places this review ahead of planning details. The selection acts on all criteria in the reviewed revision, including collapsed rows. It shows selected count, revision, and merge scope. Automated results and human decisions remain separately visible. The server projects criterion state and readiness so the review and the merge do not disagree.

## Execution continuity

A session continuation is a spec execution pinned to an approved Design revision and scope, with no fabricated graph identity. Its durable delivery basis records session delivery, source spec executions, optional source workflows and commit references, and actor. The original execution retains its real state. When it is active, continuation first composes the existing abandonment coordinator; a failed cleanup prevents creating a second active execution. A stopped execution is never revived.

Using another workflow records a source reference and does not rewrite that workflow's approval or criterion mapping. Starting a replacement workflow uses the ordinary managed delivery-plan attempt. Session delivery remains pending until a real gated merge succeeds.

External delivery is an explicit human record for already shipped work. It creates an attributed delivered execution with an external basis and optional references. It is neither a merge observation nor automated proof. Future delivery-delta calculations recognize applicable human delivery while preserving the distinction.

## Merge boundary

A merge carries its actual workflow execution identity, when present, and a separate spec execution identity when delivering session work. Both survive job persistence and retry. One readiness evaluator checks the pinned scope, human acceptance, applicable automated outcomes, and delivery approval. Session delivery does not require an integrated final candidate from its abandoned source graph.

Initiating Merge surfaces every known delivery blocker before avoidable preparation. A machine-entry check covers direct callers and retries. Approval-and-continue returns to the pending merge through the ordinary merge API. The final publication check catches changed state; approval remains scoped to the immutable execution and revision rather than a prepared Git SHA. Successful publication alone marks session delivery Delivered. External delivery uses its explicit human record instead.

## Scope

This change does not introduce execution adoption, automatic proof mapping for unrelated workflows, manual-testing evidence, Git-history inference, additional gate-policy presets, or exploratory shipping-policy changes.
