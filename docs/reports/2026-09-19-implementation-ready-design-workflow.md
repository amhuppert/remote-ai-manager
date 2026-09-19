# Designs agents can implement: a workflow for Command Center

Ticket: command-center#80 (retrospectives) · Written 2026-09-19 · Produced by a two-agent collaboration run (workflow `71c65f07`); the negotiation audit and both initial drafts are under `memory-bank/collaboration/71c65f07-c8be-4422-a6b8-d1cba0255236/`.

Alex, the short version: keep native SDD's three phases and change what each phase must settle. The retrospectives on #80 show that the expensive runs were not caused by too little detail. They were caused by designs that asserted things the application did not have, left state spaces unenumerated, and described capabilities without the surfaces and wiring that make them real. The fix is grounding, structure, and a small number of habits, not a new lifecycle.

This is the joint result of two independent proposals that converged after negotiation. Where the two agents disagreed, the resolutions are recorded in the negotiation audit under the collaboration directory named above; the workflow below is the reconciled version.

## The workflow in one table

| Activity | Question it settles | Result | Where it lives today |
|---|---|---|---|
| Frame the intent | What problem deserves solving, and how much solution is worth it? | Problem with evidence, desired outcome, one representative situation, scope boundaries, appetite | The existing intent sections, authored first |
| Establish requirements | What observable behavior are we committing to? | Rules, acceptance examples, important negative cases, genuine constraints | Requirements stage, existing gate |
| Design the experience and the system | How will this work for the user and inside the existing application, and is it feasible here? | A nine-section narrative, decisions with consequence and reversal cost, a surface inventory, verified premises, and where warranted a contract prototype | Design stage, existing gate |
| Prepare delivery | Who builds which part, proven how? | Contract foundation where needed, contexts cut at validation boundaries, one journey owner, criteria with `covers` | Delivery plan, existing review and sign-off |
| Implement and learn | Does the product deliver the outcome? | A thin production path early, live verification, amendments when discoveries change the contract | Graph or session delivery, existing delivery gate |

These are activities inside the phases you already have. Nothing here adds an approval. The two things that are new are the intent-first ordering and the design structure, and both are conventions and templates before they are anything else.

## What the retrospectives actually say

Across the six audited executions, 76 of 130 context validations failed, and the failures concentrated in a few contexts per run. In every concentrated case the context carried an acceptance criterion that asserted something the planner had inferred rather than read: data the product does not retain (the history context that failed 18 of 19 rounds), a lifecycle the product does not implement (attention requests surviving a revision), or state the embedder does not control (an SDK settings cascade). Criterion count never predicted failure; the worst contexts had the fewest records. A second class was breadth hidden in a sentence: fourteen CLI verbs by three output surfaces, or pagination, restoration, and mobile states, discovered one cell per validation round.

Two things follow. First, these are design failures that surfaced during planning and execution. The premise rule and the review skill's feasibility lens shipped on 2026-09-05, but they run at plan review, after design approval. They should run during design, against design artifacts, so a design is not approved on an inferred premise. Second, what worked in those runs is worth keeping and moving earlier: producer and consumer closure, a foundation context that lands shared contracts before parallel work, scoped invariants, plan review before launch, committed fixtures, and a final live-verification context. Engine and implementation defects also contributed to cost and are tracked separately; they do not change the design-side conclusion.

## Requirements: how specific, how technical

Judge a requirement by two tests. Would two competent implementers deliver observably compatible behavior from it? And can a reviewer say what would falsify it? Length and technical tone are not the tests.

Technical language is fine when it names an externally imposed obligation. A CLI's stdout contract is behavior for its consumers. A consumer-visible refusal code is behavior. A protocol or operating-system constraint is a real constraint. What belongs in design is the proposed way to satisfy an obligation: the table, the framework, the domain service. A useful tie-break when unsure is whether the statement would survive a rewrite of the internals.

| Statement | Belongs in |
|---|---|
| "I need to understand why a run stopped." | Intent |
| "When I inspect a stopped run, show its recorded reason; when unavailable, say so explicitly." | Requirement |
| "The reason remains available after restarting Command Center." | Requirement, if that durability matters to you |
| "Every listed `cctl memory` verb supports `--json`." | Requirement, verified by a verb-by-output matrix in design |
| "Store the reason in this SQLite record and read it through this domain service." | Design |
| "Add the migration and repository mapping before the UI consumer." | Delivery plan |

