/**
 * Template parameters: the `{{inputs.<name>}}` token grammar, the fields it is
 * substituted in, the save-time lint and the launch-time binding.
 * Browser-safe, so the editor lints with the same rules the server applies.
 *
 * The grammar has no escape. In a substituted field every `{{` is therefore a
 * token, and anything else there is refused, `${{ … }}` included. Elsewhere
 * nothing is substituted, so only text shaped like a parameter token is
 * refused (it would stay literal); other `{{` text, such as a frozen GitHub
 * Actions file's `${{ inputs.x }}`, is kept as written.
 */
import { issueAt, type RunTemplateIssue } from "./schemas";

interface Declaration {
  name: string;
  required: boolean;
}

type Path = ReadonlyArray<string | number>;

const OPENER = "{{";
/** The one valid token, anchored at an opener. */
const TOKEN_AT_OPENER = /^\{\{inputs\.([A-Za-z0-9_-]+)\}\}/;
const TOKENS = /\{\{inputs\.([A-Za-z0-9_-]+)\}\}/g;
/** Text that reads as a parameter token where none is substituted; `${{` is another tool's syntax. */
const STRAY_TOKEN = /(?<!\$)\{\{inputs\./;

const CHARTER_LIST_FIELDS = new Set([
  "conventions",
  "nonGoals",
  "vocabulary",
  "knownAmbiguities",
]);
const SOURCE_FIELDS = new Set(["label", "locator", "description"]);

/**
 * Whether a field of the workflow (path relative to it) has its tokens
 * substituted: each context's title, brief, task titles and instructions and
 * acceptance criteria, and the charter's prose. Keys, output schemas,
 * settings, documents and the template's name are not.
 */
export function isSubstitutedField(path: Path): boolean {
  const [root, index, field, item, leaf] = path;
  if (root === "contexts" && typeof index === "number") {
    if (path.length === 3) return field === "title" || field === "brief";
    if (field === "acceptanceCriteria")
      return path.length === 4 && typeof item === "number";
    if (field === "tasks")
      return (
        path.length === 5 &&
        typeof item === "number" &&
        (leaf === "title" || leaf === "instructions")
      );
    return false;
  }
  if (root !== "charter" || typeof index !== "string") return false;
  if (path.length === 2) return index === "mission" || index === "testStrategy";
  if (path.length === 3)
    return CHARTER_LIST_FIELDS.has(index) && typeof field === "number";
  if (path.length !== 4 || typeof field !== "number") return false;
  if (index === "invariants") return item === "statement";
  if (index === "sourcesOfTruth")
    return typeof item === "string" && SOURCE_FIELDS.has(item);
  return false;
}

/** Every string in a JSON value, with its path. */
function forEachString(
  value: unknown,
  path: Array<string | number>,
  visit: (text: string, path: Array<string | number>) => void,
): void {
  if (typeof value === "string") {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      forEachString(item, [...path, index], visit),
    );
    return;
  }
  if (typeof value === "object" && value !== null)
    for (const [key, child] of Object.entries(value))
      forEachString(child, [...path, key], visit);
}

function lintSubstitutedField(
  text: string,
  path: Path,
  declared: ReadonlySet<string>,
): RunTemplateIssue[] {
  const issues: RunTemplateIssue[] = [];
  let cursor = text.indexOf(OPENER);
  while (cursor !== -1) {
    const token = TOKEN_AT_OPENER.exec(text.slice(cursor));
    const name = token?.[1];
    if (token === null || name === undefined) {
      issues.push(
        issueAt(
          path,
          `"${text.slice(cursor, cursor + 32)}" is not a parameter token. In this field every {{ starts one, and the only token is {{inputs.<name>}} with no spaces; there is no escape.`,
        ),
      );
      cursor = text.indexOf(OPENER, cursor + OPENER.length);
      continue;
    }
    if (!declared.has(name))
      issues.push(
        issueAt(
          path,
          `{{inputs.${name}}} names parameter "${name}", which the template does not declare`,
        ),
      );
    cursor = text.indexOf(OPENER, cursor + token[0].length);
  }
  return issues;
}

/**
 * Every token problem in a template's content, all at once: in a substituted
 * field every `{{` must be a declared parameter's token; anywhere else a
 * parameter token would stay literal, so one there is refused too.
 */
export function lintParameterTokens(content: {
  parameters: readonly Declaration[];
}): RunTemplateIssue[] {
  const declared = new Set(content.parameters.map((p) => p.name));
  const issues: RunTemplateIssue[] = [];
  forEachString(content, [], (text, path) => {
    if (path[0] === "workflow" && isSubstitutedField(path.slice(1))) {
      issues.push(...lintSubstitutedField(text, path, declared));
      return;
    }
    if (STRAY_TOKEN.test(text))
      issues.push(
        issueAt(
          path,
          "A parameter token here is never substituted and would stay literal: parameters are substituted only in context titles, briefs, task titles and instructions, acceptance criteria and the charter's text.",
        ),
      );
  });
  return issues;
}

/**
 * A launch's values for the template's parameters: every name declared, every
 * required value present and not blank, an omitted optional value empty.
 * Problems are located at `parameters.<name>`, all at once.
 */
export function bindParameterValues(
  declarations: readonly Declaration[],
  values: Readonly<Record<string, string>>,
):
  | { ok: true; values: Record<string, string> }
  | { ok: false; issues: RunTemplateIssue[] } {
  const declared = new Set(declarations.map((d) => d.name));
  const issues: RunTemplateIssue[] = Object.keys(values)
    .filter((name) => !declared.has(name))
    .map((name) =>
      issueAt(["parameters", name], `The template has no parameter "${name}"`),
    );
  const bound = declarations.map(({ name, required }) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (required && (value === undefined || value.trim() === ""))
      issues.push(issueAt(["parameters", name], `"${name}" is required`));
    return [name, value ?? ""] as const;
  });
  // Data properties only: an assignment would run an inherited setter instead.
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, values: Object.fromEntries(bound) };
}

function substituteAt(
  value: unknown,
  path: Array<string | number>,
  substitute: (text: string) => string,
): unknown {
  if (typeof value === "string")
    return isSubstitutedField(path) ? substitute(value) : value;
  if (Array.isArray(value))
    return value.map((item, index) =>
      substituteAt(item, [...path, index], substitute),
    );
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        substituteAt(child, [...path, key], substitute),
      ]),
    );
  return value;
}

/**
 * The workflow with each substituted field's tokens replaced by their bound
 * values, in one pass that never rescans an inserted value. A token without a
 * value is a fault: the lint refuses it before any launch gets here.
 */
export function substituteParameters(
  workflow: unknown,
  values: Readonly<Record<string, string>>,
): unknown {
  const unbound = new Set<string>();
  const result = substituteAt(workflow, [], (text) =>
    text.replace(TOKENS, (token, name: string) => {
      const value = Object.hasOwn(values, name) ? values[name] : undefined;
      if (value !== undefined) return value;
      unbound.add(name);
      return token;
    }),
  );
  if (unbound.size > 0)
    throw new Error(
      `Parameters without a value: ${[...unbound].sort().join(", ")}`,
    );
  return result;
}
