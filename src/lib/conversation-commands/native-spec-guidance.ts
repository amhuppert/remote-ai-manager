/**
 * The single source for native spec authoring guidance.
 *
 * Two surfaces render from it: the runtime `/spec` expansion delivered to the
 * agent on every CC turn, and `.claude/commands/spec.md`. The runtime block is
 * the only one an agent working outside this repository ever sees, so a fact
 * that an agent cannot recover from `cctl spec <verb> --help` must be marked
 * `shared`. `repository-only` is the declared escape hatch: an omission from
 * the delivered block has to be stated here rather than discovered by reading
 * both documents.
 */

export type SpecGuidanceAudience = "shared" | "repository-only";

export interface SpecGuidanceSection {
  readonly id: string;
  readonly heading: string;
  readonly audience: SpecGuidanceAudience;
  /** Literal markdown lines; an empty entry separates paragraphs. */
  readonly lines: readonly string[];
}

export const SPEC_GUIDANCE_SECTIONS: readonly SpecGuidanceSection[] = [
  {
    id: "authoring-surface",
    heading: "Authoring surface",
    audience: "shared",
    lines: [
      "Conversations author; Spec Studio reviews, approves, and browses.",
      "Do not write or update `.kiro/specs/`, and do not treat a conversation",
      "document as the authoritative spec object.",
      "",
      "Read `cctl spec --help` and the relevant leaf help before composing",
      "payloads: every verb documents its own flags, refusals, and next step.",
    ],
  },
  {
    id: "discovery",
    heading: "Find an existing spec before creating one",
    audience: "shared",
    lines: [
      "`cctl spec list` returns this project's durable inventory with each",
      "spec's phase and approval summary. `cctl spec search --all <query>`",
      "matches requirement and decision text across every spec in the project",
      "and reports each hit's slug, phase and preset. Use either before creating",
      "anything so you do not open a competing object for work that already has",
      "a spec; search answers it directly when you have wording to match on.",
      "",
      "`cctl spec search <slug> <query>` is the single-spec form: with a slug",
      "positional it matches requirement and decision text within that one spec",
      "only.",
    ],
  },
  {
    id: "durable-first-save",
    heading: "Durable first save",
    audience: "shared",
    lines: [
      "Choose a stable kebab-case slug, a clear name, and an intentional gate",
      "preset; prefer `contract-bearing` when the user has not chosen one.",
      "",
      "No durable spec exists until the first successful draft save. When the",
      "first element is ready, run `cctl spec create --slug <slug> --name <name>",
      "--preset <preset> --file <first-element.json>` — one atomic call that",
      "creates the spec, its draft revision, and the first element together,",
      "visible immediately through `cctl spec list` and Spec Studio. Do not",
      "create the spec before the first element is ready.",
      "",
      "Partial drafts are valid. Continue with element-granular `cctl spec draft`",
      "writes whose file states the last observed `baseElementVersion`; a stale",
      "single-element write returns the winning content and version, and a batch",
      "returns the winning version alone. Element versions are per",
      "revision and restart at 1, so re-read an element after `cctl spec amend`.",
      "If create refuses with `slug_taken`,",
      "follow the returned instruction: continue the existing draft or choose a",
      "different slug.",
      "",
      "Authoring is symmetric: `cctl spec remove <slug> <handle...>` takes",
      "elements back out of the open draft, and a `--file` document of the form",
      '`{"elements": [...], "removals": [{"elementId", "baseElementVersion"}]}`',
      "does both in one transaction — which is required when a reference and the",
      "element it points at have to leave together. Removal is not deletion: the",
      'element id stays the spec\'s, so re-saving it with `"reintroduceHistorical":',
      "true` and a null base version brings it back with its original number and",
      "handle.",
    ],
  },
  {
    id: "staged-authoring",
    heading: "Staged authoring",
    audience: "shared",
    lines: [
      "`cctl spec status` reports the draft's authoring stage, and that stage is",
      "the server-enforced write boundary: requirements admits intent and context",
      "prose, requirements, and acceptance criteria; design adds decisions and",
      "design narrative. Design is the final evergreen stage. Tasks belong to a",
      "delivery plan attempt, authored with `cctl spec plan open <slug>` and",
      "`cctl spec plan edit <slug> --file <plan.json>`. A `stage_blocked` refusal",
      "names the correct authoring surface — follow it instead of authoring ahead.",
      "",
      "What would refuse a propose is readable before you attempt one:",
      "`cctl spec lint <slug>` prints every deterministic finding grouped by",
      "severity, with the subset that would block propose flagged, and `cctl spec",
      "status` carries a counts-and-top-findings tier over the same panel. Read",
      "one of them and fix what blocks rather than proposing to discover it.",
      "",
      "Conclude a stage with `cctl spec propose <slug>`, which freezes the",
      "editable revision for review of that stage. When the stage's concluding",
      "dial is Notify or Off, cross the boundary explicitly with `cctl spec",
      "advance <slug> --from requirements`; the expected stage keeps a stale",
      "command from advancing a replacement revision. When the dial is Gate,",
      "only human sign-off advances the draft. A pure combined-approval policy",
      "opens directly at design and preserves single-pass evergreen authoring.",
      "",
      "After design sign-off, read `cctl spec plan open --help` before authoring",
      "the delivery graph reviewers will approve and execution will materialize.",
    ],
  },
  {
    id: "amendments",
    heading: "Continuing an approved spec",
    audience: "shared",
    lines: [
      "An approved gate ends that revision, not the spec. When the gate is",
      "approved and no draft is open, continue the spec by opening an amendment:",
      "`cctl spec amend <slug>` opens the next draft from the approved revision,",
      "and authoring resumes through `cctl spec draft`.",
      "",
      "An amendment opens at design. An approved legacy Plan revision remains",
      "readable as history, but its tasks are not copied into an authorable",
      "evergreen Plan stage; delivery changes use a new delivery plan attempt.",
    ],
  },
  {
    id: "execution-start",
    heading: "Execution start launches the approved candidate",
    audience: "shared",
    lines: [
      "Execution requires an approved DeliveryPlanAttempt. Propose materializes",
      "one immutable compiled candidate, and human plan sign-off approves that",
      "candidate's `compiledDefinitionHash` rather than a recipe for rebuilding it.",
      "",
      "`cctl spec start <slug>` launches the stored approved candidate and creates",
      "the graph-workflow execution in that same act. Start does not recompile,",
      "infer edges, regroup tasks, or union criteria: the launched definition hash",
      "must equal the approved `compiledDefinitionHash`.",
      "",
      "The old scope-file input is retired. To import a legacy approved Plan into",
      "the active path, run `cctl spec plan open <slug> --seed-from last`, review",
      "and propose the resulting attempt, then hand its sign-off to the human.",
      "Use `cctl spec start <slug> --park` only for explicit prelaunch review; it",
      "creates no execution and takes no session slot.",
    ],
  },
  {
    id: "human-only-acts",
    heading: "Human-only acts",
    audience: "shared",
    lines: [
      "Approvals, sign-off, waivers, assumption disposition, rename, and gate",
      "policy changes are human-only Spec Studio acts. No `cctl spec` verb",
      "changes gate policy, and an agent transport that reaches a human-only",
      "action receives a typed `human_act_required` refusal telling it to",
      "perform the action from the authenticated browser session.",
      "",
      "Never approve, sign off, dispose assumptions, or change gate policy on",
      "the user's behalf. Ask the operator to act in Spec Studio and continue",
      "with whatever remains authorable.",
      "",
      "Proof verdicts are recorded only by the delivery gate from machine",
      "evidence (test runs, validator verdicts, commits). No one records them",
      "by hand. When a criterion cannot be machine-proven, the human remedy is",
      "a waiver: Spec Studio → Controls → Merge gate → Waive…",
    ],
  },
  {
    id: "elicitation",
    heading: "Elicitation",
    audience: "shared",
    lines: [
      "Use `cctl ask` only when missing product intent would materially change",
      "the spec. Question batches stay small, skippable, visible in the",
      "conversation, and prunable as they resolve. The server never blocks on",
      "elicitation: if a batch is skipped or no answer arrives, proceed with the",
      "safest reasonable judgment.",
      "",
      "Open questions that belong to the spec itself are recorded durably with",
      "`cctl spec question` — they become addressable (Q1, Q2, …) and reviewable",
      "in Spec Studio, where the human answers them (`cctl spec answer` is the",
      "human half; agent transports receive a typed refusal). Record meaningful",
      "assumptions through `cctl spec assume` when proceeding without an answer.",
    ],
  },
  {
    id: "ask-payloads",
    heading: "Ask payloads",
    audience: "repository-only",
    lines: [
      "Put each related question batch in a JSON payload under `.cc/temp/`, then",
      "submit it with `cctl ask --file <payload>`. When `cctl ask` accepts a",
      "batch, end the turn as required by the ask protocol and continue authoring",
      "after the answers arrive. Author spec element payload files under",
      "`.cc/temp/` as well.",
    ],
  },
  {
    id: "delivery-plan-graph",
    heading: "Delivery plan execution graph",
    audience: "shared",
    lines: [
      "Apply the graph-workflow-planning discipline before editing an attempt:",
      "",
      "- Give every context a stable `contextId`, explicit criterion ownership,",
      "  an authored `acceptanceContract`, and a criterion-level `proofPlan`.",
      "- Put each task in one context with `contextId` and a contiguous `order`.",
      "  Size it for one agent lane; materialization copies it and never regroups it.",
      "- State cross-context dependencies as edges with stable `edgeId`,",
      "  `fromContextId` and `toContextId`. Contexts without a dependency path",
      "  are an explicit claim that they may execute in parallel.",
      "- Declare production `wiring` ownership and normalized repo-relative POSIX",
      "  `touchedSurfaces`, and give every pinned criterion exactly one disposition.",
      "- Review `cctl spec plan preview <slug> --stage draft` before proposing.",
      "  After proposal, `--stage proposed` reads the exact frozen candidate a",
      "  human sign-off approves. Fix blocking draft health from `cctl spec plan",
      "  get <slug>` before `cctl spec plan propose`.",
    ],
  },
];