Three rules from the planning skill apply unchanged to spec criteria: one independently failable obligation per criterion, no open quantifiers over an uninventoried surface, and no process language ("a failing test was written first" is a convention, not a criterion). A requirement should name the surfaces it touches, at the level of "visible in the Library panel and via `cctl memory index`", because that is the hook the design's surface inventory hangs on. Success measures with numbers, where numbers exist, belong in requirements; the memory spec's ten named recall queries became its final live-verification criteria almost verbatim.

A missing field does not make a requirement invalid. It means the design must create the producer and storage path as new work, or return a cheaper alternative to you. The retrospective failure was treating unavailable data as if it existed while excluding the work to produce it.

EARS is a useful optional shape for the resulting conditions. Its real contribution is the granularity rule (one trigger, one system, split compounds) and the way "While" and "If" prefixes force the state into the sentence. It does not establish completeness; a grammatically perfect requirement can still encode an invented lifecycle. Example mapping during the conversation (rules, a few revealing examples, open questions kept separate) is a good antidote to agents generating an exhaustive-looking test catalogue before the problem is understood.

## Requirements and design: what each gate protects

The blur you notice has a structural cause. In a brownfield product the "what" is often stated in terms of existing surfaces, so requirements sound like design. That is fine when the vocabulary is product vocabulary. The separation that matters is what each approval protects.

The requirements gate protects the contract you want: "if all of this is observably true, I am satisfied." Design cannot change it; design can only discover it is infeasible or unexpectedly expensive, which is what `cctl spec return-to-requirements` and the amendment path are for. The design gate protects feasibility and cost: "this approach fits the envelope, the premises are verified, and the work is bounded."

Three practical rules keep the phases honest without pretending an author can un-know the codebase. An agent should inspect current behavior, schemas, and documented capabilities while clarifying requirements, so it does not invent the existing system; it defers choosing new internals until the requirements checkpoint is settled. A discovery during design that changes the behavioral contract returns through the amendment path rather than hiding inside a "technical decision". And a bounded experiment may answer a specific feasibility question during design; its result is evidence with stated limits, and a prototype does not become approved architecture because writing it was convenient.

## Over-engineering: where the levers are

Agents over-build for predictable reasons: completeness reads as quality, defensive code is never penalized by a validator, templates prompt for sections that only make sense in a larger envelope, and nothing in the loop prices a mechanism. Anthropic's own prompting guide names the tendency for current models. Each cause has a counter.

- **Appetite before design.** Record in the intent how much investment the problem warrants: "an improvement within the existing detail page", "a new interaction worth a modest domain change", "a foundational capability worth restructuring this subsystem". Appetites start with a number and end with a design; estimates run the other way.
- **A justification sentence per new mechanism.** For every queue, cache, retry, fallback, configurable policy, abstraction, or persistent record the design introduces: "this is needed for this approved behavior or observed failure mode; the simpler existing approach fails because…". Existing requirements and evidence must supply the answer.
- **One credible simpler alternative for major decisions.** Sometimes the right alternative is an existing page, an explicit error with manual retry, or direct use of the current domain API. Do not manufacture three architectures for a small edit.
- **Consequence and reversal cost on decisions.** For consequential decisions, record the consequence, the cost to reverse, and what change would require re-review. Those plus uncertainty and coordination cost set how much scrutiny a decision gets. A reversible shared contract can still be costly if many agents depend on it; an isolated local choice is cheap. Approved decisions are not silently changed, and none is permanently unamendable.
- **A standing convention for implementers.** One short rule in the implementer role contract, beside the outcomes-only rule that shipped in September: the smallest coherent change that satisfies the approved behavior, reuse of existing owners, no abstraction or safeguard the approved behavior does not require, preserve existing code. A single instruction of this kind measurably reduced excess edits in a controlled study; it is cheap and belongs in one canonical place rather than in every charter.
- **A thin production path first.** One end-to-end slice through the real entry point before breadth. Agents' natural inclination is to build big layers in isolation, and horizontal build-out is where the breadth failures lived.
- **Strip the template.** The Kiro design template asks for error categories with circuit breakers and rate limiting as examples, monitoring, performance and scalability, migration strategy, and security considerations. Templates teach by suggesting what deserves attention. Command Center's template should ask for failure behavior, persistence and migration when a table changes, responsiveness, and external-input handling, and omit the enterprise prompts rather than asking agents to decline them each time.

