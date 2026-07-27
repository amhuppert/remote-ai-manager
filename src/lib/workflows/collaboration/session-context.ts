/**
 * The governing session context a standalone Collaboration Mode run carries:
 * the session's active Alignment charter and the linked ticket's current view.
 *
 * A collaboration run is one logical originating conversation turn, not a turn
 * per phase, so both are captured exactly once at kickoff and reused verbatim
 * for every phase, both agents, and every resume path (session-alignment R12.4,
 * ticket-system 5.7). Re-resolving mid-run would hand the two peers different
 * premises for the same question.
 *
 * Both values come from their canonical owners — `SessionAlignmentService`
 * renders the charter section, `LiveTicketContextProvider` renders the
 * `<active-ticket>` block — and this module never re-renders or reformats
 * either. It owns the persisted schema, the strict execution parser, the pure
 * composition helpers, and the kickoff resolver.
 */

import { z } from "zod";

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { SessionState } from "@/lib/sessions/schemas";
import { isAlignmentEligibleContext } from "@/lib/workflows/conversation/pre-turn/alignment-gate";

const logger = createLogger("workflows.collaboration.session-context");

/**
 * Appended once to the charter when it is delivered as governing instructions.
 *
 * A lane may resume an opaque backend session that already contains an older
 * charter at equal precedence, and neutral collaboration code cannot inspect
 * what a resumed session ref carries. Stating the precedence explicitly is the
 * backend-independent way to make the captured version win.
 */
export const CHARTER_SUPERSEDES_NOTICE =
  "This charter supersedes any earlier charter text present in prior context.";

const capturedAlignmentCharterSchema = z.object({
  version: z.number().int(),
  contentHash: z.string(),
  /** Exact governing section from the canonical renderer — never rebuilt here. */
  text: z.string(),
  /**
   * Digest mode only: the immutable hash-addressed file the digest points at,
   * so the dereferenced content cannot change when a later charter activates.
   */
  snapshotPath: z.string().optional(),
});

export const collaborationSessionContextSchema = z.object({
  alignment: capturedAlignmentCharterSchema.nullable(),
  activeTicketBlock: z.string().nullable(),
});

export type CollaborationSessionContext = z.infer<
  typeof collaborationSessionContextSchema
>;

export type CapturedAlignmentCharter = z.infer<
  typeof capturedAlignmentCharterSchema
>;

/** A run governed by neither a charter nor a linked ticket. */
export const EMPTY_COLLABORATION_SESSION_CONTEXT: CollaborationSessionContext =
  {
    alignment: null,
    activeTicketBlock: null,
  };

/**
 * Why a run cannot execute: its captured premises are unavailable. Storage-side
 * decoding stays permissive so historical envelopes still display, but nothing
 * may dispatch a lane on premises it cannot prove.
 */
export class CollaborationSessionContextError extends Error {
  readonly reason: "absent" | "malformed";

  constructor(reason: "absent" | "malformed", message: string) {
    super(message);
    this.name = "CollaborationSessionContextError";
    this.reason = reason;
  }
}

/**
 * The run predates captured session context, so there is no record of what
 * either peer saw. Substituting an empty projection would fabricate premises
 * rather than reproduce them — an agent may have inherited charter text through
 * a resumed backend session.
 */
export class MissingCollaborationSessionContextError extends CollaborationSessionContextError {
  constructor() {
    super(
      "absent",
      "This collaboration run has no captured session context, so its Alignment charter and ticket context cannot be reproduced. Start a new collaboration run.",
    );
    this.name = "MissingCollaborationSessionContextError";
  }
}

/** The captured context exists but no longer decodes to a usable snapshot. */
export class MalformedCollaborationSessionContextError extends CollaborationSessionContextError {
  constructor(detail: string) {
    super(
      "malformed",
      `This collaboration run's captured session context is unreadable (${detail}), so its Alignment charter and ticket context cannot be reproduced. Start a new collaboration run.`,
    );
    this.name = "MalformedCollaborationSessionContextError";
  }
}

/**
 * Strict gate for every executable path (dispatch, ask-user resume, restart
 * recovery). Absent and malformed are distinct errors because only the first
 * identifies a pre-feature run; both refuse to execute.
 */
