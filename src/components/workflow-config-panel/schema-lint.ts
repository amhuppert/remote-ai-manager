import { lintOutputSchemaText } from "@/components/workflow-config/OutputSchemaField";
import {
  chipPart,
  textPart,
  valuePart,
  type ConfigValuePart,
} from "./value-parts";
import type { ConfigAffordance } from "./types";

/**
 * What the panel says about the authored output-schema text, in the design's
 * four states (Config Panel `lintSchema()` / README §6).
 *
 * The verdict itself is NOT decided here: `lintOutputSchemaText` owns it, and
 * it in turn runs `validateOutputSchemaDeclaration` — the same walker the
 * definition accept path refuses with. This module only translates that verdict
 * into the panel's copy and its collapsed-row summary, so the editor's red text
 * and the engine's refusal can never disagree about what is acceptable.
 */

export type OutputSchemaLintState =
  | "valid"
  | "invalid-json"
  | "unsupported"
  | "empty";

export interface OutputSchemaLintCard {
  state: OutputSchemaLintState;
  /** Headline for the result card. */
  title: string;
  /** The sentence under it — counts when valid, the repair list when not. */
  detail: string;
  /** Green when the engine would take it, red when it would not. */
  tone: "green" | "red" | "neutral";
  /** Derived from the parsed text; null whenever the text does not parse. */
  fields: number | null;
  required: number | null;
  /** A save must be refused while true (README §6, §8.2). */
  blocked: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pluralFields(count: number): string {
  return `${count} ${count === 1 ? "field" : "fields"}`;
}

/**
 * The parse-derived counts, or null when there is nothing parsed to count.
 *
 * Deliberately available on `unsupported` too: the text parsed, so the counts
 * are real, and blanking them would make a repairable schema look empty.
 */
function countsOf(text: string): { fields: number; required: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const properties = parsed.properties;
  const fields =
    typeof properties === "object" &&
    properties !== null &&
    !Array.isArray(properties)
      ? Object.keys(properties).length
      : 0;
  const required = Array.isArray(parsed.required) ? parsed.required.length : 0;
  return { fields, required };
}

export function outputSchemaLintCard(text: string): OutputSchemaLintCard {
  const lint = lintOutputSchemaText(text);
  const counts = countsOf(text);

  if (lint.stage === "empty") {
    return {
      state: "empty",
      title: "No output contract",
      detail:
        "This context declares no structured output. Read-only contexts require one.",
      tone: "neutral",
      fields: null,
      required: null,
      blocked: false,
    };
  }

  if (lint.stage === "invalid-json") {
    // `lintOutputSchemaText` puts the syntax location in `path` (`line 4 · col
    // 3`) and the parser's own complaint in `message`.
    const issue = lint.issues[0];
    const where = issue === undefined ? "" : ` (${issue.path})`;
    const what = issue === undefined ? "The text is not JSON." : issue.message;
    return {
      state: "invalid-json",
      title: "Invalid JSON",
      detail: `${what}${where} — Save is blocked while the text cannot be parsed.`,
      tone: "red",
      fields: null,
      required: null,
      blocked: true,
    };
  }

  if (lint.stage === "unsupported") {
    // Name the offending keywords rather than restating the subset: the author
    // needs to know which of THEIR keys the engine will not read. The locator
    // ends in the keyword for a keyword refusal, which is the common case.
    const named = lint.issues
      .map((issue) => issue.path.split(/[.[]/).pop()?.replace(/["\]]/g, ""))
      .filter((name): name is string => name !== undefined && name.length > 0);
    const unique = [...new Set(named)];
    return {
      state: "unsupported",
      title: "Outside the supported subset",
      detail: `Unsupported here: ${unique.join(", ")}. Save is blocked.`,
      tone: "red",
      fields: counts?.fields ?? null,
      required: counts?.required ?? null,
      blocked: true,
    };
  }

  return {
    state: "valid",
    title: "Accepted by the engine",
    detail: `${pluralFields(counts?.fields ?? 0)} · ${counts?.required ?? 0} required`,
    tone: "green",
    fields: counts?.fields ?? 0,
    required: counts?.required ?? 0,
    blocked: false,
  };
}

/**
 * The Brief screen's collapsed summary of the same verdict: derived counts when
 * the engine would take the text, a red chip naming the failure when it would
 * not (Config Panel `briefRows()`).
 */
export function outputSchemaRowParts(text: string): ConfigValuePart[] {
  const card = outputSchemaLintCard(text);
  if (card.state === "empty") return [textPart("none", "dim")];
  if (card.state === "invalid-json") return [chipPart("invalid JSON", "red")];
  if (card.state === "unsupported") return [chipPart("unsupported", "red")];
  return [
    valuePart(String(card.fields ?? 0)),
    textPart("fields", "dim"),
    valuePart(String(card.required ?? 0)),
    textPart("required", "dim"),
  ];
}

/**
 * Why the schema editor is disabled in each non-editable mode (README §8.1).
 * `editable` has no entry: an enabled editor needs no excuse.
 */
export const OUTPUT_SCHEMA_DISABLED_HINT: Record<
  Exclude<ConfigAffordance, "editable">,
  string
> = {
  frozen:
    "The output was already captured against this schema — editing it now would not re-validate anything.",
  "pause-to-edit":
    "Pause the execution to change the contract before the next iteration runs.",
  "read-only":
    "This execution is no longer running; its working definition is immutable.",
};

/**
 * The host's Save refusal, naming the schema, or null when the text is
 * persistable. The builder toolbar and the execution save bar both read this
 * rather than re-deciding what "acceptable" means.
 */
export function outputSchemaSaveBlockReason(text: string): string | null {
  const card = outputSchemaLintCard(text);
  if (!card.blocked) return null;
  return card.state === "invalid-json"
    ? "The output schema cannot be parsed."
    : "The output schema is outside the engine's supported subset.";
}
