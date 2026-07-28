import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { activeConversationSchema } from "@/lib/active-conversations/schemas";
import { activeConversationHref } from "@/lib/active-conversations/row-helpers";
import { agentCapabilityKeys } from "@/lib/agent-capabilities/query-keys";
import { describeActiveRow } from "@/components/session/sidebar/ConversationSidebar.helpers";
import { contextArtifactKeys } from "@/lib/context-artifacts/query-keys";
import { contextArtifactsBaseUrl } from "@/lib/context-artifacts/queries";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import {
  projectSentinelRefusalMessage,
  refuseProjectSentinelSessionParam,
} from "@/lib/shared/route-resolution";
import { validateSessionName } from "@/lib/sessions/repo";
import {
  conversationTargetApiBase,
  conversationTargetKey,
  conversationTargetLogFields,
  conversationTargetScopeLabel,
  projectConversationTarget,
  scopeRefFromStoreSessionName,
  scopeRefSessionName,
} from "./conversation-target";
import { conversationListItemSchema } from "./schemas";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "./project-conversation-scope";

/**
 * Non-leakage assertion for `__project__` (R1.3 / A5).
 *
 * The sentinel is an INTERNAL state-store + runtime adapter value. R1.3
 * enumerates exactly four public surface classes it must stay off — URL paths
 * and query strings; HTTP request and response bodies; React Query cache keys;
 * and strings rendered in the user interface. That list is exhaustive: server
 * logs, traces, and other diagnostic sinks are A5-internal and deliberately NOT
 * asserted here (the log SINK's own guard lives in
 * `logging/sentinel-sink-guard.test.ts`). This test pins the boundary from two
 * directions:
 *
 * 1. Behaviourally, over the four enumerated surface classes a project
 *    conversation flows through: URL/href builders, response-body schemas and
 *    refusal payloads, query-key factories, and user-visible labels.
 * 2. Structurally, by requiring every module that reaches for the sentinel to
 *    carry an explicit classification below. A new unclassified importer fails
 *    the test, so the next leak has to be argued for rather than absorbed.
 *
 * Scoped to identity surfaces, not to every component prop: passing a
 * sentinel-valued `sessionName` prop into a session-shaped component is an
 * internal adapter decision, while what such a component EMITS — a URL, a key,
 * a payload, a label — is in scope here.
 */

const SRC_ROOT = path.resolve(__dirname, "../..");
const SENTINEL_MODULE = "conversations/project-conversation-scope";

/** The declaring module is the boundary, not a crossing of it. */
const SENTINEL_MODULE_FILE = "lib/conversations/project-conversation-scope.ts";

type SentinelRole =
  /** The one sanctioned crossing back to the sentinel (the target contract). */
  | "contract"
  /** Session-keyed storage/runtime/actor/lock APIs serving both scopes (A5). */
  | "internal-adapter"
  /**
   * Derives the PUBLIC scope-discriminated variant from an internal session key
   * (`conversationEventScopeFields`) — leak-free by construction: the project
   * variant it emits has no `sessionName` field.
   */
  | "scope-derivation"
  /** Names the sentinel in order to REJECT it in a public position (D2). */
  | "refusal-guard"
  /** Client code passing the internal name into a session-shaped component. */
  | "client-prop"
  /** A known public-surface leak with a recorded deletion condition. */
  | "survivor";

/**
 * Every module allowed to import the sentinel, with why. `survivor` entries are
 * the only ones that emit it on a public surface; each records what must land
 * for the entry to be deleted.
 */
