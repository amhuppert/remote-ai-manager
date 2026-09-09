/**
 * Conversation addressing for every `cctl conversation` leaf.
 *
 * The group's identity contract lives here rather than in one command module
 * because the checkpoint and evidence leaves need exactly the resolution the
 * transcript/artifact leaves already had, and a second copy is how a scope rule
 * drifts. `conversation.ts` and the leaves under this directory are the only
 * callers.
 *
 * The scope rule this module encodes has two halves (R8.6). A READ handed a
 * bare conversation id its own scope answers 404 for may resolve the owning
 * project/session from the id and retry there — a `<conversation-ref>` carries
 * no scope, so requiring flags would make the reference unusable by the agent
 * that received it. A MUTATION never does: `withScopeResolution` wraps reads
 * only, and a mutation that misses reports the miss. `ownerScopeAdvice` exists
 * so that refusal can still name the explicit-scope command that would work —
 * it looks the owner up read-only and returns TEXT, never a retry.
 */

import { z } from "zod";

import {
  conversationTargetApiBase,
  projectConversationTarget,
  sessionConversationTarget,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import {
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
  cliRequest,
  encodePathSegment,
  failure,
  failureFromRequest,
  readConversationScope,
  readSessionEnv,
  resolveProjectContext,
  type CliEnv,
  type CliHost,
  type CliRequestResult,
  type CliResult,
  type GlobalFlags,
  type TokenSource,
} from "../../shared";

/** Audit header the read endpoint stamps into `audit.conversation_read`. */
export const CALLER_CONVERSATION_HEADER = "x-cc-conversation-id";

export interface ConversationCommandTarget {
  server: string;
  token: string | null;
  tokenSource: TokenSource | null;
  /** Scope-discriminated addressing; the only source of endpoint paths below. */
  target: ConversationTarget;
  /** The invoking conversation's own id (env identity), for audit provenance. */
  callerConversationId: string | null;
}

/**
 * Resolve the target conversation: positional `<conversation-id>` first, then
 * `--conversation`, then `CC_CONVERSATION_ID` (reading your own history is
 * valid).
 *
 * Scope: an explicit `--session` wins, then an explicit `--project` alone means
 * project scope, then the environment's declared `CC_CONVERSATION_SCOPE`, then a
 * non-empty env session. The env session read is deliberately a falsy check —
 * `env["CC_SESSION"] ?? null` yields the neutralized `""` for a project
 * conversation and builds `/sessions//conversations/…`.
 */
export async function resolveConversationCommandTarget(
  positional: string | undefined,
  flags: GlobalFlags,
  env: CliEnv,
  host: CliHost,
): Promise<
  | { ok: true; target: ConversationCommandTarget }
  | { ok: false; result: CliResult }
> {
  const base = await resolveProjectContext(flags, env, host);
  if (!base.ok) return base;

  const conversationId =
    positional ?? flags.conversation ?? env["CC_CONVERSATION_ID"];
  if (!conversationId) {
    return {
      ok: false,
      result: failure({
        exitCode: EXIT_USAGE,
        message:
          "no conversation — pass <conversation-id>, --conversation, or set CC_CONVERSATION_ID",
        json: flags.json,
      }),
    };
  }

  const sessionName =
    flags.session ??
    (flags.project || readConversationScope(env) === "project"
      ? null
      : readSessionEnv(env));

  return {
    ok: true,
    target: {
      server: base.context.server,
      token: base.context.token,
      tokenSource: base.context.tokenSource,
      target:
        sessionName === null
          ? projectConversationTarget(base.context.project, conversationId)
          : sessionConversationTarget(
              base.context.project,
              sessionName,
              conversationId,
            ),
      callerConversationId: env["CC_CONVERSATION_ID"] ?? null,
    },
  };
}

export function conversationBasePath(
  target: ConversationCommandTarget,
): string {
  return conversationTargetApiBase(target.target);
}

export function callerHeaders(
  target: ConversationCommandTarget,
): Record<string, string> | undefined {
  return target.callerConversationId === null
    ? undefined
    : { [CALLER_CONVERSATION_HEADER]: target.callerConversationId };
}

/**
 * The explicit scope flags that address this exact conversation, for a
 * follow-up command printed to a caller who may run it from anywhere. A
 * project conversation carries no session flag — the target union has no field
 * for one.
 */
export function scopeFlags(target: ConversationTarget): string {
  return target.scope === "session"
    ? `--project ${target.projectName} --session ${target.sessionName}`
    : `--project ${target.projectName}`;
}

/**
 * A verb body that reached a scope miss: its first scoped request 404'd because
 * the conversation does not live in the target's project/session. `fallback` is
 * the CliResult to surface if scope resolution can't find a better home (so the
 * caller still sees the server's original "not found").
 */
export interface ScopeMiss {
  readonly scopeMiss: true;
  readonly fallback: CliResult;
}

export function scopeMiss(fallback: CliResult): ScopeMiss {
  return { scopeMiss: true, fallback };
}

export function isScopeMiss(value: CliResult | ScopeMiss): value is ScopeMiss {
  return "scopeMiss" in value && value.scopeMiss === true;
}

/**
 * A 404 that means "this conversation isn't in *this* scope" (as opposed to an
 * absent artifact or a bad request) — the signal to resolve the conversation's
 * real owning project/session by id and retry there.
 */
export function isWrongScope404(
  result: Exclude<CliRequestResult, { kind: "ok" }>,
): boolean {
  return (
    result.kind === "error" &&
    result.status === 404 &&
    (result.code === "conversation_not_found" ||
      result.error === "Session not found" ||
      result.error === "Project not found")
  );
}

/**
 * Auto-resolution applies only when the caller left scope implicit: an explicit
 * `--project`/`--session` is an override to respect, and the caller's own
 * conversation was already tried in its own scope (re-resolving yields the same
 * scope).
 */
export function shouldAutoResolveScope(
  target: ConversationCommandTarget,
  flags: GlobalFlags,
): boolean {
  if (flags.session !== undefined || flags.project !== undefined) return false;
  return target.target.conversationId !== target.callerConversationId;
}

/**
 * Subset of the global-lookup ConversationListItem the CLI needs to re-scope.
 * Scope-discriminated, mirroring the payload: a project conversation carries no
 * `sessionName`, so requiring one here would reject every project conversation
 * and strand the cross-scope read (R2.4).
 */
const conversationScopeSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("session"),
    projectName: z.string().min(1),
    sessionName: z.string().min(1),
  }),
  z.object({
    scope: z.literal("project"),
    projectName: z.string().min(1),
  }),
]);

