/**
 * The conversation addressing vocabulary for every PUBLIC boundary.
 *
 * A conversation belongs to exactly one of two scopes, and the two carry
 * different identity: a session conversation is addressed by project + session +
 * conversation, a project conversation by project + conversation only (it has no
 * owning session). Modelling that as a discriminated union — rather than an
 * optional/nullable `sessionName` — is what keeps the internal
 * `PROJECT_CONVERSATION_SESSION_SENTINEL` out of URLs, payloads, query keys,
 * diagnostics, and labels: the project variant has no field for it to occupy.
 *
 * `conversationTargetStoreSessionName` is the ONE sanctioned crossing back into
 * the sentinel, for the session-keyed state-store / runtime / lock / actor APIs
 * that legitimately serve both scopes through one storage key.
 *
 * Dependency-free apart from Zod and the sentinel constant, so client
 * components, the `cctl` binary, and server route handlers share one contract.
 */

import { z } from "zod";
import {
  PROJECT_CONVERSATION_SESSION_SENTINEL,
  isProjectSentinel,
} from "./project-conversation-scope";

export const sessionConversationTargetSchema = z
  .object({
    scope: z.literal("session"),
    projectName: z.string().min(1),
    // The internal sentinel is not a public session name (D2).
    sessionName: z
      .string()
      .min(1)
      .refine((name) => !isProjectSentinel(name), {
        message:
          "project conversations are addressed by the project target, not a session name",
      }),
    conversationId: z.string().min(1),
  })
  .strict();

export const projectConversationTargetSchema = z
  .object({
    scope: z.literal("project"),
    projectName: z.string().min(1),
    conversationId: z.string().min(1),
  })
  .strict();

export const conversationTargetSchema = z.discriminatedUnion("scope", [
  sessionConversationTargetSchema,
  projectConversationTargetSchema,
]);

export type ConversationTarget = z.infer<typeof conversationTargetSchema>;

/** The session-scoped variant — carries the owning session's name. */
export type SessionConversationTarget = Extract<
  ConversationTarget,
  { scope: "session" }
>;
/** The project-scoped variant — session-less, runs in the project root. */
export type ProjectConversationTarget = Extract<
  ConversationTarget,
  { scope: "project" }
>;

/**
 * Build a session target, VALIDATING it. The refusal has to live in the builder,
 * not only in the schema: a caller holding a store session name (which is the
 * sentinel for a project conversation) would otherwise mint a target that
 * `conversationTargetApiBase` happily renders as
 * `/sessions/__project__/…`. Use `targetFromStoreSessionName` when the name may
 * legitimately be the sentinel.
 */
export function sessionConversationTarget(
  projectName: string,
  sessionName: string,
  conversationId: string,
): SessionConversationTarget {
  return sessionConversationTargetSchema.parse({
    scope: "session",
    projectName,
    sessionName,
    conversationId,
  });
}

export function projectConversationTarget(
  projectName: string,
  conversationId: string,
): ProjectConversationTarget {
  return { scope: "project", projectName, conversationId };
}

/**
 * The public API path prefix that addresses the target's conversation. Every
 * conversation-level endpoint appends its own leaf (`/prompt`, `/answer`, …), so
 * route construction on the client and in `cctl` shares one builder.
 */
export function conversationTargetApiBase(target: ConversationTarget): string {
  const project = encodeURIComponent(target.projectName);
  const conversation = encodeURIComponent(target.conversationId);
  if (target.scope === "project") {
    return `/api/projects/${project}/conversations/${conversation}`;
  }
  // The type permits a hand-written session literal, so the URL builder itself
  // is the last line of defence: R1.3 is the guarantee that no public URL
  // builder EMITS the sentinel, and a throw here makes that unconditional.
  if (isProjectSentinel(target.sessionName)) {
    throw new Error(
      "conversationTargetApiBase: the project sentinel is not a public session name — address the conversation with a project target",
    );
  }
  return `/api/projects/${project}/sessions/${encodeURIComponent(
    target.sessionName,
  )}/conversations/${conversation}`;
}

/**
 * Cache-identity segments for a conversation-scoped React Query key. Scope leads
 * so the two scopes can never collide on a shared project + id pair.
 */
export function conversationTargetKey(
  target: ConversationTarget,
): readonly string[] {
  return target.scope === "session"
    ? [
        target.scope,
        target.projectName,
        target.sessionName,
        target.conversationId,
      ]
    : [target.scope, target.projectName, target.conversationId];
}

/**
 * Structured-log / audit identity for the addressed conversation. The project
 * variant has no `sessionName` key at all, so a log line can never report the
 * sentinel as a session.
 */
export function conversationTargetLogFields(
  target: ConversationTarget,
): ConversationTarget {
  return target;
}

/**
 * The scope's user-visible name: the session name for a session conversation,
 * the word "project" for a project conversation (never the sentinel).
 */
export function conversationTargetScopeLabel(
  target: ConversationTarget,
): string {
  return target.scope === "session" ? target.sessionName : "project";
}

/**
 * Scope for a surface that knows its project but may have no conversation id yet
 * — composer popups, file/slash autocompletes. Modelled as a discriminated union
 * for the same reason `ConversationTarget` is: an optional `sessionName` where
 * `undefined` means "project" silently reads a sentinel-valued name as a real
 * session and builds `/sessions/__project__/…`.
 */
export type ConversationScopeRef =
  | { scope: "session"; sessionName: string }
  | { scope: "project" };

/**
 * INTERNAL adapter boundary (A5): lift a session-keyed prop into the scope
 * union. The one sanctioned place a component chain converts a stored session
 * name — which is the sentinel for a project conversation — into public scope.
 */
export function scopeRefFromStoreSessionName(
  sessionName: string | undefined,
): ConversationScopeRef {
  return sessionName === undefined || isProjectSentinel(sessionName)
    ? { scope: "project" }
    : { scope: "session", sessionName };
}

/** The session name to address a scope-ref with, or undefined at project scope. */
export function scopeRefSessionName(
  ref: ConversationScopeRef,
): string | undefined {
  return ref.scope === "session" ? ref.sessionName : undefined;
}

/**
 * INTERNAL adapter boundary (A5): the session-keyed storage/runtime name for a
 * scope ref — the sentinel at project scope. Carrying the REF (not the resolved
 * name) through scope-invariant code and calling this only at the storage call
 * site is what keeps the sentinel out of diagnostics: there is no sentinel-valued
 * `sessionName` variable in scope for a log line to pick up (R1.3).
 */
export function storeSessionNameFromScopeRef(
  ref: ConversationScopeRef,
): string {
  return ref.scope === "session"
    ? ref.sessionName
    : PROJECT_CONVERSATION_SESSION_SENTINEL;
}

/**
 * INTERNAL adapter boundary (A5): the session-keyed storage/runtime name for the
 * target — the sentinel for a project conversation. Only state-store, lock,
 * actor, and runtime call sites may use this; no public surface may.
 */
export function conversationTargetStoreSessionName(
  target: ConversationTarget,
): string {
  return target.scope === "session"
    ? target.sessionName
    : PROJECT_CONVERSATION_SESSION_SENTINEL;
}

/**
 * INTERNAL adapter boundary (A5): lift a session-keyed call site back into the
 * public target vocabulary, mirroring `conversationEventScopeFields`.
 */
export function targetFromStoreSessionName(
  projectName: string,
  sessionName: string,
  conversationId: string,
): ConversationTarget {
  return isProjectSentinel(sessionName)
    ? projectConversationTarget(projectName, conversationId)
    : sessionConversationTarget(projectName, sessionName, conversationId);
}
