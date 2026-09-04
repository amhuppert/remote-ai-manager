import { describe, expect, it } from "vitest";
import { runCli } from "./core";
import type { CliEnv, CliHost, FetchInit } from "./shared";

/**
 * R2.4's "project-supported commands select a project route" is a claim about the
 * SERVER, but a CLI unit test cannot see the server: its host accepts any path and
 * answers 200, so `cctl ask` kept passing while the project ask route did not
 * exist. This file closes that gap by checking the path the real command dispatch
 * constructs against the real Next.js route tree, so a project-supported command
 * that points at a missing route fails here instead of at an agent's runtime.
 */

// Every route.ts under src/app/api. Only the KEYS are used — the modules are
// imported lazily and only for the handful of routes the CLI actually hits, so
// this does not pull the app's dependency graph into a CLI unit test. Vite
// resolves the glob at build time, so a new route needs no edit here.
type RouteModuleImporter = () => Promise<Record<string, unknown>>;
const routeModules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, RouteModuleImporter>;
  }
).glob("/src/app/api/**/route.ts");

interface ApiRoute {
  /** URL-shaped segments, dynamic ones still bracketed: ["api","projects","[name]",…]. */
  segments: string[];
  importModule: RouteModuleImporter;
}

/** `/src/app/api/projects/[name]/x/route.ts` → segments `["api","projects","[name]","x"]`. */
function toApiRoute(
  filePath: string,
  importModule: RouteModuleImporter,
): ApiRoute {
  const segments = filePath
    .replace(/^\/src\/app\//, "")
    .replace(/\/route\.ts$/, "")
    .split("/");
  return { segments, importModule };
}

const API_ROUTES: ApiRoute[] = Object.entries(routeModules).map(
  ([filePath, importModule]) => toApiRoute(filePath, importModule),
);

function isDynamic(segment: string): boolean {
  return segment.startsWith("[") && segment.endsWith("]");
}

function isCatchAll(segment: string): boolean {
  return segment.startsWith("[...") || segment.startsWith("[[...");
}

/** Does a concrete request path match this route's segment pattern? */
function routeMatches(route: ApiRoute, requestSegments: string[]): boolean {
  const { segments } = route;
  for (let i = 0; i < segments.length; i++) {
    const pattern = segments[i];
    if (pattern === undefined) return false;
    // A catch-all consumes every remaining segment (and requires at least one).
    if (isCatchAll(pattern)) return requestSegments.length > i;
    const actual = requestSegments[i];
    // A dynamic segment matches any single NON-EMPTY segment. Requiring
    // non-empty is what makes a neutralized `CC_SESSION` produce a real miss
    // rather than silently matching `/sessions//…`.
    if (actual === undefined || actual === "") return false;
    if (isDynamic(pattern)) continue;
    if (pattern !== actual) return false;
  }
  return requestSegments.length === segments.length;
}

function findRoute(requestPath: string): ApiRoute | null {
  const requestSegments = requestPath.replace(/^\//, "").split("/");
  return (
    API_ROUTES.find((route) => routeMatches(route, requestSegments)) ?? null
  );
}

/** The env a PROJECT conversation's agent receives (R2.2). */
const projectEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_CONVERSATION_SCOPE: "project",
  CC_SESSION: "",
  CC_CONVERSATION_ID: "conv-1",
};

/** One-off execution routes are addressed from a SESSION conversation. */
const sessionEnv: CliEnv = {
  ...projectEnv,
  CC_CONVERSATION_SCOPE: "session",
  CC_SESSION: "sess",
};

interface RecordedRequest {
  path: string;
  method: string;
}

function makeHost(body: unknown): CliHost & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    async fetch(url: string, init: FetchInit) {
      requests.push({
        path: new URL(url).pathname,
        method: (init.method ?? "GET").toUpperCase(),
      });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async readTextFile(filePath) {
      if (filePath.includes("validation-lease-")) return "lease-1\n";
      return JSON.stringify({ summary: "s", objective: "o", decisions: [] });
    },
    async readFileBytes() {
      return null;
    },
    async writeTextFile() {},
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

/** A notepad the group's response parsing accepts, for the route sweep below. */
const NOTEPAD_BODY = {
  id: "notepad-1",
  scope: "project",
  projectPath: "/repos/cc",
  name: "Notes",
  content: "# Notes",
  revision: 1,
  writeMode: "full-edit",
  pinned: false,
  archived: false,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

/** A reply the comment group's response parsing accepts. */
const COMMENT_REPLY_BODY = {
  id: "reply-1",
  commentId: "comment-1",
  body: "answered",
  authorKind: "agent",
  authorConversationId: "conv-1",
  createdAt: "2026-08-01T00:00:00.000Z",
};

/** A note the memory group's response parsing accepts, for the route sweep below. */
const MEMORY_NOTE_BODY = {
  id: "mem-1",
  slug: "turbopack-build-memory",
  scope: "project",
  projectPath: "/repos/cc",
  sessionName: null,
  sessionCreatedAt: null,
  kind: "lesson",
  hook: "an unpruned turbopack cache builds far slower than a pruned one",
  body: "",
  statusNote: null,
  aliases: [],
  indexMode: "auto",
  lifecycle: "active",
  reviewAfter: null,
  expiresAt: null,
  supersedesId: null,
  supersededById: null,
  createdBy: "agent",
  authorConversationId: "conv-1",
  revision: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

/** A link row the link and unlink verbs parse. */
const MEMORY_LINK_BODY = {
  id: "memlink-1",
  memoryId: "mem-1",
  kind: "about",
  artifact: { kind: "ticket", ticketId: "ticket-74" },
  createdAt: "2026-08-01T00:00:00.000Z",
};

/**
 * Project-supported commands that issue a request with inline arguments. Each
 * entry is a real `cctl` invocation driven through the production dispatch; the
 * response body only has to satisfy the command's own output parsing.
 */
const PROJECT_SCOPE_INVOCATIONS: {
  name: string;
  argv: string[];
  body: unknown;
}[] = [
  { name: "notify", argv: ["notify", "done"], body: { ok: true } },
  {
    name: "ask",
    argv: [
      "ask",
      "--question",
      "Ship it?",
      "--option",
      "Yes",
      "--option",
      "No",
      "--header",
      "Ship",
    ],
    body: { ok: true, questionBatchId: "b-1" },
  },
  {
    name: "conversation read",
    argv: ["conversation", "read", "conv-1"],
    body: {
      ok: true,
      conversationId: "conv-1",
      messages: [],
      window: { from: 0, to: 0, total: 0 },
    },
  },
  {
    name: "doctor",
    argv: ["doctor"],
    body: {
      serverBuild: "dev",
      identity: { project: "cc", session: null, conversation: "conv-1" },
      tokenValid: true,
    },
  },
  { name: "ticket list", argv: ["ticket", "list"], body: { tickets: [] } },
  // The notepad group reads no session env, so it carries no entry in the
  // session-env inventory — but its routes are exactly what a CLI unit test
  // cannot see, and the flat id-addressed shape is new to this surface.
  {
    name: "notepad list",
    argv: ["notepad", "list"],
    body: { notepads: [] },
  },
  {
    name: "notepad get",
    argv: ["notepad", "get", "notepad-1"],
    body: { notepad: NOTEPAD_BODY },
  },
  {
    name: "notepad create",
    argv: ["notepad", "create", "--name", "Notes"],
    body: { notepad: NOTEPAD_BODY },
  },
  {
    name: "notepad append",
    argv: [
      "notepad",
      "append",
      "notepad-1",
      "--if-revision",
      "1",
      "--content",
      "more",
    ],
    body: { notepad: NOTEPAD_BODY },
  },
  {
    name: "notepad comment list",
    argv: ["notepad", "comment", "list", "notepad-1"],
    body: { comments: [] },
  },
  {
    name: "notepad comment reply",
    argv: [
      "notepad",
      "comment",
      "reply",
      "notepad-1",
      "comment-1",
      "--body",
      "answered",
    ],
    body: { reply: COMMENT_REPLY_BODY },
  },
  // The memory group reads no session env either — it resolves a PROJECT
  // conversation and lets the server derive scope from it — so, like notepad,
  // its routes are covered here rather than by a session-env inventory entry.
  { name: "memory list", argv: ["memory", "list"], body: { notes: [] } },
  {
    name: "memory get",
    argv: ["memory", "get", "turbopack-build-memory"],
    body: { note: MEMORY_NOTE_BODY, links: [] },
  },
  {
    name: "memory create",
    argv: ["memory", "create", "--hook", "something worth keeping"],
    body: {
      note: MEMORY_NOTE_BODY,
      advisories: { overlapCandidates: [], hookWarnings: [] },
    },
  },
  {
    name: "memory update",
    argv: [
      "memory",
      "update",
      "turbopack-build-memory",
      "--if-revision",
      "1",
      "--hook",
      "a sharper hook",
    ],
    body: { note: MEMORY_NOTE_BODY },
  },
  {
    name: "memory link",
    argv: [
      "memory",
      "link",
      "turbopack-build-memory",
      "--artifact",
      "ticket:ticket-74",
    ],
    body: { link: MEMORY_LINK_BODY },
  },
  {
    name: "memory unlink",
    argv: [
      "memory",
      "unlink",
      "turbopack-build-memory",
      "--artifact",
      "ticket:ticket-74",
    ],
    body: { link: MEMORY_LINK_BODY },
  },
  {
    name: "memory mark-reviewed",
    argv: ["memory", "mark-reviewed", "turbopack-build-memory"],
    body: {
      note: MEMORY_NOTE_BODY,
      refreshedWatches: [],
      unresolvedWatches: [],
    },
  },
  {
    name: "memory observe-rederivation",
    argv: [
      "memory",
      "observe-rederivation",
      "turbopack-build-memory",
      "--artifact",
      "context:exec-7/validate-lane",
    ],
    body: {
      observed: {
        memoryId: "mem-1",
        slug: "turbopack-build-memory",
        conversationId: "conv-1",
        executionId: "exec-7",
        contextId: "validate-lane",
      },
    },
  },
  {
    name: "memory promote",
    argv: ["memory", "promote", "turbopack-build-memory"],
    body: { promoted: MEMORY_NOTE_BODY, superseded: MEMORY_NOTE_BODY },
  },
  {
    name: "memory archive",
    argv: ["memory", "archive", "turbopack-build-memory"],
    body: { note: MEMORY_NOTE_BODY },
  },
  {
    name: "memory delete",
    argv: ["memory", "delete", "turbopack-build-memory", "--confirm"],
    body: { note: MEMORY_NOTE_BODY },
  },
  {
    name: "memory recall",
    argv: ["memory", "recall", "turbopack cache"],
    body: {
      pack: {
        mode: "query",
        text: "no matching notes",
        showing: 0,
        total: 0,
        narrowCommand: null,
      },
    },
  },
  { name: "memory index", argv: ["memory", "index"], body: { block: null } },
  { name: "memory review", argv: ["memory", "review"], body: { entries: [] } },
  {
    name: "memory export",
    argv: ["memory", "export", "--output", "/tmp/memory-archive.md"],
    body: {
      archive: '---\narchive: "command-center-memory"\n---\n',
      noteCount: 0,
      generatedAt: "2026-08-01T00:00:00.000Z",
    },
  },
  {
    name: "agent list",
    argv: ["agent", "list"],
    body: { profiles: [], diagnostics: [] },
  },
  {
    name: "agent get",
    argv: ["agent", "get", "builtin:standard-agent"],
    body: {
      id: "standard-agent",
      revision: 1,
      name: "Standard Agent",
      description: "The default profile.",
      instructions: "Work the task.",
      recommendedFor: [],
      tags: [],
      tier: "builtin",
      readOnly: true,
    },
  },
  {
    name: "spec section get",
    argv: ["spec", "section", "get", "feat", "--id", "problem-section"],
    body: {
      specId: "spec-1",
      slug: "feat",
      kind: "section",
      handle: null,
      elementId: "problem-section",
      role: "intent_problem",
      title: "Problem",
      body: "Sections had no narrow read.",
      elementVersion: 1,
      position: 0,
      revision: {
        id: "revision-1",
        number: 1,
        state: "draft",
        authoringStage: "requirements",
      },
    },
  },
  {
    name: "spec abandon",
    argv: ["spec", "abandon", "feat", "--reason", "x"],
    body: { spec: { slug: "feat", status: "abandoned" } },
  },
  {
    name: "spec withdraw-proposal",
    argv: ["spec", "withdraw-proposal", "feat", "--revision", "revision-1"],
    body: {
      withdrawn: {
        id: "revision-1",
        specId: "spec-1",
        number: 2,
        state: "withdrawn",
        authoringStage: "plan",
        basedOnRevisionId: null,
        contentHash: "hash",
        proposedAt: "2026-08-02T00:00:00.000Z",
        approvedAt: null,
        createdAt: "2026-08-02T00:00:00.000Z",
      },
      draft: {
        id: "revision-2",
        specId: "spec-1",
        number: 3,
        state: "draft",
        authoringStage: "plan",
        basedOnRevisionId: "revision-1",
        contentHash: null,
        proposedAt: null,
        approvedAt: null,
        createdAt: "2026-08-02T00:00:00.000Z",
      },
    },
  },
  {
    name: "workflow list",
    argv: ["workflow", "list"],
    body: { workflows: [] },
  },
  {
    name: "workflow templates",
    argv: ["workflow", "templates"],
    body: { templates: [] },
  },
  {
    name: "validate list",
    argv: ["validate", "list"],
    body: {
      commands: [],
      capacity: { limit: 8, inUse: 0, queueDepth: 0 },
      runs: [],
    },
  },
  {
    name: "validate run",
    argv: ["validate", "run", "test"],
    body: {
      kind: "not_started",
      result: {
        kind: "skipped_by_policy",
        message: "Skipped by policy. Do not bypass it.",
      },
    },
  },
  {
    name: "validate status",
    argv: ["validate", "status", "vrun-1"],
    body: {
      runId: "vrun-1",
      status: "running",
      position: null,
      result: null,
    },
  },
  {
    name: "validate cancel",
    argv: ["validate", "cancel", "vrun-1"],
    body: { cancelled: true },
  },
];

describe("route enumeration", () => {
  it("discovers the API route tree", () => {
    // A glob that matched nothing would make every assertion below vacuous.
    expect(API_ROUTES.length).toBeGreaterThan(100);
  });

  it("rejects a path with no route, and an empty dynamic segment (red proof)", () => {
    // Without these, `findRoute` returning a match for everything would let the
    // per-command assertions pass no matter what the CLI built.
    expect(
      findRoute("/api/projects/cc/conversations/conv-1/definitely-not-a-route"),
    ).toBeNull();
    // The exact shape a non-neutralized session env would produce.
    expect(
      findRoute("/api/projects/cc/sessions//conversations/conv-1/read"),
    ).toBeNull();
  });

  it("matches a known concrete route and a catch-all route", () => {
    expect(
      findRoute("/api/projects/cc/conversations/conv-1/ask"),
    ).not.toBeNull();
    expect(
      findRoute(
        "/api/projects/cc/sessions/s1/graph-workflow/shared-documents/a/b.md",
      ),
    ).not.toBeNull();
  });
});

describe("every project-supported cctl command reaches a real Next.js route", () => {
  for (const { name, argv, body } of PROJECT_SCOPE_INVOCATIONS) {
    it(`${name} builds a path served by an existing route module`, async () => {
      const host = makeHost(body);
      await runCli(argv, projectEnv, host);

      expect(host.requests.length).toBeGreaterThan(0);
      for (const { path, method } of host.requests) {
        const route = findRoute(path);
        // The failure message names the path, because "expected null not to be
        // null" would not say which route is missing.
        expect(route === null ? `NO ROUTE for ${path}` : path).toBe(path);
        if (route === null) continue;

        // Existing is not enough: the route must export the METHOD the CLI uses,
        // or the request 405s in production while this test would still pass.
        const moduleNamespace = await route.importModule();
        expect(
          typeof moduleNamespace[method] === "function"
            ? method
            : `${path} exports no ${method} (has: ${Object.keys(moduleNamespace).join(", ")})`,
        ).toBe(method);
      }
    });
  }
});

describe("one-off execution commands reach real session route modules", () => {
  const invocationCases = [
    {
      name: "workflow run",
      argv: [
        "workflow",
        "run",
        "--file",
        "/tmp/plan.json",
        "--session",
        "sess",
      ],
      body: {
        receipt: {
          executionId: "exec-7",
          status: "running",
          origin: { kind: "one_off", planName: "One off" },
          originConversationId: "conv-1",
          deepLink: "/projects/cc/sessions/sess/workflow?execution=exec-7",
          startedAt: "2026-08-14T12:00:00.000Z",
        },
      },
    },
    {
      name: "workflow wait",
      argv: [
        "workflow",
        "wait",
        "exec-7",
        "--session",
        "sess",
        "--timeout",
        "1ms",
      ],
      body: { result: null },
    },
    {
      name: "workflow status by id",
      argv: ["workflow", "status", "exec-7", "--session", "sess"],
      body: { execution: null },
    },
    {
      name: "workflow abandon",
      argv: [
        "workflow",
        "abandon",
        "exec-7",
        "--reason",
        "superseded",
        "--session",
        "sess",
      ],
      body: {
        abandoned: true,
        execution: {
          executionId: "exec-7",
          status: "halted",
          origin: { kind: "one_off", planName: "One off" },
          archived: true,
        },
      },
    },
  ] as const;

  for (const testCase of invocationCases) {
    it(`${testCase.name} builds a path with the exported HTTP method`, async () => {
      const host = makeHost(testCase.body);
      await runCli([...testCase.argv], sessionEnv, host);

      expect(host.requests.length).toBeGreaterThan(0);
      for (const { path, method } of host.requests) {
        const route = findRoute(path);
        expect(route === null ? `NO ROUTE for ${path}` : path).toBe(path);
        if (route === null) continue;
        const moduleNamespace = await route.importModule();
        expect(
          typeof moduleNamespace[method] === "function"
            ? method
            : `${path} exports no ${method}`,
        ).toBe(method);
      }
    });
  }
});