const SENTINEL_IMPORTERS: ReadonlyMap<string, SentinelRole> = new Map([
  ["lib/conversations/conversation-target.ts", "contract"],

  ["lib/state-store/store.ts", "internal-adapter"],
  ["lib/state-store/accessors.ts", "internal-adapter"],
  ["lib/state-store/setters.ts", "internal-adapter"],
  ["lib/prompt/sdk-driver.ts", "internal-adapter"],
  ["lib/conversations/message-queue-drain.ts", "internal-adapter"],
  ["lib/workflows/conversation/actor-implementations.ts", "internal-adapter"],
  // The session-keyed actor materialization seam: it reads the store key to
  // decide WHICH repository holds the conversation (project vs session) and
  // emits nothing — no URL, key, payload, label, or log field.
  ["lib/workflows/conversation/actor-input-loader.ts", "internal-adapter"],
  ["lib/workflows/conversation/persistence.ts", "internal-adapter"],
  ["lib/workflows/conversation/persistence-adapter.ts", "internal-adapter"],
  ["lib/workflows/conversation/rehydration.ts", "internal-adapter"],
  ["lib/project-conversations/route-handlers.ts", "internal-adapter"],
  ["lib/project-conversations/prompt-entry.ts", "internal-adapter"],
  ["lib/project-conversations/status-notifications.ts", "internal-adapter"],
  ["lib/context-artifacts/service.ts", "internal-adapter"],
  ["lib/tickets/slash-command.ts", "internal-adapter"],
  ["lib/documents/session-index.ts", "internal-adapter"],
  ["lib/agent-capabilities/sse-invalidation.ts", "internal-adapter"],
  // NOTE: `lib/conversations/ask-route-handlers.ts` deliberately does NOT import
  // the sentinel. It carries a `ConversationScopeRef` and materializes the store
  // key at the `sendConversationEvent` call via `storeSessionNameFromScopeRef`.
  // While it held the sentinel in a local `sessionName`, four log sites emitted
  // it as a session identity — an R1.3 leak that being classified an
  // "internal-adapter" here did not catch, because this test reads imports, not
  // diagnostics. Keeping the constant out of the module is what makes that leak
  // unwritable; the emitted fields are asserted in its own test.
  // NOTE: `lib/prompt/single-flight.ts` also deliberately does NOT import the
  // sentinel. The conversation lock is keyed by the session-keyed storage name
  // and therefore receives it, but the parameter is named `storeSessionName` and
  // its `conversation-lock.*` events carry `scopeRefFromStoreSessionName(...)`
  // instead — the same shape as the scope-derivation modules below. Turn
  // resource acquisition (lock + query-slot label) is asserted in
  // `actor-implementations.test.ts`, since this test reads imports, not
  // diagnostics.
  ["lib/conversations/mark-unread.ts", "scope-derivation"],
  // The background-activity channel is keyed by the session-keyed store name
  // its wiring layer already holds, and derives the SSE scope variant from it:
  // a project conversation's activity event has no `sessionName` field at all.
  // Its own warn carries only `conversationId`.
  ["lib/conversations/background-activity.ts", "scope-derivation"],
  // The queue is session-keyed storage serving both scopes, so its two SSE
  // producers derive the scope variant from the store key: a project
  // conversation's queue events have no `sessionName` field at all.
  ["lib/conversations/message-queue-service.ts", "scope-derivation"],
  ["lib/prompt/transcript.ts", "scope-derivation"],
  ["lib/workflows/conversation/manager.ts", "scope-derivation"],
  // Lifts a store session key into the listed conversation's public scope
  // variant, so a sentinel-keyed row is listed as `scope: "project"` with no
  // `sessionName` field at all.
  ["lib/conversations/cross-project-list.ts", "scope-derivation"],

  ["lib/shared/route-resolution.ts", "refusal-guard"],
  // Rejects the sentinel as a session NAME. Classified a refusal guard rather
  // than an internal adapter because its rejection message is returned verbatim
  // in the session-creation route's public JSON body — a payload surface, which
  // is why the message must not echo the value it refuses.
  ["lib/sessions/repo.ts", "refusal-guard"],
  // The log SINK's refusal, on two surfaces. Structured-log FIELDS: the surface
  // that can hand `sessionName` the sentinel is the whole project-reachable call
  // graph PLUS the request trace context, which stamps it on entries whose own
  // call sites never mention a session, so the sink substitutes
  // `scope: "project"` rather than depending on auditing every call site. Log
  // FILE PATHS: resolved from the raw trace context, so the field guard cannot
  // reach them — a project conversation routes to the `logs/projects/` tree
  // instead. Both are asserted in `logging/sentinel-sink-guard.test.ts`.
  ["lib/logging/logger.ts", "refusal-guard"],
  // The agent ENVIRONMENT is a public surface in the same sense a URL is: the
  // spawned agent reads `CC_SESSION` and routes with it. `ConversationTarget` is
  // structural, so a caller holding a store session name can spell the session
  // variant with the sentinel; the env builder refuses that target rather than
  // exporting it, mirroring `conversationTargetApiBase`'s throw.
  ["lib/agent-gateway/session-env.ts", "refusal-guard"],
  ["lib/agent-capabilities/route-handlers.ts", "refusal-guard"],
  ["lib/agent-capabilities/schemas.ts", "refusal-guard"],
  // The listed session variant refuses a sentinel-valued `sessionName`.
  ["lib/conversations/schemas.ts", "refusal-guard"],
  // The active-conversations response body's session variant refuses a
  // sentinel-valued `sessionName`, mirroring `conversationListItemSchema`:
  // both lists are public payloads a producer could otherwise hand a store
  // key as a session identity.
  ["lib/active-conversations/schemas.ts", "refusal-guard"],

  ["features/project-detail/ProjectDetailView.tsx", "client-prop"],
  ["features/project-detail/composer/UnifiedComposer.tsx", "client-prop"],
  // NOTE: `components/agent-capabilities/ConversationAgentCapabilitiesConfig.tsx`
  // no longer reaches the sentinel. It took a session-keyed `sessionName` prop
  // and asked `isProjectSentinel` whether to cascade through a session layer;
  // it now takes a `ConversationScopeRef` and branches on `scope` alone (T11),
  // so the composer converts once and the drawer cannot mistake an absent name
  // for a project conversation.
]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.(?:test|stories)\.tsx?$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

function importsSentinelModule(source: string): boolean {
  return new RegExp(
    `from\\s+["'](?:@/|\\./|\\.\\./)[^"']*${SENTINEL_MODULE.replace(
      "conversations/",
      "(?:conversations/)?",
    )}["']`,
  ).test(source);
}

const target = projectConversationTarget("demo", "conv-1");

/**
 * Shared fields for the active-conversations response fixtures below. Built
 * once so the session-variant refusal case differs from the accepted project
 * row ONLY in scope identity — the refusal is then attributable to the
 * sentinel, not to an unrelated field.
 */
const activeRowSharedFields = {
  id: "conv-1",
  name: null,
  status: "running",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  projectName: "demo",
  projectPath: "/tmp/demo",
  agentBackend: "claude",
  summary: null,
  pendingQuestion: null,
  pendingQuestionId: null,
  pendingQuestions: null,
  forkedFrom: null,
  debugActive: false,
  role: null,
  worktreePath: "/tmp/demo",
  lastActivitySummary: null,
  unread: false,
  pendingApproval: null,
} as const;

const activeProjectRow = activeConversationSchema.parse({
  ...activeRowSharedFields,
  scope: "project",
  open: true,
});

/** A listed conversation row (`GET /api/conversations/all` response body). */
const listItemSharedFields = {
  projectName: "demo",
  projectPath: "/tmp/demo",
  worktreePath: "/tmp/demo",
  conversationId: "conv-1",
  conversationName: null,
  summary: null,
  firstPromptSnippet: null,
  backend: "claude",
  backendRef: null,
  transcriptPath: null,
  debugLogPath: null,
  status: "running",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  archived: false,
} as const;

describe("project sentinel stays off public identity surfaces", () => {
  it("never appears in a public URL built from a project target", () => {
    expect(conversationTargetApiBase(target)).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
    expect(contextArtifactsBaseUrl(target)).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
    expect(conversationTargetApiBase(target)).toBe(
      "/api/projects/demo/conversations/conv-1",
    );
  });

  it("never appears in the project row's navigation href (path or query string)", () => {
    const href = activeConversationHref(activeProjectRow);
    expect(href).toBe("/projects/demo?focus=conv-1");
    expect(href).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
  });

  it("never appears in a React Query key built from a project target", () => {
    for (const key of [
      conversationTargetKey(target),
      contextArtifactKeys.list(target),
      contextArtifactKeys.detail(target, "a1"),
      projectConversationKeys.list("demo"),
      projectConversationKeys.messages("demo", "conv-1"),
      agentCapabilityKeys.projectConversation("demo", "conv-1", "mcp"),
    ]) {
      expect(JSON.stringify(key)).not.toContain(
        PROJECT_CONVERSATION_SESSION_SENTINEL,
      );
    }
  });

  it("is stripped by the client scope derivation before reaching keys or labels", () => {
    // The primitive every session-shaped component chain (composer, sidebar
    // peek, capability drawer) converts its stored session name with: at
    // project scope the derived ref has no session name AT ALL, so downstream
    // keys and labels have no field for the sentinel to occupy.
    const ref = scopeRefFromStoreSessionName(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
    expect(ref).toEqual({ scope: "project" });
    expect(scopeRefSessionName(ref)).toBeUndefined();
  });

  it("cannot occupy a session name in the active-conversations response body", () => {
    // `GET /api/conversations/active` is parsed with this schema on the
    // client, so a producer that leaks a store key as a session identity fails
    // validation instead of rendering `__project__` in the sidebar.
    const sentinelRow = {
      ...activeRowSharedFields,
      scope: "session",
      sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
      branchName: null,
    };
    expect(activeConversationSchema.safeParse(sentinelRow).success).toBe(false);
    // The refusal is sentinel-specific, not a vacuous session-variant reject.
    expect(
      activeConversationSchema.safeParse({
        ...sentinelRow,
        sessionName: "auth-work",
      }).success,
    ).toBe(true);
  });

  it("cannot occupy a session name in the addressable-conversations response body", () => {
    const sentinelItem = {
      ...listItemSharedFields,
      scope: "session",
      sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
    };
    expect(conversationListItemSchema.safeParse(sentinelItem).success).toBe(
      false,
    );
    expect(
      conversationListItemSchema.safeParse({
        ...sentinelItem,
        sessionName: "auth-work",
      }).success,
    ).toBe(true);
    // The project variant has no field for a session name to occupy at all.
    const projectItem = conversationListItemSchema.parse({
      ...listItemSharedFields,
      scope: "project",
    });
    expect(JSON.stringify(projectItem)).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
  });

  it("never appears in a sidebar row descriptor for a project conversation", () => {
    // Everything the rail renders for a row — group header, context label,
    // search haystack, href — comes from this descriptor.
    const descriptor = describeActiveRow(activeProjectRow);
    expect(descriptor.contextLabel).toBe("main");
    expect(JSON.stringify(descriptor)).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
  });

  it("never appears in diagnostic identity or a user-visible label", () => {
    expect(JSON.stringify(conversationTargetLogFields(target))).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
    expect(conversationTargetScopeLabel(target)).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
  });

  it("never appears in the refusal that rejects it", async () => {
    const refusal = refuseProjectSentinelSessionParam(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
      "demo",
      "conv-1",
    );
    expect(refusal).not.toBeNull();
    const body = (await refusal?.json()) as { error: string };
    expect(body.error).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
    expect(body.error).toContain("/api/projects/demo/conversations/conv-1");
  });

  it("never appears in the refusal message for any addressed endpoint", () => {
    // The message names the ENDPOINT's project route, not the conversation
    // base (R1.2) — and neither wording may carry the sentinel.
    for (const target of [
      {
        kind: "project-route" as const,
        route: "/api/projects/demo/conversations/conv-1/prompt",
      },
      { kind: "session-only" as const, operation: "fork" },
    ]) {
      const message = projectSentinelRefusalMessage(target);
      expect(message).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
    }
  });

  it("never appears in the session-name validation error returned to a client", () => {
    // `validateSessionName`'s string is the session-creation route's public
    // JSON body, so it is an API response payload under R1.3.
    const error = validateSessionName(PROJECT_CONVERSATION_SESSION_SENTINEL);
    expect(error).not.toBeNull();
    expect(error).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
  });

  it("is reached only by classified modules", () => {
    const unclassified: string[] = [];
    const seen = new Set<string>();

    for (const file of listSourceFiles(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      if (rel === SENTINEL_MODULE_FILE) continue;
      if (!importsSentinelModule(readFileSync(file, "utf8"))) continue;
      seen.add(rel);
      if (!SENTINEL_IMPORTERS.has(rel)) unclassified.push(rel);
    }

    expect(unclassified).toEqual([]);
    // Stale entries hide progress: a classified module that stopped importing
    // the sentinel must lose its entry in the same change.
    expect(
      [...SENTINEL_IMPORTERS.keys()].filter((rel) => !seen.has(rel)),
    ).toEqual([]);
  });

  it("records no public-surface survivors", () => {
    // R1.3 admits no exception: a `survivor` entry is by definition a public
    // surface that emits the sentinel. The role stays in the vocabulary so a
    // future leak must be recorded with a deletion condition rather than
    // silently classified as an internal adapter, but the list must be empty.
    const survivors = [...SENTINEL_IMPORTERS.entries()]
      .filter(([, role]) => role === "survivor")
      .map(([rel]) => rel);
    expect(survivors).toEqual([]);
  });
});
