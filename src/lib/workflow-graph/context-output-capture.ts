/**
 * Capture-side vocabulary for per-context structured outputs (D2).
 *
 * A context that declares an `outputSchema` does not finish when its tasks
 * finish: the engine dispatches ONE dedicated format turn on the context's
 * existing lane conversation and only completes the context once that turn's
 * payload clears the canonical structured-output gate. This module owns the
 * turn's prompt and the outcome vocabulary the engine branches on; the dispatch
 * itself lives in `context-output-capture-runner.ts`, and the read side lives in
 * `context-outputs.ts`.
 *
 * Deliberately dependency-free (no logger, no conversation imports) so the
 * prompt and the issue mapping are testable as pure functions.
 */

import { renderFormatTurnPrompt } from "@/lib/agent-backends/structured-output-prompt";
import type { AgentCallStructuredOutputParse } from "@/lib/workflows/primitives/agent-call-vocabulary";
import { describeOutputSchemaFields } from "@/lib/workflow-graph/context-outputs";
import type { GraphWorkflowValidationIssue } from "@/lib/workflow-graph/definition-schemas";

/**
 * The format turn either produced a payload the gate accepted, or it did not.
 *
 * There is no third "infra error" variant on purpose: a turn that failed for a
 * non-schema reason (SDK error, timeout, abort) throws, so it lands in the
 * iteration's existing agent-turn failure path instead of being miscounted as a
 * schema rejection.
 */
export type GraphWorkflowContextOutputCaptureOutcome =
  | {
      kind: "captured";
      /** The accepted payload. Always an object — the authoring-time subset
       *  walker refuses any declaration whose root is not one. */
      value: Record<string, unknown>;
      parse: AgentCallStructuredOutputParse;
    }
  | {
      kind: "rejected";
      /** One-line summary for the recorded validation result. */
      summary: string;
      /** Path-keyed issues derived from the gate's validator errors. */
      issues: GraphWorkflowValidationIssue[];
      /** The raw text the gate refused, kept for inspection in the recorded
       *  validation failure only — never promoted into `contextOutputs`. */
      rejectedText: string | null;
      /**
       * What the structured-output gate's own bounded repair spent before it
       * refused, and the budget it was measured against. Absent when the gate
       * never reached its repair stage — a payload that validated but is not a
       * JSON object, or a turn that produced no payload at all.
       */
      gateRepair?: { attempts: number; maxAttempts: number };
    };

/**
 * Where the capture prompt tells the agent to put its answer. Rendered into the
 * prompt AND used by the rejection summary so both name the same contract.
 */
const CAPTURE_HEADING = "## Final Output";

const OUTPUT_COLLECTION_NOTE =
  "This context's result is collected after its tasks are complete, in a separate follow-up turn that asks you to restate your finished work in a fixed format. Don't format anything for it now and don't look for a way to submit it: there is no submission command. Do the work, run `cctl workflow task complete` for each task, and end your turn with the finished work in whatever form suits it.";

/**
 * The work-turn half of the output contract, rendered in the implementer's
 * seed prompt. The work turn learns WHAT the format turn will ask for (field
 * names and their descriptions) but none of the shape or limits, so its effort
 * goes into the work rather than into formatting or hunting for a submit path.
 */
export function buildOutputBriefingSection(
  outputSchema: Record<string, unknown>,
): string {
  const fields = describeOutputSchemaFields(outputSchema) ?? [];
  const lines = ["## Output", OUTPUT_COLLECTION_NOTE];
  if (fields.length > 0) {
    lines.push(
      "",
      "The follow-up turn will ask you to report:",
      ...fields.map(
        (field) =>
          `- \`${field.name}\`${field.description ? ` — ${field.description}` : ""}`,
      ),
    );
  }
  return lines.join("\n");
}

/** The one-line form of the same contract for follow-up prompts. */
export const OUTPUT_COLLECTION_REMINDER =
  "Reminder: this context's result is collected in a follow-up turn after its tasks are complete. Finish the work and end your turn with it; there is no submission command.";

