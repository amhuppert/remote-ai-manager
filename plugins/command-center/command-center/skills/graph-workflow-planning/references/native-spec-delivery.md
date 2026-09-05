# Delivering a native spec

Planning the delivery of a native spec is ordinary graph planning against a
managed draft: `cctl spec plan open <slug>` creates the definition, you author
an ordinary `plan.json` for it, and every receipt names the act that follows it.
Only the five things below are specific to a spec delivery, and none of them is
something a receipt can tell you at the moment you need it.

## The pinned revision

An attempt pins one approved spec revision, and that pin — not the spec's
current tip — is what the plan disposes of and what every validator later reads.
Plan against the pinned revision: quoting newer wording into a plan bound to
older wording gives validators two contracts and no way to choose between them.
The pin is immutable for the life of the attempt, and reopening redrafts against
that same pin — so when the spec has amended past it, retire the attempt with
`cctl spec plan abandon` and open a fresh one with `cctl spec plan open`, which
pins the current approved revision.

## How spec criteria reach contexts

The link is authored, not derived. The plan's `binding` gives every pinned
criterion a disposition, and its claims name the stable authored contexts
accountable for the selected ones; a criterion reaches a context because a claim
says so. Nothing infers accountability from topology, lineage, or runtime
expansion. Claims in the `binding` are the accountability mechanism.

Shape the graph knowing a claim has to be reachable: the
`binding/selected-criterion-not-must-run` finding names a claimed criterion the
run can skip, and it carries both its reason and the act that clears it.

## Restate; never paste

Spec criteria are the contract. A context's `acceptanceCriteria` are the
validator's checklist for one context's finished candidate. They have different
readers and different jobs, so never paste spec criterion text into a context
criterion. Restate the obligation that context actually owes, in terms an
inspector can confirm on the tree in front of them. A pasted contract sentence
usually names an outcome no single context can show, and a validator cannot
tell that apart from work that genuinely missed.

## Author in phases

A plan whose contexts carry criteria, placement and edges but an empty `tasks`
list validates clean. Use that: settle the shape first and run
`cctl workflow validate --file .cc/temp/plan.json --definition <definitionId>`
on it, so refusals about decomposition, placement, criteria and coverage arrive
before you have written a task instruction for every context. Fill the tasks in
once the shape survives the preflight.

## Edge ids, and removing an edge

Every edge carries an author-supplied `id`, and a managed draft stores the ids
you authored unchanged, so the id you wrote is the id you address later.
`remove-edge` takes that `edgeId`; when you do not have it — a definition you
did not author, or an id you never recorded — an endpoint pair
(`sourceContextId` plus `targetContextId`) that matches exactly one edge is the
fallback the same op accepts.
