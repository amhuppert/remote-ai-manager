# Structured Data Responses

Command Center often asks agents to return machine-readable output that drives
workflow state. These responses are load-bearing: if the model emits malformed
JSON, oversized fields, or prose in the wrong place, the workflow can fail even
when the agent did the underlying analysis correctly.

This document describes the design principles for structured data responses in
agent workflows.

## Core Principles

1. **Separate thinking from formatting.** Do not ask an agent to do research,
   compare tradeoffs, reason through a problem, and satisfy a strict structured
   schema in the same response when the result matters. Use one turn for
   research/analysis with no output-format pressure, then a follow-up turn that
   asks the agent to convert its prior answer into the required structured
   output.
2. **Do not make models think in JSON.** JSON is a transport format, not a good
   reasoning medium. Let the model reason in natural language and use structured
   output only as the final handoff format.
3. **Keep schemas simple.** Prefer flat objects, short arrays, scalar fields,
   enums, and stable identifiers. Avoid deeply nested shapes, unions inside
   unions, large maps, recursive structures, and fields that require the model
   to preserve complicated relationships across a large response.
4. **Bound every inline text field.** Every string in the structured output
   should have a clear, narrow purpose (a summary, identifier, status, path, or
   short rationale) and a length the model is told to respect in the field
   description and prompt. Keep real bounds in the authoritative Zod or JSON
   Schema and enforce them after parsing. Backend adapters transport the complete
   schema; callers do not maintain provider-specific copies.
5. **Always offload substantive content to files.** The structured response
   should be a small manifest that references files the agent created. The main
   answer, analysis, audit, citations, and long supporting material should live
   in generated artifacts.
6. **Make file use unconditional.** Do not tell the agent to use files only when
   content is long. Conditional rules make the agent decide between two output
   strategies. Always require files, even for modest responses, so the model has
   one path to follow.
7. **Validate both the manifest and the files.** Schema validation proves the
   manifest shape is correct. File validation proves the referenced artifacts
   exist, stay inside the expected workspace directory, are non-empty, and are
   within size limits.

## Recommended Flow

Use a two-turn protocol for important structured responses:

1. **Analysis turn**
   - Give the agent the task and role instructions.
   - Allow normal prose, notes, drafts, and reasoning output.
   - Encourage the agent to create any required files during this turn when the
     workflow supports file writes.
   - Do not enforce the final JSON schema in this turn.

2. **Formatting turn**
   - Tell the agent to use its prior answer and generated files.
   - Require the agent to create or update the standard artifact files before
     responding.
   - Require the final response to be only the structured manifest.
   - Explicitly forbid embedding file contents, markdown bodies, or long prose
     in the manifest.

This reduces failure pressure because the second turn has one job: produce the
correct manifest.

## Schema Design Rules

Use schemas that are easy for a model to satisfy and easy for code to validate.

Recommended:

- `snake_case` field names.
- Shared field names across related agents or phases.
- `summary` and `artifacts` as common manifest fields when they apply.
- Short bounded IDs such as `answer`, `audit`, `main`, `D-1`, or `PC-1`.
- Arrays with small maximum lengths.
- Enums for workflow decisions and categories.
- Artifact references with `id`, `artifact_type`, `path`, and a short `summary`.

Avoid:

- **Asking the model to echo bookkeeping the orchestrator already owns.** Fields
  the orchestrator determines from the phase it is running — the collaboration
  envelope's `kind`/`agent`/`target_agent`/`round` and each artifact reference's
  `round`/`agent`/`phase` — are kept out of the model-facing schema and injected
  after parsing (see [Orchestrator-Owned Fields](#orchestrator-owned-fields)).
  The model authors only judgment and content.
- Inline final answers, reports, audits, or research bodies.
- Free-form object maps keyed by model-generated strings.
- Large nullable surfaces where many combinations are technically valid.
- Redundant agent-specific field names such as
  `accepted_from_agent_two_draft` when a generic
  `accepted_from_other_agent_draft` works.
- Optional fields that change the intended output strategy.
- Direct provider-SDK calls that bypass the backend adapter's structured-output
  transport — see
  [Backend Enforcement Compatibility](#backend-enforcement-compatibility).

## Backend Enforcement Compatibility

Callers hand their authoritative schema to the neutral conversation/task
request. The schema may be generated from Zod or authored independently; it is
not the caller's job to produce a provider-specific copy.

Each backend descriptor declares where structured-output enforcement happens:

- Claude declares `structuredOutput: "post_validation"`. Its adapters render the
  complete JSON Schema into a deterministic final-message instruction appended
  to the prompt. Nothing reaches the Claude SDK's native `outputFormat` wire;
  the response text is extracted and validated by Command Center after the turn.
- Codex declares `structuredOutput: "backend_native"`. Its adapter sends the
  complete schema through Codex's native final-response enforcement. Command
  Center still runs the same extraction and validation gate afterward, so native
  enforcement is an accelerator rather than a correctness dependency.

The rendered Claude contract retains every JSON Schema keyword, including string
length, pattern, numeric-range, and array-length constraints. Prompting with a
schema is not constrained decoding: descriptions and explicit instructions help
the model satisfy those constraints, while the shared gate and owning Zod schema
remain responsible for authoritative acceptance.

Rules:

- Send application schemas through the neutral backend request. Do not call a
  provider SDK directly for application structured output.
- Do not strip keywords in caller/shared code or hand-maintain provider-specific
  schemas. Doing so duplicates transport knowledge and weakens validation.
- Express bounds in field descriptions and prompts as advisory generation
  signals, while retaining them in the authoritative schema for post-parse
  enforcement.
- Re-check every manifest with the owning Zod `safeParse`, so a too-long or
  malformed field becomes a named validation error.
- Keep provider transport choices inside adapters and select neutral behavior
  from descriptor capabilities rather than backend identity.

## Orchestrator-Owned Fields

Some fields in a manifest are not judgments the model makes — they are facts the
orchestrator already knows from the phase it is running. In collaboration mode
these are the envelope's `kind` (the phase), `agent`, `target_agent`, and
`round`, plus each artifact reference's `round`, `agent`, and `phase`. Asking the
model to emit them is pure downside: it cannot get them more right than the
orchestrator, and a self-consistency slip (an artifact tagged with the wrong
round, or an envelope echoing a stale phase) fails the run on bookkeeping rather
than substance — the failure mode that produced the opaque `$: Invalid input`.

Per the agent-offloading principle, keep these fields **out of the model-facing
schema entirely** and inject them after parsing:

- The JSON Schema contract and a `*ContentSchema` describe only the
  model-authored content. The content schema uses strip (non-`strict`) mode, so
  if a backend echoes an owned field anyway it is dropped, then overwritten —
  resilient rather than a hard failure.
- `parseAndInjectArtifact`
  (`src/lib/workflows/collaboration/helpers.ts`) parses the content, injects the
  orchestrator's values to rebuild the full artifact, and re-validates against
  the persisted schema. A content failure (`schema_validation`) is the model's
  fault and carries a named path; an injection failure (`injection_invariant`)
  is the orchestrator's. Neither collapses into an unattributed root error.
- The required-artifact check that remains in the content schema emits a named,
  path-attributed issue (`artifacts: must include a generated artifact with id
  "main"…`) instead of a bare refinement.

## Artifact File Rules

Generated files should use a predictable directory layout owned by the workflow.
For collaboration artifacts, the standard layout is:

```text
memory-bank/collaboration/<workflowId>/round-<round>/<agent>/<phase>/
```

The manifest should reference files under that directory using relative POSIX
paths. The workflow should reject references that:

- are absolute paths
- contain backslashes
- contain traversal segments
- point outside the expected workflow/round/agent/phase directory
- do not end in the expected extension
- are missing, empty, or too large

The main user-visible response should come from a generated file, not from a
large JSON field.

## Prompting Rules

The formatting prompt should be direct and repetitive about the contract:

- Create the required artifact files first.
- Put the complete answer or analysis in those files.
- Return only the JSON manifest.
- Keep every manifest text field short and bounded.
- Do not include markdown file contents in JSON.
- Ensure every artifact reference uses the exact required path pattern.

Still include these instructions when a backend receives a schema. Shape
validation does not guarantee the model chose the right division of content
between files and manifest.

## Failure Model

The goal is to make malformed output rare by reducing the difficulty of the final
response, then recover once from a correctable transport mistake with precise
validation feedback.

The common failure modes this design contains are:

- The model produces excellent analysis but invalid JSON.
- The model produces parseable JSON with missing, mistyped, or extraneous fields.
- The model fills a bounded field with a full essay.
- The model hits token pressure while trying to fit the whole answer in JSON.
- The model uses inconsistent field names across agents.
- The model omits a required file because file use was conditional.
- The workflow accepts a manifest that points at missing or unsafe paths.

The shared extractor tries backend-native output, raw response JSON, then the
last fenced JSON block. Every candidate passes through the same post-turn gate,
so an invalid higher-priority candidate does not mask a valid correction later
in the response.

### Repair turn

When every first-pass candidate fails the AgentCall gate, Command Center makes
one bounded repair turn by default. The repair prompt contains the complete
schema, a bounded tail of the rejected output, and named validation issues; it
does not repeat the full work context. A task run repairs through a fresh
isolated one-shot, while a conversation turn uses one corrective turn on its
resolved runtime. Callers can explicitly set the repair budget to zero.

The repaired response is extracted and gated exactly once more. A second failure
returns the normal schema-validation outcome with candidate diagnostics while
preserving the original transcript, content blocks, and artifact references.

Keep the contract boring: prose in files, small manifests in JSON, strict
validation at the boundary.
