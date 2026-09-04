import { escapeDiagnosticValue } from "@/lib/shared/diagnostic-text";
import type { WorkflowPlanIssue } from "./plan-validation-schemas";

/**
 * The one place an authored-plan locator is rendered for a reader (#80 design
 * 3.2).
 *
 * A located issue addresses the plan by array index — `definition.tasks.2` —
 * while a planner authors and edits by id, so reading a refusal on a 700-line
 * plan means counting array elements to find the record it names. Every
 * indexed segment whose record carries an `id` is followed by that id in
 * parentheses, and the innermost such id is reported separately as
 * `recordId` so a machine consumer never parses the rendering.
 *
 * The JSON path stays FIRST and byte-identical inside the rendered string: the
 * annotation is appended after the index, never in place of it, so a locator
 * with no indexed record segment (`definition.edges` for a cycle,
 * `definition.parameters`, a top-level field) renders exactly as it does
 * today.
 *
 * Both index spellings an authored-plan producer uses are resolved: the dot
 * form the structural and semantic checks emit (`tasks.2`) and the bracket
 * form the schema-shaped checks emit (`executionContexts[1].outputSchema.…`).
 */

/** A dot-path segment that indexes an array, as the dot-form producers spell one. */
const DOT_INDEX_SEGMENT = /^\d+$/;

/** `executionContexts[1]` — a field name followed by its bracket indices. */
const BRACKET_INDEXED_SEGMENT = /^([^[\]]*)((?:\[\d+\])+)$/;

/** The bracket indices inside such a segment, in order. */
const BRACKET_INDEX = /\[(\d+)\]/g;

/** The root of every authored-plan locator; anything else is left alone. */
const DEFINITION_ROOT_SEGMENT = "definition";

/** A locator and the record it addresses, when that record names itself. */
export interface LocatedPlanIssuePath {
  path: string;
  recordId?: string;
}

function readProperty(container: unknown, key: string): unknown {
  if (typeof container !== "object" || container === null) return undefined;
  return Object.getOwnPropertyDescriptor(container, key)?.value;
}

function readElement(container: unknown, index: number): unknown {
  return Array.isArray(container) ? container[index] : undefined;
}

/**
 * The record's own id, when it has one. Read defensively: the definition this
 * walks may be the raw authored document behind a parse failure, so nothing
 * about its shape is guaranteed.
 */
function recordIdOf(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return undefined;
  }
  const id = readProperty(record, "id");
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * The id as it may appear inside a locator.
 *
 * A plan id is only `z.string().trim().min(1)`, so an author can write a line
 * break or a quote into one — and a located issue is rendered as ONE line
 * `  <path>: <message>`, where a raw newline would split a single issue into a
 * second line indistinguishable from a genuine one. Escaping (never dropping)
 * keeps the id visible and the line grammar intact, and leaves every ordinary
 * id — including one carrying dots, colons or parentheses — byte-identical.
 */
function annotationOf(id: string): string {
  return escapeDiagnosticValue(id);
}

/** One dot-path segment, walked and rendered together. */
interface SegmentWalk {
  cursor: unknown;
  rendered: string;
  recordId?: string;
}

function walkSegment(container: unknown, segment: string): SegmentWalk {
  if (DOT_INDEX_SEGMENT.test(segment)) {
    const element = readElement(container, Number(segment));
    const id = recordIdOf(element);
    return {
      cursor: element,
      rendered: id === undefined ? segment : `${segment} (${annotationOf(id)})`,
      ...(id === undefined ? {} : { recordId: id }),
    };
  }

  const bracketed = segment.match(BRACKET_INDEXED_SEGMENT);
  if (bracketed === null) {
    return { cursor: readProperty(container, segment), rendered: segment };
  }

  const [, name = "", indices = ""] = bracketed;
  let cursor = name.length > 0 ? readProperty(container, name) : container;
  let rendered = name;
  let recordId: string | undefined;
  for (const match of indices.matchAll(BRACKET_INDEX)) {
    const [bracket, index = ""] = match;
    cursor = readElement(cursor, Number(index));
    const id = recordIdOf(cursor);
    rendered += id === undefined ? bracket : `${bracket} (${annotationOf(id)})`;
    if (id !== undefined) recordId = id;
  }
  return { cursor, rendered, ...(recordId === undefined ? {} : { recordId }) };
}

/**
 * Annotate one index-only locator against the definition it addresses.
 */
export function locatePlanIssuePath(
  path: string,
  definition: unknown,
): LocatedPlanIssuePath {
  const segments = path.split(".");
  if (segments[0] !== DEFINITION_ROOT_SEGMENT) return { path };

  let cursor: unknown = definition;
  let recordId: string | undefined;
  const rendered: string[] = [DEFINITION_ROOT_SEGMENT];
  for (const segment of segments.slice(1)) {
    const walked = walkSegment(cursor, segment);
    cursor = walked.cursor;
    rendered.push(walked.rendered);
    if (walked.recordId !== undefined) recordId = walked.recordId;
  }

  return {
    path: rendered.join("."),
    ...(recordId === undefined ? {} : { recordId }),
  };
}

/**
 * Every located issue in a list, annotated against one definition. Generic
 * over the issue so the richer shapes — a command issue's `code`, a
 * model-selection issue's `code`/`modelId`/`parameterId` — survive the
 * annotation instead of being narrowed away.
 */
export function locatePlanIssues<Issue extends WorkflowPlanIssue>(
  issues: readonly Issue[],
  definition: unknown,
): (Issue & LocatedPlanIssuePath)[] {
  return issues.map((issue) => ({
    ...issue,
    ...locatePlanIssuePath(issue.path, definition),
  }));
}
