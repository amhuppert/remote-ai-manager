import { childEntriesOf } from "./help-registry";
import { pathKey } from "./help-types";
import { EXIT_USAGE, USAGE, usageFailure, type CliResult } from "./shared";

/**
 * A single verb handler within a group: it receives the args AFTER its own verb
 * token (the group has already consumed the group path + verb) and returns a
 * `CliResult`. A verb whose handler is itself a nested group simply calls
 * `dispatchGroup` again with the deeper path.
 */
export type GroupVerbHandler = (rest: string[]) => Promise<CliResult>;

export interface DispatchGroupInput {
  /**
   * The group's full command path, e.g. ["dev"] or ["workflow", "task"]. The
   * empty path is the CLI root, whose children are the registry's level-1
   * entries.
   */
  group: string[];
  /** Args after the group path — `rest[0]` is the verb to dispatch. */
  rest: string[];
  json: boolean;
  /** Verb → handler. Its keys MUST equal the group's registry children. */
  handlers: Record<string, GroupVerbHandler>;
  /**
   * The word for a child in usage failures. Defaults to "subcommand"; the two
   * nested groups that historically said "verb" (`conversation compaction`,
   * `fixture session`) pass "verb", and `ticket attach` says "kind" because the
   * children are attachment kinds.
   */
  noun?: "subcommand" | "verb" | "kind";
}

/**
 * The root's no-command failure is the usage index, not a one-line verb list:
 * a bare `cctl` is the front door, and the index is what teaches the surface.
 */
function missingCommandResult(json: boolean): CliResult {
  return {
    exitCode: EXIT_USAGE,
    stdout: json
      ? `${JSON.stringify({ ok: false, error: "missing command" })}\n`
      : "",
    stderr: USAGE,
  };
}

/**
 * Render a verb list as an English series: `a` · `a or b` · `a, b, or c`. Mirrors
 * the phrasing the group modules used to hand-write, now derived from one source
 * (the registry children) so dispatch and its error strings cannot drift apart.
 */
export function renderVerbList(verbs: readonly string[]): string {
  if (verbs.length <= 1) return verbs[0] ?? "";
  if (verbs.length === 2) return `${verbs[0]} or ${verbs[1]}`;
  return `${verbs.slice(0, -1).join(", ")}, or ${verbs[verbs.length - 1]}`;
}

/**
 * The registry-driven group dispatcher (docs/design/cc-cli/04; steering
 * `cli.md` "single source of truth"). The valid verb list is the group's
 * registry children — never a literal in the group module — so the dispatch
 * table, the "requires a subcommand: …" prompt, and the "unknown … subcommand"
 * error all derive from the same place. A `handlers` map that disagrees with the
 * registry (missing or extra verb) is a wiring defect and throws. The root
 * (`group: []`) dispatches level-1 commands under the same guarantee.
 */
export async function dispatchGroup(
  input: DispatchGroupInput,
): Promise<CliResult> {
  const { group, rest, json, handlers } = input;
  const noun = input.noun ?? "subcommand";
  const isRoot = group.length === 0;
  const groupKey = pathKey(group);

  const verbs = childEntriesOf(group).map((child) =>
    child.path.slice(group.length).join(" "),
  );

  // The handler map and the registry children must agree exactly — this is the
  // construction that lets us delete every hand-listed verb string and the
  // COVERAGE mirror (a drift would otherwise silently escape).
  const handlerVerbs = new Set(Object.keys(handlers));
  const registryVerbs = new Set(verbs);
  const missing = verbs.filter((v) => !handlerVerbs.has(v));
  const extra = [...handlerVerbs].filter((v) => !registryVerbs.has(v));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `dispatchGroup(${isRoot ? "cctl" : groupKey}): handler map disagrees with the registry — ` +
        `missing [${missing.join(", ")}], extra [${extra.join(", ")}]`,
    );
  }

  const verb = rest[0];
  if (verb === undefined) {
    return isRoot
      ? missingCommandResult(json)
      : usageFailure(
          `${groupKey} requires a ${noun}: ${renderVerbList(verbs)}`,
          json,
        );
  }
  const handler = handlers[verb];
  if (!handler) {
    return isRoot
      ? usageFailure(`unknown command "${verb}"`, json)
      : usageFailure(
          `unknown ${groupKey} ${noun} "${verb}"; ${groupKey} ${noun}s: ${renderVerbList(verbs)}`,
          json,
        );
  }
  return handler(rest.slice(1));
}