Two cautions. "Avoid over-engineering" must not become a ban on abstractions that hide real complexity; judge a mechanism by present value and the complexity it hides, and treat a single-implementation interface as a finding only when it costs more than a thin interface, which is the grading your characterize-codebase skill already uses. And a reviewer prompted to find gaps will find some even when the work is sound; chasing every finding produces exactly the over-engineering this is meant to prevent, so review findings need evidence and the `review-response` discipline.

## ENVELOPE.md: wire it in

The envelope is the right first step. Make it do work in three places.

- **A ranked charter source in every delivery plan**, applying to every context, because it is small and genuinely global.
- **The design's envelope section**, where the designer names only the dimensions the change touches and explains their consequences, and writes the justification sentence for each new mechanism.
- **A review lens**, using the characterize-codebase vocabulary: cannot occur, not worth handling, unverified, kept.

Read the envelope carefully in both directions. "One operator" rules out a tenant-permission subsystem. It does not rule out stale-write conflicts: you and an agent, or two browser views, can write between two steps of one caller, and the envelope says so. A local daemon still needs restart recovery because it coordinates long-running paid work. Strict parsing of model output and external content stays in. And quality is not envelope: tests, types, readable errors, and validation at boundaries belong in every envelope, and a reviewer who waves them away as overbuilt has misread the document. Each design that settles one of the envelope's "(assumed)" markers should update the file in the same change.

## Starting earlier: intent first

Yes, start earlier, and it is cheaper than it looks because native SDD already has the pieces. The intent sections (problem, outcomes, non-goals, success measures, constraints) are a brief. The problem is that they get authored in the same revision as fifteen requirements and thirty criteria, so nobody weighs the shape alone.

The rule: record intent first, identify the consequential unknowns in scope, desired outcome, or appetite, resolve those before elaborating requirements, and reuse decisions you have already supplied rather than asking again. When you have already specified the objective and constraints, proceed. When a consequential choice is genuinely open, ask before requirements are written, because fifteen requirements against an unconfirmed appetite are the expensive way to learn the appetite was smaller. One page is a target; if the intent does not fit, the problem is probably not understood yet.

What the intent should contain, and why each item earns its place: a problem stated with evidence, because the memory spec's "14 of 16 status entries were stale" is why that spec did not drift; one representative situation rather than a persona, because with one user the situations differ (at the laptop, on the phone, through an agent) and job stories are a good optional form for that; the outcome and its success measure, because the measure becomes the final live-verification criteria; the appetite; non-goals that could reasonably have been goals; and the boundary candidates, what this owns and does not own. "Help me understand why a workflow stopped without reconstructing events from logs" is a better start than "build a workflow observability dashboard", because the second already suggests a large solution.

A separate intent authoring stage in native SDD is a later hypothesis, not part of this proposal. Try the ordering first; add a stage only if intent keeps being elaborated into rejected requirements before a consequential choice is exposed.

## Types and interfaces first: the contract prototype

Your cli-for-agents experience generalizes, with two limits made explicit. The agreed sequence:

1. Settle requirements through the existing checkpoint.
2. During design, write a bounded contract prototype when it will materially reduce uncertainty or coordinate independently implemented consumers of a changed boundary. It may compile against the real codebase and sit on the session branch under the session rules, identified as exploratory and kept out of active production behavior. It is not mandatory for a contract that is already clear with little uncertainty.
3. Review its contract shape, invariants, and a realistic consumer example together with the narrative. Scaffolding takes structural checks; behavior later adopted into production takes its ordinary tests.
4. Approve the design through the existing process. No added approval.
5. The delivery foundation context adopts, revises, or replaces the prototype, establishes the canonical consumer baseline, and implements or verifies the producers, mappings, and wiring it owns before claiming completion. Experimental remnants are removed before shipping.
6. Prove a thin working production path early, then broaden or parallelize where the settled boundaries support it.

What goes in the prototype: only the seams. Zod schemas in the owning domain's `schemas.ts`, the interfaces between future execution contexts, persisted shapes, event names and payload types, route request and response shapes, `cctl` verb signatures and refusal codes, and stubs that throw. Not internal helpers, not single-consumer types, not behavior. Follow the existing domain-owned Zod conventions rather than introducing a second type catalogue.

