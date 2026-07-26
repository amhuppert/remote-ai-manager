/**
 * Map a PUBLIC session-shaped request path onto the project-shaped route that
 * performs the same operation (project-conversation-parity R1.2 / D2).
 *
 * A refusal is only actionable if it names the route that does what the caller
 * asked for. Pointing a `.../conversations/<id>/prompt` request at the
 * conversation base tells the caller where the conversation lives, not how to
 * run its turn — the caller has to guess, which is the failure R1.2 exists to
 * prevent.
 *
 * The equivalence is structural: the project router mirrors the session router
 * with the `/sessions/<session>` pair removed, so the leaf (including its own
 * dynamic segments) carries over verbatim. What is NOT structural is whether the
 * project router actually serves that leaf, so the operations it serves are
 * pinned in the inventories below and checked against the App Router tree by
 * `project-route-equivalent.test.ts`. An operation outside them is reported as
 * session-only rather than named as a route that would 404.
 *
 * Session-LEVEL operations (those outside the `conversations/<id>` subtree) are
 * NOT automatically session-only, and treating them that way is the mistake this
 * module exists to avoid in both directions:
 *
 *  - `commands`, `files`, `diff` and friends mirror to `/api/projects/<p>/<op>`.
 *    Refusing them as session-only denies a route that is implemented.
 *  - `notifications` mirrors to a CONVERSATION-scoped project route, and the
 *    session path carries no conversation id, so the route is named with an
 *    explicit placeholder — the shape the caller must fill beats no route at all.
 *  - `archive` exists under both routers but archives different subjects (a
 *    session vs the whole project), so naming it would point the caller at an
 *    unrelated operation.
 */

/**
 * Conversation operations the project router serves, keyed by the FIRST leaf
 * segment — `context-artifacts/<id>` and `agent-capabilities/refresh` are served
 * by the same entry as their parent. Pinned against the App Router directory
 * listing in this module's test, so adding a project route without listing it
 * here (or listing one that does not exist) fails.
 */
export const PROJECT_CONVERSATION_ROUTE_OPERATIONS: ReadonlySet<string> =
  new Set([
    "agent-capabilities",
    "answer",
    "archive",
    "ask",
    "context-artifacts",
    "mark-read",
    "messages",
    "notifications",
    "open",
    "prompt",
    "queue",
    "read",
    "rename",
    "spawn",
  ]);

/**
 * Session-LEVEL operations the project router serves at `/api/projects/<p>/<op>`.
 * Pinned in both directions by this module's test: every operation both routers
 * serve must appear here or in `SAME_NAME_DIFFERENT_OPERATION`, and every entry
 * must exist under both routers.
 */
export const PROJECT_LEVEL_ROUTE_OPERATIONS: ReadonlySet<string> = new Set([
  "agent-capabilities",
  "commands",
  "conversations",
  "diff",
  "files",
  "mcp-config",
  "prompt",
]);

/**
 * Served by both routers under the same name while performing a DIFFERENT
 * operation, so the session request has no project equivalent to name.
 * `/sessions/<s>/archive` archives the session; `/projects/<p>/archive` archives
 * the project. A project conversation is archived through its own conversation
 * route, which the conversation-scoped mapping already covers.
 */
export const SAME_NAME_DIFFERENT_OPERATION: ReadonlySet<string> = new Set([
  "archive",
]);

/**
 * Session-LEVEL operations whose project counterpart is CONVERSATION-scoped.
 * The session path carries no conversation id, so the named route embeds
 * `CONVERSATION_ID_PLACEHOLDER` for the caller to fill.
 */
export const PROJECT_CONVERSATION_SCOPED_SESSION_OPERATIONS: ReadonlySet<string> =
  new Set(["notifications"]);

/** Stands in for an id the addressed path does not carry. */
export const CONVERSATION_ID_PLACEHOLDER = "<conversationId>";

export type ProjectRouteEquivalent =
  /** The project-shaped route performing the addressed operation. */
  | { kind: "project-route"; route: string }
  /** The addressed operation exists only at session scope (a spec non-goal). */
  | { kind: "session-only"; operation: string }
  /** The path is not a project session route, so no equivalence is claimable. */
  | { kind: "unknown" };

const API_PREFIX = ["", "api", "projects"];

/**
 * Resolve the project-shaped equivalent of `pathname`, which is expected to be
 * a `/api/projects/<project>/sessions/<session>/...` request path. Segments are
 * carried over exactly as received (still percent-encoded), so the returned
 * route is byte-comparable with the URL the caller should retry.
 */
export function projectRouteForSessionRequestPath(
  pathname: string,
): ProjectRouteEquivalent {
  const segments = pathname.split("/");
  for (const [index, expected] of API_PREFIX.entries()) {
    if (segments[index] !== expected) return { kind: "unknown" };
  }

  const project = segments[3];
  if (project === undefined || project === "") return { kind: "unknown" };
  if (segments[4] !== "sessions") return { kind: "unknown" };

  // segments[5] is the session name being refused; it is dropped, never echoed.
  const rest = segments.slice(6);
  if (rest[0] !== "conversations") {
    return projectRouteForSessionLevelOperation(project, rest);
  }

  const conversationId = rest[1];
  if (conversationId === undefined || conversationId === "") {
    // `/sessions/<s>/conversations` addresses the session's conversation LIST,
    // whose counterpart is the project's list — a session-level operation that
    // happens to share the subtree's first segment.
    return projectRouteForSessionLevelOperation(project, rest);
  }

  const base = `/api/projects/${project}/conversations/${conversationId}`;
  const leaf = rest.slice(2).filter((segment) => segment !== "");
  if (leaf.length === 0) return { kind: "project-route", route: base };

  const operation = leaf[0] ?? "";
  if (!PROJECT_CONVERSATION_ROUTE_OPERATIONS.has(operation)) {
    return { kind: "session-only", operation };
  }
  return { kind: "project-route", route: `${base}/${leaf.join("/")}` };
}

/**
 * The project equivalent of a session-LEVEL request path — everything after
 * `/sessions/<session>/` when it is not the conversation subtree. `rest` is the
 * remaining segments, still percent-encoded.
 */
function projectRouteForSessionLevelOperation(
  project: string,
  rest: readonly string[],
): ProjectRouteEquivalent {
  const leaf = rest.filter((segment) => segment !== "");
  const operation = leaf[0];
  // `/api/projects/<p>/sessions/<s>` itself addresses the session record, which
  // a project conversation does not have.
  if (operation === undefined)
    return { kind: "session-only", operation: "session" };

  if (PROJECT_LEVEL_ROUTE_OPERATIONS.has(operation)) {
    return {
      kind: "project-route",
      route: `/api/projects/${project}/${leaf.join("/")}`,
    };
  }

  if (PROJECT_CONVERSATION_SCOPED_SESSION_OPERATIONS.has(operation)) {
    return {
      kind: "project-route",
      route: `/api/projects/${project}/conversations/${CONVERSATION_ID_PLACEHOLDER}/${leaf.join(
        "/",
      )}`,
    };
  }

  return { kind: "session-only", operation };
}