export const SPEC_GUIDANCE_BEGIN_MARKER = "<!-- BEGIN SHARED SPEC GUIDANCE -->";
export const SPEC_GUIDANCE_END_MARKER = "<!-- END SHARED SPEC GUIDANCE -->";

function renderSections(sections: readonly SpecGuidanceSection[]): string {
  return sections
    .map((section) =>
      [`## ${section.heading}`, "", ...section.lines].join("\n"),
    )
    .join("\n\n");
}

/**
 * The block delivered to the agent in place of a literal `/spec`. It carries
 * every `shared` section, because the SDK never sees `.claude/commands/spec.md`
 * on a CC-driven turn and no such file exists in other repositories.
 */
export function renderRuntimeSpecInstructions(): string {
  const shared = SPEC_GUIDANCE_SECTIONS.filter(
    (section) => section.audience === "shared",
  );
  const intro =
    "Author a native Command Center spec for the request below in this conversation.";
  return `<native-spec-authoring>\n${intro}\n\n${renderSections(shared)}\n</native-spec-authoring>`;
}

/** The generated body of `.claude/commands/spec.md`, between its markers. */
export function renderSpecCommandGuidance(): string {
  return renderSections(SPEC_GUIDANCE_SECTIONS);
}

/** The committed generated body, or null when the markers are missing. */
export function extractSpecCommandGuidance(source: string): string | null {
  const start = source.indexOf(SPEC_GUIDANCE_BEGIN_MARKER);
  const end = source.indexOf(SPEC_GUIDANCE_END_MARKER);
  if (start === -1 || end === -1 || end < start) return null;
  return source.slice(start + SPEC_GUIDANCE_BEGIN_MARKER.length, end).trim();
}

/** Replace the marked block, leaving the frontmatter and intro untouched. */
export function spliceSpecCommandGuidance(
  source: string,
  block: string,
): string {
  const start = source.indexOf(SPEC_GUIDANCE_BEGIN_MARKER);
  const end = source.indexOf(SPEC_GUIDANCE_END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `spec command document is missing the ${SPEC_GUIDANCE_BEGIN_MARKER} / ${SPEC_GUIDANCE_END_MARKER} marker pair`,
    );
  }
  const head = source.slice(0, start + SPEC_GUIDANCE_BEGIN_MARKER.length);
  return `${head}\n\n${block}\n\n${source.slice(end)}`;
}
