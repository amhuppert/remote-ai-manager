import type { AdviceItem } from "./advice";
import type {
  Candidate,
  ContextFacts,
  Finding,
  ReviewerAssignment,
  ReviewRound,
} from "./schemas";

/**
 * Decides what each seat is told for each obligation. Obligation-specific facts
 * go inline; frozen documents go by reference. Packets come from their owners,
 * so this module never interprets verdicts or advisory syntax itself.
 */

export const TASK_COMMANDS_HELP = [
  "Report task progress with `cctl context task complete <task-id>`.",
  "Reopen a task with `cctl context task reopen <task-id>`.",
].join("\n");

const ADD_TASK_HELP =
  "If the work needs a task the list lacks, add it with `cctl context task add <task-id> --title <title>`.";

const QUESTION_HELP =
  "If you cannot proceed without a decision, ask with `cctl ask`; your owner answers, and your work resumes with the answer.";

const PUBLISH_HELP =
  "To share a document with work that starts later, publish it with `cctl context doc publish <file>` (a new document needs `--description`); work already running keeps the revision it started with.";

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

function criteriaBlock(facts: ContextFacts): string {
  const criteria = facts.contract.current.acceptanceCriteria;
  if (criteria.length === 0) return "No separate acceptance criteria.";
  return criteria.map((c) => `- [${c.id}] ${c.text}`).join("\n");
}

function documentsBlock(facts: ContextFacts): string | null {
  const documents = facts.contract.current.documents;
  if (documents.length === 0) return null;
  return [
    "Frozen for this work: read-only copies at these paths in your working directory.",
    ...documents.map(
      (d) =>
        `- \`${d.path}\` — ${d.description}${d.readWhen ? ` Read when: ${d.readWhen}` : ""}`,
    ),
  ].join("\n");
}

const clip = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

/** Out-of-mission work is declined in the turn's closing message, where the owner and reviewers read it. */
function declineRule(facts: ContextFacts, what: "gap" | "finding"): string {
  return `A ${what} that arises only under a non-goal or outside the mission is not yours to build: decline it in the message that ends your turn, citing the charter entry${facts.contract.current.ownerQuestions ? ", and ask if you cannot tell" : ""}.`;
}

/**
 * The run's charter as it governs this context: the mission, the invariants
 * and sources meant for it and the non-goals, with where to read the rest,
 * and what the seat's role owes them.
 */
function charterSection(
  facts: ContextFacts,
  role: "implementer" | ReviewerAssignment["authority"],
): string | null {
  const contract = facts.contract.current;
  const charter = contract.charter;
  if (charter === null) return null;
  const lines = [`Mission: ${charter.mission}`];
  if (charter.invariants.length > 0)
    lines.push(
      "",
      "Invariants (every change must keep each one):",
      ...charter.invariants.map((invariant) => `- \`${invariant.id}\`: ${invariant.statement}`),
    );
  if (charter.sourcesOfTruth.length > 0)
    lines.push(
      "",
      "Sources of truth, highest authority first (the higher one governs a conflict):",
      ...charter.sourcesOfTruth.map(
        (source) => `${source.rank}. ${source.label} (\`${source.locator}\`): ${clip(source.description, 200)}`,
      ),
    );
  if (charter.nonGoals.length > 0) lines.push("", "Non-goals:", ...charter.nonGoals.map((goal) => `- ${goal}`));
  lines.push("", `The full charter, with its conventions, vocabulary and test strategy: \`${charter.documentPath}\`.`);
  lines.push("");
  if (role === "implementer") {
    lines.push(
      "When sources disagree, follow the higher-ranked one; when you settle a conflict or an ambiguity, cite the governing source in the message that ends your turn.",
      ...(charter.invariants.length > 0
        ? [
            "Check every invariant against your new and changed code with a concrete check (for example, a search for a banned pattern), especially before you complete the last task; existing code you copy can itself break one.",
          ]
        : []),
      declineRule(facts, "gap"),
    );
  } else {
    lines.push(
      "A finding that arises only under a non-goal or outside the mission is advice, never a blocking finding.",
      ...(charter.invariants.length > 0
        ? [
            "Check each invariant; for a violation, cite the invariant's id in your finding. Judge what the work is and does: an invariant about how the work was produced is kept when the outcome it protects holds.",
          ]
        : []),
      ...(role === "blocking" && charter.sourcesOfTruth.length > 0
        ? [
            "When an acceptance criterion contradicts a higher-ranked source and the work follows the source, return `plan_defect`, not `fail`.",
          ]
        : []),
    );
  }
  return section("Charter", lines.join("\n"));
}