The two limits. Compilation catches structural mismatches: a type that references a field the record type lacks, an interface with nowhere to attach. It does not prove retention across resets, lifecycle identity across revisions, provider precedence, or reachability. Those are runtime facts, verified from authoritative code with a `file:symbol` citation and behavior evidence; a new declaration does not prove new behavior exists. And a commit SHA in the design narrative identifies what the reviewer inspected. It binds nothing. Native SDD's approval fingerprints hash spec elements, not referenced source, so delivery must verify the actual consumer baseline rather than assume the reference did.

A contract scaffold with throwing stubs is also not a walking skeleton. The scaffold aligns agents on shapes; the walking skeleton executes a thin real path and exposes missing wiring and wrong assumptions that compile fine. Both have a role, at different times.

## UI: surfaces, journeys, and dead pages

The failure has a precise shape. Designs describe capability ("Alex can review stale notes"), implementers build a component, validators check the component, and nobody owns the route from where you are to where the capability lives. The planning skill's composed-UI rule exists, but it fires at planning and only if the planner thinks of it.

Make experience design a required part of the design whenever UI changes, at breadboard fidelity: places, affordances, and the connections between them, in words rather than pixels. The compact surface inventory has these columns:

| Column | What it records |
|---|---|
| Surface | The panel, page, tab, notice, or CLI verb |
| Entry point | How you reach it today, or the work that adds the way in |
| Interaction | The principal action and the information needed to understand it |
| States | Empty, loading, populated, over-budget or truncated, error, unavailable, narrow layout, where relevant |
| Data source | The production source of each displayed fact |
| Action owner | The mutation or action each control invokes, and who owns it |
| Evidence owner | Which context proves the journey |

Every row either names an entry point that exists or names the context that adds it. "Entry point: none" is visible before anything is built.

Then distinguish three kinds of evidence. A sketch explains the proposed experience. A Storybook story demonstrates component behavior under selected inputs, one concept per story, and is the UI's equivalent of a contract prototype. A live journey through the running application demonstrates navigation, wiring, and integration. None substitutes for the others.

For each new or changed journey, at least one criterion starts at the normal application entry point, performs the meaningful action, and observes the resulting state, with one integration owner. Several requirements may share that criterion; do not generate a near-identical reachability record for every surface noun. For a CLI the analogue is help discovery, invocation through the production command path, and output and state semantics. "Component implemented" and "route exists" do not prove a journey. An `onClick` that calls the router is not a link.

Static guards (an unused-export check, a link crawl, a test that every route has a referrer) can catch useful classes of mistakes later. Their limits should be stated: an import can be guarded by an impossible condition, a linked page can itself be unreachable, and a crawler cannot find an orphan it was never told to visit. They are hygiene, worth adding once the inventory has run on a few designs, not proof of reachability.

## How a technical design should be structured

No single industry language solves this. Several fit together, and the useful standard is what a section or diagram must explain, not that every design contains one.

| Practice | Borrow | Leave |
|---|---|---|
| Google design docs | Non-goals that could reasonably have been goals; brevity; prototyping as part of design | Cross-cutting sections that are outside the envelope |
| Rust RFCs | The split between "as the user sees it" and "interactions and corner cases"; unresolved questions that must be settled before approval versus during implementation | Nothing |
| Architecture Decision Records | Native SDD decisions already are ADRs; add consequences and reversal cost | Nothing |
| C4 | Component-level structure when three or more modules interact; context and deployment views where external providers and child processes matter | Code-level diagrams |
| arc42 | Solution strategy; risks and technical debt | The other ten sections |
| Kiro and cc-sdd | Boundary commitments, file structure plan, typed contracts as code, traceability, state and sequence diagrams where a lifecycle or cross-boundary flow exists, discovery and synthesis guidance | Error, monitoring, performance, security, and migration prompts as defaults; the thousand-line ceiling |
| Shape Up | Appetite and rabbit holes into intent; breadboarding into the surface inventory | Six-week cycles |
| EARS and acceptance examples | The granularity rule; optional sentence shape | Mandatory use; it does not verify premises |
| TypeScript and Zod as contract format | Precise, checkable contracts at changed boundaries | The belief that types prove runtime wiring or durability |

