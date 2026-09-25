// @vitest-inputs src/app/**
import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  PROJECT_CONVERSATION_ROUTE_OPERATIONS,
  PROJECT_CONVERSATION_SCOPED_SESSION_OPERATIONS,
  PROJECT_LEVEL_ROUTE_OPERATIONS,
  SAME_NAME_DIFFERENT_OPERATION,
  projectRouteForSessionRequestPath,
} from "./project-route-equivalent";

/**
 * R1.2: the refusal has to name the project-shaped route for THE ENDPOINT that
 * was addressed, not the conversation base. A caller that POSTed
 * `/sessions/<x>/conversations/<c>/prompt` and is handed
 * `/api/projects/<p>/conversations/<c>` has been pointed at a route that does
 * not perform the operation it asked for.
 */

const PROJECT_CONVERSATION_ROUTE_DIR = path.resolve(
  __dirname,
  "../../app/api/projects/[name]/conversations/[conversationId]",
);
const PROJECT_ROUTE_DIR = path.resolve(
  __dirname,
  "../../app/api/projects/[name]",
);
const SESSION_ROUTE_DIR = path.resolve(
  __dirname,
  "../../app/api/projects/[name]/sessions/[session]",
);

function operationDirNames(dir: string): string[] {
  return readdirSync(dir).filter((name) =>
    statSync(path.join(dir, name)).isDirectory(),
  );
}

/** Every served path under `dir`, relative to it (`""` for `dir/route.ts`). */
function routeLeaves(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) {
        walk(full, prefix === "" ? name : `${prefix}/${name}`);
      } else if (name === "route.ts") {
        out.push(prefix);
      }
    }
  };
  walk(dir, "");
  return out.sort();
}

/** Does `<dir>/<operation>/route.ts` exist — i.e. is that URL actually served? */
function servesRoute(dir: string, operation: string): boolean {
  try {
    return statSync(path.join(dir, operation, "route.ts")).isFile();
  } catch {
    return false;
  }
}

describe("projectRouteForSessionRequestPath", () => {
  it("names the project-shaped route for each conversation leaf, not the base", () => {
    // `abort` joined this list with T7: a project turn is now stoppable, so a
    // session-shaped stop request is told where to retry rather than refused.
    for (const leaf of [
      "read",
      "ask",
      "prompt",
      "messages",
      "rename",
      "generate-name",
      "abort",
      "mcp-config",
      "mcp-config/tools/calc",
    ]) {
      expect(
        projectRouteForSessionRequestPath(
          `/api/projects/demo/sessions/feature-x/conversations/conv-1/${leaf}`,
        ),
      ).toEqual({
        kind: "project-route",
        route: `/api/projects/demo/conversations/conv-1/${leaf}`,
      });
    }
  });

  it("keeps the dynamic sub-segment of a nested leaf", () => {
    expect(
      projectRouteForSessionRequestPath(
        "/api/projects/demo/sessions/feature-x/conversations/conv-1/context-artifacts/a1",
      ),
    ).toEqual({
      kind: "project-route",
      route: "/api/projects/demo/conversations/conv-1/context-artifacts/a1",
    });
    expect(
      projectRouteForSessionRequestPath(
        "/api/projects/demo/sessions/feature-x/conversations/conv-1/agent-capabilities/refresh",
      ),
    ).toEqual({
      kind: "project-route",
      route:
        "/api/projects/demo/conversations/conv-1/agent-capabilities/refresh",
    });
  });

  it("names the conversation base when the session route addressed no leaf", () => {
    expect(
      projectRouteForSessionRequestPath(
        "/api/projects/demo/sessions/feature-x/conversations/conv-1",
      ),
    ).toEqual({
      kind: "project-route",
      route: "/api/projects/demo/conversations/conv-1",
    });
  });

  it("names the project queue route, including the cancellation leaf", () => {
    for (const leaf of ["queue", "queue/msg-1"]) {
      expect(
        projectRouteForSessionRequestPath(
          `/api/projects/demo/sessions/feature-x/conversations/conv-1/${leaf}`,
        ),
      ).toEqual({
        kind: "project-route",
        route: `/api/projects/demo/conversations/conv-1/${leaf}`,
      });
    }
  });

  it("reports a conversation operation that has no project route as session-only", () => {
    for (const leaf of ["fork", "debug-mode/logs"]) {
      expect(
        projectRouteForSessionRequestPath(
          `/api/projects/demo/sessions/feature-x/conversations/conv-1/${leaf}`,
        ),
      ).toEqual({
        kind: "session-only",
        operation: leaf.split("/")[0],
      });
    }
  });

  /**
   * A session-LEVEL operation is not automatically session-only: several have a
   * project-level counterpart at `/api/projects/<p>/<op>`. Calling those
   * session-only tells a caller no project route exists when one is implemented,
   * which is the misdirection R1.2 exists to prevent.
   */
  it("names the project-level counterpart of a session-level operation", () => {
    for (const operation of [
      "commands",
      "files",
      "diff",
      "prompt",
      "conversations",
      "agent-capabilities",
      "mcp-config",
      "dev-servers",
    ]) {
      expect(
        projectRouteForSessionRequestPath(
          `/api/projects/demo/sessions/feature-x/${operation}`,
        ),
      ).toEqual({
        kind: "project-route",
        route: `/api/projects/demo/${operation}`,
      });
    }
  });

  it("keeps the leaf of a nested session-level operation", () => {
    expect(
      projectRouteForSessionRequestPath(
        "/api/projects/demo/sessions/feature-x/mcp-config/tools/github",
      ),
    ).toEqual({
      kind: "project-route",
      route: "/api/projects/demo/mcp-config/tools/github",
    });
  });

  /**
   * The project counterpart of the session notification endpoint is
   * conversation-scoped, and the session path carries no conversation id — so
   * the route is named with an explicit placeholder. Naming the SHAPE the caller
   * must fill beats claiming the operation has no project route at all.
   */
  it("names the conversation-scoped counterpart of a session-level operation", () => {
    expect(
      projectRouteForSessionRequestPath(
        "/api/projects/demo/sessions/feature-x/notifications",
      ),
    ).toEqual({
      kind: "project-route",
      route: "/api/projects/demo/conversations/<conversationId>/notifications",
    });
  });

  it("reports a session-level operation with no project counterpart as session-only", () => {
    for (const operation of [
      "merge",
      "commit",
      "alignment",
      "graph-workflow",
      "workflow-envelopes",
      "reference-documents",
    ]) {
      expect(
        projectRouteForSessionRequestPath(
          `/api/projects/demo/sessions/feature-x/${operation}`,
        ),
      ).toEqual({ kind: "session-only", operation });
    }
  });

  /**
   * `/api/projects/<p>/archive` exists but archives the PROJECT, while
   * `/sessions/<s>/archive` archives the session. Same word, different subject —
   * naming it would point a caller at a destructive unrelated operation.
   */
  it("does not name a same-named project route that performs a different operation", () => {
    expect(
      projectRouteForSessionRequestPath(
        "/api/projects/demo/sessions/feature-x/archive",
      ),
    ).toEqual({ kind: "session-only", operation: "archive" });
  });

  it("decodes percent-encoded project and conversation segments once", () => {
    expect(
      projectRouteForSessionRequestPath(
        "/api/projects/my%20project/sessions/feature-x/conversations/conv%2F1/read",
      ),
    ).toEqual({
      kind: "project-route",
      route: "/api/projects/my%20project/conversations/conv%2F1/read",
    });
  });

  it("returns unknown for a path that is not a project session route", () => {
    expect(projectRouteForSessionRequestPath("/api/health")).toEqual({
      kind: "unknown",
    });
    expect(projectRouteForSessionRequestPath("")).toEqual({ kind: "unknown" });
  });
});