/**
 * For every order after the first: the seat may be a replacement that never
 * saw the first order, so name the frozen charter and documents again.
 */
function referencesSection(facts: ContextFacts): string | null {
  const charter = facts.contract.current.charter;
  const documents = documentsBlock(facts);
  if (documents === null) return null;
  return section(
    "Charter and documents",
    [charter !== null ? "The charter still governs this work." : null, documents]
      .filter((line): line is string => line !== null)
      .join("\n"),
  );
}

/** Earlier accepted results this work builds on, each exactly as accepted. */
function inputsSection(facts: ContextFacts): string | null {
  const inputs = facts.contract.current.inputs;
  if (inputs.length === 0) return null;
  return section(
    "Results this work builds on",
    [
      // Whether its changes are in this workspace depends on where it ran and published; only the result is certain.
      "Earlier work was accepted with these results.",
      ...inputs.map(
        (input) =>
          `### ${input.title} (${input.key})\n\n\`\`\`json\n${JSON.stringify(input.output, null, 2)}\n\`\`\``,
      ),
    ].join("\n\n"),
  );
}

/**
 * What a reviewer needs to judge this work alone when other work shares its
 * workspace: the paths it may change, and the whole-tree checks that run later
 * on the assembled tree rather than on this work.
 */
function sharedWorkspaceSection(facts: ContextFacts): string | null {
  const scope = facts.binding.request.scope;
  const deferred = facts.contract.current.deferredChecks;
  const lines = [
    scope.mode === "owned"
      ? `This work may change only ${scope.paths.map((p) => `\`${p}\``).join(", ")}. Other changes in your working directory belong to work running alongside it; judge only this work's changes.`
      : null,
    deferred.length > 0
      ? `${deferred.map((c) => `\`${c}\``).join(", ")} ${deferred.length === 1 ? "is" : "are"} not run for this work: whole-workspace checks run later on the assembled tree. Do not fail this work for what they would report outside its changes.`
      : null,
  ].filter((line): line is string => line !== null);
  return lines.length === 0 ? null : section("Shared workspace", lines.join("\n"));
}

function tasksBlock(facts: ContextFacts, onlyOpen: boolean): string {
  const tasks = facts.ledger.tasks.filter(
    (t) => !onlyOpen || t.status === "open",
  );
  if (tasks.length === 0) return "No tasks remain.";
  return tasks
    .map(
      (t) =>
        `- [${t.status === "done" ? "x" : " "}] ${t.id}: ${t.title}${t.instructions ? `\n  ${t.instructions}` : ""}`,
    )
    .join("\n");
}

function findingsBlock(findings: readonly Finding[]): string {
  return findings
    .map(
      (f) =>
        `- ${f.criterionId ? `[${f.criterionId}] ` : ""}${f.title}: ${f.description}`,
    )
    .join("\n");
}

function workingRules(facts: ContextFacts): string {
  const contract = facts.contract.current;
  return [
    TASK_COMMANDS_HELP,
    contract.allowTaskAddition ? ADD_TASK_HELP : null,
    contract.ownerQuestions ? QUESTION_HELP : null,
    contract.documentPublishing ? PUBLISH_HELP : null,
    contract.outputSchema !== null
      ? "When the work is complete you will be asked for a structured result; keep it in mind as you work."
      : null,
    contract.deferredChecks.length > 0
      ? `${contract.deferredChecks.map((c) => `\`${c}\``).join(", ")} check the whole workspace, which other work changes alongside yours, so they run later on the assembled tree instead of on your work.`
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function composeInitialWork(facts: ContextFacts): string {
  const contract = facts.contract.current;
  const documents = documentsBlock(facts);
  return [
    `# ${contract.title}`,
    contract.brief,
    charterSection(facts, "implementer"),
    inputsSection(facts),
    section("Tasks", tasksBlock(facts, false)),
    section("Acceptance criteria", criteriaBlock(facts)),
    documents !== null ? section("Documents", documents) : null,
    section("How to work", workingRules(facts)),
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
}