export function parseSessionContextForExecution(
  value: unknown,
): CollaborationSessionContext {
  if (value === undefined || value === null) {
    throw new MissingCollaborationSessionContextError();
  }
  const parsed = collaborationSessionContextSchema.safeParse(value);
  if (!parsed.success) {
    throw new MalformedCollaborationSessionContextError(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.code}`)
        .join("; "),
    );
  }
  return parsed.data;
}

/**
 * The charter's channel: governing system/session instructions, matching the
 * precedence an ordinary turn gives it. Returns null when no charter governs —
 * never the `/align` suggestion nudge, which asks the agent to address a user
 * it cannot reach mid-run (session-alignment R12.6).
 */
export function buildLaneSystemInstructions(
  context: CollaborationSessionContext,
): string | null {
  if (!context.alignment) return null;
  return `${context.alignment.text}\n\n${CHARTER_SUPERSEDES_NOTICE}`;
}

/**
 * The ticket view's channel: a transient prefix on substantive work prompts,
 * exactly as an ordinary turn's effective prompt composes it. Never folded into
 * the governing instructions, which a runtime freezes at creation.
 */
export function prefixPromptWithTicketBlock(
  context: CollaborationSessionContext,
  prompt: string,
): string {
  if (!context.activeTicketBlock) return prompt;
  return `${context.activeTicketBlock}\n\n${prompt}`;
}

export interface CollaborationSessionContextResolverDeps {
  /** Canonical active-charter capture; null when no charter governs. */
  captureActiveCharter(
    projectPath: string,
    sessionName: string,
  ): Promise<CapturedAlignmentCharter | null>;
  /** Canonical `<active-ticket>` block; null when the session is unlinked. */
  getLiveTicketBlock(
    projectPath: string,
    sessionName: string,
  ): Promise<string | null>;
}

export interface ResolveCollaborationSessionContextInput {
  projectPath: string;
  sessionName: string;
  creationMode: SessionState["creationMode"] | undefined;
}

/** The two canonical context owners a capture reads from. */
export type CollaborationSessionContextSource = "alignment" | "ticket";

/** A charter read failed, so the run must not start on unknown premises. */
export class CollaborationCharterCaptureError extends Error {
  readonly failedSource: CollaborationSessionContextSource = "alignment";

  constructor(cause: unknown) {
    super(
      `Could not read the session's Alignment charter, so the collaboration run was not started: ${getErrorMessage(cause)}`,
    );
    this.name = "CollaborationCharterCaptureError";
    this.cause = cause;
  }
}

/**
 * Which source a *thrown* capture failure is attributable to, or null when the
 * failure came from neither. Only the charter can abort a capture, so this
 * classifies the fail-closed path; a ticket failure never throws and is
 * reported through `CollaborationSessionContextCapture.degraded` instead.
 * Classifying from the error rather than assuming keeps an unexpected failure
 * from being filed against a source that did not fail.
 */
export function failedSessionContextSource(
  error: unknown,
): CollaborationSessionContextSource | null {
  return error instanceof CollaborationCharterCaptureError
    ? error.failedSource
    : null;
}

/** A source that failed without aborting the run. */
export interface CollaborationSessionContextDegradation {
  source: CollaborationSessionContextSource;
  /** Normalized message only — never a charter or ticket body. */
  error: string;
}

/**
 * One capture's full outcome. `degraded` is a separate field rather than part
 * of the snapshot because the snapshot is persisted and replayed on resume,
 * while a degradation describes only the moment of capture. Returning it
 * alongside the context forces every caller to decide what to do about a
 * partially-read capture instead of silently reading it as "no ticket".
 */
export interface CollaborationSessionContextCapture {
  context: CollaborationSessionContext;
  degraded: CollaborationSessionContextDegradation | null;
}

/**
 * Capture the run's premises once, at kickoff, before the conversation is
 * claimed.
 *
 * Failure policy differs by source on purpose: the charter is governing
 * context, so a read failure fails the run closed rather than silently running
 * ungoverned, while a ticket read failure degrades to an uncontextualized run —
 * the same policy an ordinary turn applies.
 */
export async function resolveCollaborationSessionContext(
  deps: CollaborationSessionContextResolverDeps,
  input: ResolveCollaborationSessionContextInput,
): Promise<CollaborationSessionContextCapture> {
  // A user-invoked run is one attended logical originating turn even though its
  // lane calls dispatch autonomously (session-alignment R12.4/R12.5).
  const alignmentEligible = isAlignmentEligibleContext({
    kind: "standalone_collaboration",
    creationMode: input.creationMode,
    userInitiated: true,
  });

  let alignment: CapturedAlignmentCharter | null = null;
  if (alignmentEligible) {
    try {
      alignment = await deps.captureActiveCharter(
        input.projectPath,
        input.sessionName,
      );
    } catch (err) {
      logger.warn("collaboration.session_context.charter_capture_failed", {
        sessionName: input.sessionName,
        error: getErrorMessage(err),
      });
      throw new CollaborationCharterCaptureError(err);
    }
  }

  // Ticket lookup is ungated, exactly as in the ordinary turn path.
  let activeTicketBlock: string | null = null;
  let degraded: CollaborationSessionContextDegradation | null = null;
  try {
    activeTicketBlock = await deps.getLiveTicketBlock(
      input.projectPath,
      input.sessionName,
    );
  } catch (err) {
    logger.warn("collaboration.session_context.ticket_block_failed", {
      sessionName: input.sessionName,
      error: getErrorMessage(err),
    });
    degraded = { source: "ticket", error: getErrorMessage(err) };
  }

  return { context: { alignment, activeTicketBlock }, degraded };
}