describe("PROJECT_CONVERSATION_ROUTE_OPERATIONS", () => {
  it("matches the operations the project conversation router actually serves", () => {
    // Derived from the App Router tree so the inventory cannot claim a route
    // that does not exist — the failure mode R1.2 is about.
    expect([...PROJECT_CONVERSATION_ROUTE_OPERATIONS].sort()).toEqual(
      operationDirNames(PROJECT_CONVERSATION_ROUTE_DIR)
        .filter((name) => !name.startsWith("["))
        .sort(),
    );
  });
});

describe("PROJECT_LEVEL_ROUTE_OPERATIONS", () => {
  /**
   * Every operation the two routers BOTH serve has to be classified, because
   * the two ways of getting this wrong are symmetric: omitting a real
   * counterpart refuses with "session-only" when a project route exists, and
   * listing a same-named route that does a different thing (`archive`) points
   * the caller at the wrong operation. A new shared operation fails here until
   * someone decides which it is.
   */
  it("classifies every operation both routers serve", () => {
    const shared = operationDirNames(PROJECT_ROUTE_DIR).filter((name) =>
      operationDirNames(SESSION_ROUTE_DIR).includes(name),
    );

    const unclassified = shared.filter(
      (name) =>
        !PROJECT_LEVEL_ROUTE_OPERATIONS.has(name) &&
        !SAME_NAME_DIFFERENT_OPERATION.has(name),
    );

    expect(unclassified).toEqual([]);
  });

  /**
   * A directory is not a route: `route.ts` is what makes the named URL resolve.
   * Checking only the directory would let the inventory name a path that 404s,
   * which is the failure R1.2 is about.
   */
  it("only lists operations whose project route file exists", () => {
    for (const operation of PROJECT_LEVEL_ROUTE_OPERATIONS) {
      expect(servesRoute(PROJECT_ROUTE_DIR, operation)).toBe(true);
      expect(operationDirNames(SESSION_ROUTE_DIR)).toContain(operation);
    }
  });

  /**
   * The mapping carries the leaf over verbatim (`mcp-config/tools/<key>`), which
   * is only safe while the project subtree mirrors the session subtree. If a
   * nested session leaf has no project counterpart, the refusal names a URL that
   * 404s — so the subtrees are compared, not just their roots.
   */
  it("mirrors every nested leaf of a listed operation", () => {
    // `conversations` is excluded: only its ROOT (the list) is reached by the
    // session-level mapping — anything with a conversation id takes the
    // conversation branch, whose deliberately smaller inventory is
    // PROJECT_CONVERSATION_ROUTE_OPERATIONS.
    const verbatim = [...PROJECT_LEVEL_ROUTE_OPERATIONS].filter(
      (operation) => operation !== "conversations",
    );
    for (const operation of verbatim) {
      expect({
        operation,
        leaves: routeLeaves(path.join(PROJECT_ROUTE_DIR, operation)),
      }).toEqual({
        operation,
        leaves: routeLeaves(path.join(SESSION_ROUTE_DIR, operation)),
      });
    }
  });

  it("routes each conversation-scoped counterpart to a route file that exists", () => {
    for (const operation of PROJECT_CONVERSATION_SCOPED_SESSION_OPERATIONS) {
      expect(servesRoute(PROJECT_CONVERSATION_ROUTE_DIR, operation)).toBe(true);
      expect(operationDirNames(SESSION_ROUTE_DIR)).toContain(operation);
    }
  });
});