type ScopeResolution =
  | { kind: "resolved"; target: ConversationTarget }
  | { kind: "not-found" }
  | { kind: "error"; result: CliResult };

/**
 * Resolve a conversation's owning project + session by id alone via the global
 * lookup endpoint (`GET /api/conversations/<id>`), so a cross-session/-project
 * reference can be read without the caller knowing where it lives.
 */
async function resolveOwningScope(
  host: CliHost,
  target: ConversationCommandTarget,
  json: boolean,
): Promise<ScopeResolution> {
  const result = await cliRequest(host, {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
    method: "GET",
    path: `/api/conversations/${encodePathSegment(target.target.conversationId)}`,
  });
  if (result.kind === "ok") {
    const parsed = conversationScopeSchema.safeParse(result.body);
    if (!parsed.success) {
      return {
        kind: "error",
        result: failure({
          exitCode: EXIT_OPERATION_FAILED,
          message:
            "could not resolve the conversation's project/session from the server",
          json,
        }),
      };
    }
    return {
      kind: "resolved",
      target:
        parsed.data.scope === "project"
          ? projectConversationTarget(
              parsed.data.projectName,
              target.target.conversationId,
            )
          : sessionConversationTarget(
              parsed.data.projectName,
              parsed.data.sessionName,
              target.target.conversationId,
            ),
    };
  }
  if (result.kind === "error" && result.status === 404) {
    return { kind: "not-found" };
  }
  return { kind: "error", result: failureFromRequest(result, json) };
}

/**
 * Run a conversation READ's request body against the caller's own scope; on a
 * scope miss, resolve the conversation's real project/session by id and retry
 * once there. Own-history and explicitly-scoped calls skip resolution and keep
 * the original "not found". This is how `cctl conversation <read verb> <id>`
 * works on any conversation-ref without `--project`/`--session`.
 *
 * Reads only. A mutation that wrapped itself here would discover a different
 * owning scope and write there, which is exactly the accident R8.6 forbids.
 */
export async function withScopeResolution(
  host: CliHost,
  target: ConversationCommandTarget,
  flags: GlobalFlags,
  json: boolean,
  body: (t: ConversationCommandTarget) => Promise<CliResult | ScopeMiss>,
): Promise<CliResult> {
  const first = await body(target);
  if (!isScopeMiss(first)) return first;
  if (!shouldAutoResolveScope(target, flags)) return first.fallback;

  const scope = await resolveOwningScope(host, target, json);
  if (scope.kind === "not-found") return first.fallback;
  if (scope.kind === "error") return scope.result;

  // The lookup reports scope explicitly, so the retry addresses the project
  // route for a project conversation rather than inferring scope from a name.
  const retried = await body({ ...target, target: scope.target });
  return isScopeMiss(retried) ? retried.fallback : retried;
}

/**
 * The explicit-scope flags a mutation would need to reach this conversation
 * where it actually lives, or null when the owner cannot be established.
 *
 * A mutation that misses its scope is refused, and this is what keeps the
 * refusal actionable without crossing the rule: the lookup is a read, the
 * result is a string the caller runs deliberately, and nothing here re-issues
 * the mutation anywhere.
 */
export async function ownerScopeAdvice(
  host: CliHost,
  target: ConversationCommandTarget,
  flags: GlobalFlags,
): Promise<string | null> {
  if (flags.session !== undefined || flags.project !== undefined) return null;
  const scope = await resolveOwningScope(host, target, false);
  return scope.kind === "resolved" ? scopeFlags(scope.target) : null;
}
