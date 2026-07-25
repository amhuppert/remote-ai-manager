import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { contextArtifactKeys } from "@/lib/context-artifacts/query-keys";
import { contextArtifactsBaseUrl } from "@/lib/context-artifacts/queries";
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
} from "./conversation-target";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "./project-conversation-scope";

/**
 * Non-leakage assertion for `__project__` (R1.3 / A5).
 *
 * The sentinel is an INTERNAL state-store + runtime adapter value. This test
 * pins that boundary from two directions:
 *
 * 1. Behaviourally, over the public identity surfaces a project conversation
 *    flows through: URL builders, React Query keys, diagnostic identity,
 *    user-visible labels, and the refusal message itself.
 * 2. Structurally, by requiring every module that reaches for the sentinel to
 *    carry an explicit classification below. A new unclassified importer fails
 *    the test, so the next leak has to be argued for rather than absorbed.
 *
 * Scoped to identity surfaces, not to every component prop: passing a
 * sentinel-valued `sessionName` prop into a session-shaped component is an
 * internal adapter decision (that component's own scope handling is T1/T11
 * work), while what such a component EMITS — a URL, a key, a payload, a label —
 * is in scope here.
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

  ["features/project-detail/ProjectDetailView.tsx", "client-prop"],
  ["features/project-detail/composer/UnifiedComposer.tsx", "client-prop"],
  [
    "components/agent-capabilities/ConversationAgentCapabilitiesConfig.tsx",
    "client-prop",
  ],
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

  it("never appears in a React Query key built from a project target", () => {
    for (const key of [
      conversationTargetKey(target),
      contextArtifactKeys.list(target),
      contextArtifactKeys.detail(target, "a1"),
    ]) {
      expect(JSON.stringify(key)).not.toContain(
        PROJECT_CONVERSATION_SESSION_SENTINEL,
      );
    }
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