export function composeRetryWork(facts: ContextFacts): string {
  return [
    `# ${facts.contract.current.title}: tasks remain open`,
    "Your last turn ended with tasks still open. Continue the work and mark each task complete when it is done.",
    section("Open tasks", tasksBlock(facts, true)),
    section("Acceptance criteria", criteriaBlock(facts)),
    referencesSection(facts),
    section("How to work", workingRules(facts)),
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
}

export function composeRemediation(
  facts: ContextFacts,
  findings: readonly Finding[],
  carriedAdvice: readonly AdviceItem[],
): string {
  return [
    `# ${facts.contract.current.title}: review found blocking problems`,
    "Fix every blocking finding below. The work is reviewed again afterwards.",
    facts.contract.current.charter !== null ? declineRule(facts, "finding") : null,
    section("Blocking findings", findingsBlock(findings)),
    carriedAdvice.length > 0
      ? section(
          "Optional advice from the same review",
          carriedAdvice.map((a) => `- ${a.title}: ${a.description}`).join("\n"),
        )
      : null,
    section("Acceptance criteria", criteriaBlock(facts)),
    referencesSection(facts),
    section("How to work", workingRules(facts)),
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
}

export function composeRework(
  facts: ContextFacts,
  notes: string | null,
): string {
  return [
    `# ${facts.contract.current.title}: the reviewer declined this result`,
    "A person reviewed the result and asked for changes.",
    section(
      "Their notes",
      notes ?? "No notes were given; review the acceptance criteria again.",
    ),
    section("Acceptance criteria", criteriaBlock(facts)),
    referencesSection(facts),
    section("How to work", workingRules(facts)),
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
}

export function composeSteer(facts: ContextFacts, instruction: string): string {
  return [
    `# ${facts.contract.current.title}: instruction from your owner`,
    instruction,
    referencesSection(facts),
    section("How to work", workingRules(facts)),
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
}

export function composeContinuation(question: string, answer: string): string {
  return [
    "# Your question was answered",
    section("Question", question),
    section("Answer", answer),
    "Continue the work you were doing.",
  ].join("\n\n");
}

export function composeCapture(): string {
  return [
    "# Report your result",
    "Your work is complete. Report its actual result in the required structure.",
    "Describe what you did; do not make further changes to files.",
  ].join("\n\n");
}

/**
 * A structured result cannot carry what the implementer cited or declined;
 * its closing message can. Unstructured results already are that message.
 */
function closingReportSection(facts: ContextFacts): string | null {
  const report = facts.ledger.lastSummary;
  if (facts.contract.current.outputSchema === null || report === null) return null;
  return section("The implementer's closing report", clip(report, 4000));
}

export function composeReview(
  facts: ContextFacts,
  input: { candidate: Candidate; round: ReviewRound; seat: ReviewerAssignment },
): string {
  const authority =
    input.seat.authority === "blocking"
      ? "Your verdict is blocking: `fail` sends the work back, `plan_defect` stops it for the owner when the contract itself cannot be met."
      : "Your review is advisory: report advice; your verdict does not block acceptance.";
  const documents = documentsBlock(facts);
  return [
    `# Review: ${facts.contract.current.title}`,
    authority,
    input.seat.focus !== undefined
      ? section("Your focus", input.seat.focus)
      : null,
    section("What was asked", facts.contract.current.brief),
    charterSection(facts, input.seat.authority),
    inputsSection(facts),
    sharedWorkspaceSection(facts),
    section("Acceptance criteria", criteriaBlock(facts)),
    section(
      "Result to review",
      `The implementer's changes are in your working directory. The exact result downstream work will consume:\n\n\`\`\`json\n${JSON.stringify(input.candidate.output, null, 2)}\n\`\`\``,
    ),
    closingReportSection(facts),
    documents !== null ? section("Documents", documents) : null,
    section(
      "Your answer",
      "Return `verdict` (`pass`, `fail` or `plan_defect`), `findings` for anything that blocks acceptance (cite the criterion id when one applies), and `advisories` for optional improvements. Do not edit files.",
    ),
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
}

export function composeAdvice(facts: ContextFacts, items: readonly AdviceItem[]): string {
  return [
    "# Respond to review advice",
    "Your work passed review. Reviewers left optional advice. For each item, either act on it or decline it, then report one disposition per advisory id.",
    section(
      "Advice",
      items
        .map((item) => `- ${item.id}: ${item.title} — ${item.description}`)
        .join("\n"),
    ),
    "Use `addressed` when you changed the work, `declined` with your reason, or `deferred` with what should follow later.",
    referencesSection(facts),
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
}
