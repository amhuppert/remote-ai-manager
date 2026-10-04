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
  return documents
    .map(
      (d) =>
        `- \`${d.path}\` — ${d.description}${d.readWhen ? ` Read when: ${d.readWhen}` : ""}`,
    )
    .join("\n");
}

/** Earlier accepted results this work builds on, each exactly as accepted. */
function inputsSection(facts: ContextFacts): string | null {
  const inputs = facts.contract.current.inputs;
  if (inputs.length === 0) return null;
  return section(
    "Results this work builds on",
    [
      "Earlier work was accepted with these results; its changes are already in your workspace.",
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
    section("How to work", workingRules(facts)),
  ].join("\n\n");
}

export function composeRemediation(
  facts: ContextFacts,
  findings: readonly Finding[],
  carriedAdvice: readonly AdviceItem[],
): string {
  return [
    `# ${facts.contract.current.title}: review found blocking problems`,
    "Fix every blocking finding below. The work is reviewed again afterwards.",
    section("Blocking findings", findingsBlock(findings)),
    carriedAdvice.length > 0
      ? section(
          "Optional advice from the same review",
          carriedAdvice.map((a) => `- ${a.title}: ${a.description}`).join("\n"),
        )
      : null,
    section("Acceptance criteria", criteriaBlock(facts)),
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
    section("How to work", workingRules(facts)),
  ].join("\n\n");
}

export function composeSteer(facts: ContextFacts, instruction: string): string {
  return [
    `# ${facts.contract.current.title}: instruction from your owner`,
    instruction,
    section("How to work", workingRules(facts)),
  ].join("\n\n");
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
    inputsSection(facts),
    sharedWorkspaceSection(facts),
    section("Acceptance criteria", criteriaBlock(facts)),
    section(
      "Result to review",
      `The implementer's changes are in your working directory. The exact result downstream work will consume:\n\n\`\`\`json\n${JSON.stringify(input.candidate.output, null, 2)}\n\`\`\``,
    ),
    documents !== null ? section("Documents", documents) : null,
    section(
      "Your answer",
      "Return `verdict` (`pass`, `fail` or `plan_defect`), `findings` for anything that blocks acceptance (cite the criterion id when one applies), and `advisories` for optional improvements. Do not edit files.",
    ),
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
}

export function composeAdvice(items: readonly AdviceItem[]): string {
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
  ].join("\n\n");
}