The design narrative uses this structure, each section omittable in a line when its concern is unchanged, and each earned by a failure it prevents:

| Section | Question when the concern changes |
|---|---|
| 1. Proposed change and boundary | What approved behavior does this deliver, and what is outside this change? |
| 2. Existing-system fit | What current owners, interfaces, and patterns does it reuse or change? |
| 3. Envelope and complexity | Which actual operating conditions justify each consequential new mechanism, and why is a simpler existing approach insufficient? |
| 4. Experience: surfaces, journeys, states | How does the user or agent enter, act, understand the outcome, and recover? Which surfaces and states change? |
| 5. Ownership and contracts | Who produces and consumes each changed contract? Where is the canonical definition, and who owns integration? |
| 6. Data, lifecycle, compatibility | What changes in persistence, identity, transitions, migration, and the relevant behavior classes? |
| 7. Runtime behavior | What ordering, concurrency, failure, or cross-boundary interactions need explanation? |
| 8. Integration and proof | Which production paths demonstrate the behavior, and what can each test, prototype, or live check establish? |
| 9. Decisions and limits | Why this approach, what costs more to reverse, what is deliberately unhandled, and which questions remain local to implementation? |

Three rules about the content. A state-space inventory has an explicit home in sections 4, 6, or 7 by subject: CLI verbs and output modes, parser input classes, paginated histories, persisted drafts, responsive layouts, revision transitions. It enumerates the relevant classes and says whether the list is exhaustive; it is not a combinatorial catalogue. Premises are labelled beside the claim they support, verified with a source that establishes the fact or marked inferred, and section 9 lists the unresolved consequential items. Design is ready when no unsupported assumption is being treated as an established fact needed to satisfy the promised behavior; a named new producer is legitimate planned work, and a disclosed provider limitation changes the promised guarantee rather than proving provider behavior is controlled.

Diagrams are chosen for the relationship they explain. A state diagram whenever a lifecycle or identity across revisions changes, with the exceptional paths included; a sequence diagram when ordering across a boundary or a process needs explanation; a context or deployment view when external providers or child processes matter. An architecture diagram of boxes for a single-process app rarely says anything the boundary section does not, and the Kiro habit of always drawing one produced diagrams nobody read. Mermaid is the convenient rendering, not the requirement.

## Design review: a demonstration, not a document score

Apply the existing feasibility lens at design review, against the premises labelled in the design and the contract prototype when there is one, rather than first at plan review. Before design approval, the designer and reviewer should be able to:

1. Walk the principal user scenario from entry to result, including its important failure state.
2. Trace a critical datum from producer to user-visible output, identifying new work as new work.
3. Explain the consequential state transitions and the guarantees the application actually controls.
4. Show that the cross-agent contracts and integration responsibilities are settled.
5. Explain why the chosen scope fits the envelope and why a simpler alternative is insufficient.
6. Name the remaining choices and show they are local implementation choices or explicitly accepted limitations.

For substantial work, add the rehearsal: hand the design to a fresh agent and ask it to outline the implementation and list the decisions it still has to make. If it invents a page location, a persistence guarantee, or a shared interface, the design has a specific gap. If it picks a helper name, that is healthy autonomy.

Run the review in fresh context, and where possible on a different model family, because models fix identical errors presented as external input and miss them in their own output. Label each finding as evidence, inference, decision, or open question; a finding without evidence is plausible, not confirmed. Bound the review's effort, but report every known blocking class with its sibling instances together; a cap applies to non-blocking findings, not to blockers. A past-tense premortem ("the design shipped and failed; explain how") is worth one bounded pass on a large design, paired with the caution above about reviewer-driven over-engineering.

## When a spec is unnecessary

Use ordinary ticket-and-implementation work when the intended behavior is clear, the affected surface is bounded, and there is no consequential uncertainty around durability, lifecycle, shared contracts, or integration. Existing spec obligations still apply. Neither "bug fix" nor "one context" establishes low risk: a one-line correction to a critical transition can deserve more scrutiny than a large visual adjustment. Size the work by its consequences, not by the number of contexts a planner assigns.

## How to roll this out

Trial it as an authoring improvement before touching native SDD's data model. The first version uses the existing intent sections, requirements, criteria, design narrative, decisions, and human approvals, plus a tailored design template and the review procedure above in the `native-sdd-authoring` skill. Apply it to three changes of different risk: a small UI change, a change spanning UI and persistence, and an orchestration change.