/**
 * The format turn's prompt.
 *
 * It renders the FULL declared schema (not a summary of it) because the gate
 * validates against that exact document, and it instructs emit-JSON-only: the
 * turn's whole job is to restate work the lane conversation already did, so any
 * prose around the payload is pure risk for the extraction fall-through.
 */
export function buildOutputCapturePrompt(input: {
  contextTitle: string;
  outputSchema: Record<string, unknown>;
  /** Rendered when a previous capture attempt in this context was rejected, so
   *  the retry sees what the gate refused instead of repeating it blind. */
  previousRejection?: {
    summary: string;
    issues: readonly GraphWorkflowValidationIssue[];
  };
}): string {
  const sections: string[] = [
    CAPTURE_HEADING,
    `Every task in "${input.contextTitle}" is complete. This execution context declares a structured output contract, so this turn produces that output and nothing else.`,
  ];

  if (input.previousRejection) {
    sections.push(
      [
        "### Your previous output was rejected",
        input.previousRejection.summary,
        "",
        ...input.previousRejection.issues.map(
          (issue) => `- ${issue.title}: ${issue.description}`,
        ),
      ].join("\n"),
    );
  }

  sections.push(
    renderFormatTurnPrompt(input.outputSchema),
    "Do not run any tools on this turn — draw every value from the work you already completed in this conversation.",
  );

  return sections.join("\n\n");
}

/**
 * Consume the leading instance path of a validator message and report where it
 * ends, or null when the message does not start with one.
 *
 * The path CANNOT be taken as "everything before the first space": the shared
 * validator bracket-quotes any property name that is not a plain identifier
 * (`joinPath` in `output-schema-subset.ts`), so a legal `outputSchema` property
 * named `risk owner` yields the path `$["risk owner"]` — a space inside the
 * path itself, and a `]` or `"` may be inside the quoted key too. This walks
 * the path grammar instead: `$` followed by any number of `.<segment>` or
 * `[...]` groups, where a bracket group containing a JSON string is consumed
 * through that string's own escaping rules.
 */
function scanInstancePathEnd(message: string): number | null {
  if (!message.startsWith("$")) return null;
  let index = 1;

  while (index < message.length) {
    const char = message[index];
    if (char === ".") {
      const start = index + 1;
      let end = start;
      while (end < message.length && /[A-Za-z0-9_$]/.test(message[end]!)) {
        end += 1;
      }
      // A trailing `.` with no name is not part of the path (`$. must be …`).
      if (end === start) break;
      index = end;
      continue;
    }
    if (char === "[") {
      const closed = scanBracketGroupEnd(message, index);
      if (closed === null) break;
      index = closed;
      continue;
    }
    break;
  }

  return index;
}

/**
 * Index just past the `]` closing the bracket group that starts at `open`, or
 * null when it is unterminated. A quoted key is consumed as a JSON string so
 * neither a `]` nor an escaped `"` inside it can end the group early.
 */
function scanBracketGroupEnd(message: string, open: number): number | null {
  let index = open + 1;
  if (message[index] === '"') {
    index += 1;
    while (index < message.length) {
      const char = message[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === '"') {
        index += 1;
        break;
      }
      index += 1;
    }
  } else {
    while (index < message.length && message[index] !== "]") {
      index += 1;
    }
  }
  return message[index] === "]" ? index + 1 : null;
}

/**
 * The shared subset validator reports each violation as `<instancePath> <what
 * is wrong>` (see `validateJsonSchemaSubset`), so the instance path leads the
 * message. Splitting it off gives a path-keyed issue whose title IS the path —
 * the addressing D4 asked for — while the remaining sentence stays as the
 * description. An error that does not start with a path (a thrown validator, a
 * whole-payload reason) degrades to a payload-level issue rather than inventing
 * a location.
 */
export function toOutputSchemaIssues(
  errors: readonly string[],
): GraphWorkflowValidationIssue[] {
  return errors.map((error) => {
    const trimmed = error.trim();
    const pathEnd = scanInstancePathEnd(trimmed);
    if (pathEnd === null) {
      return { title: "$", description: trimmed, path: "$" };
    }
    const path = trimmed.slice(0, pathEnd);
    const description = trimmed.slice(pathEnd).trim() || trimmed;
    return { title: path, description, path };
  });
}