Measure outcomes, not artifacts: consequential decisions invented during implementation, plan-defect repairs, missed production wiring, unwanted scope growth, human clarification burden, and total effort through acceptance. First-round validator success alone is a poor measure because it improves when checks are weakened; page count and checked boxes are poor for the opposite reason.

Concrete first steps, in order of leverage over cost:

1. The design template (nine sections, surface inventory, premise labelling) and the six-demonstration review procedure, as documentation in the authoring skill.
2. Intent-first ordering with conditional clarification, and the appetite line, as a convention.
3. The anti-over-build convention in the implementer role contract, beside the outcomes-only rule.
4. The journey criterion rule cross-referenced from the planning skill's composed-UI rule, so the two agree.
5. `ENVELOPE.md` as a ranked source in every delivery charter, and the envelope section in the template.
6. The contract-prototype sequence written into the planning skill's foundation-context guidance.
7. The trial and its measurements.

Later tooling stays a set of hypotheses the trial may reject, each with what must be shown first:

| Recurring trial signal | Candidate follow-up | What must be shown first |
|---|---|---|
| Authors omit a settled design concern and review misses it | Section-presence checks or typed section roles | The convention is stable; presence is not mistaken for quality |
| Producers defer obligations to nonexistent consumers | A structured deferral reference on criteria | Existing criterion references cannot express the check; a referential check would have prevented observed failures |
| New surfaces pass review but remain inaccessible | Targeted route and control checks or navigation metadata | A bounded production test or inventory cannot address the class more simply; the check detects it |
| Intent keeps being elaborated into rejected requirements | An explicit intent checkpoint or authoring stage | Conditional clarification has been tried; a gate is worth its cost |
| Unsupported claims survive design review | Better evidence presentation, then narrow metadata checks | The failure is missing evidence, not a missing heading |

## What the field says

The two research passes support the direction and set its limits. Every established design format pairs a why-and-constraints part with a chosen-approach part and an explicit exclusion list; they differ on how much "how" belongs. The agent-specific tools (Kiro, GitHub Spec Kit, Tessl, Claude Code's plan mode, Cursor's plan mode) converge on staged authoring with human gates; Spec Kit is the only one that puts interface contracts ahead of tasks, and none has a home for UI design. The critiques (Böckeler, Thoughtworks, Marmelab) show the same tools over-producing on small tasks: sixteen acceptance criteria for a bug, 1,300 lines to show the current date. Brooker's answer is the right one: specification-driven development is about pulling design up, not up-front, and you should not develop the entire specification in advance. That is the case for risk-sized sections and a consequence-based skip path.

On over-building, Anthropic documents the tendency and ships a scope-and-abstraction prompt; a controlled study found a single preserve-existing-code instruction cut excess edits and raised pass rate; a long-horizon benchmark found quality guidance reduced initial verbosity but not degradation over many iterations. That evidence justifies the convention and justifies measuring the trial. It does not establish that any particular lint or review mechanism prevents long-run drift, so those remain hypotheses.

On contracts as code, design by contract, type-driven development with typed holes, API-first stubs, and the walking skeleton are the classical basis; the published parallel-agent guides independently arrive at "scaffold shared contracts sequentially, then split by directory ownership, then merge in dependency order," which is your cli-for-agents experience. The one apparent conflict, Google's advice that design docs should rarely contain code, dissolves once contracts live in the tree as a compiled prototype referenced by symbol rather than pasted into prose.

Three of the ideas here have no published name: the operating envelope, the surface inventory with entry points, and one validation thesis per context. The nearest published forms are Spec Kit's constitution check with its complexity-tracking table, the entry-points line in agent briefs, and the rule to split work only where a reviewer could reject one part without the other. They are Command Center's to define.

## Limitations

The retrospective figures come from the reports' own ledger analysis and were not re-audited here; they establish a failure pattern, not a controlled comparison of design methods. The cli-for-agents types-first session left no written record I could find, so that experience is represented by your description and the independently published guidance. The sizing and skip-path criteria are conventions to be calibrated by the trial, not measured thresholds. And the research on agent over-building demonstrates limits of particular prompts; it does not prove the effectiveness or the cost of the follow-up mechanisms listed above, which is why they are hypotheses.
