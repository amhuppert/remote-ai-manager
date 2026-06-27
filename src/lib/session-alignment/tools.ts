import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  conversationRuntimeKey,
  type ConversationRuntimeState,
} from "@/lib/workflows/conversation/runtime-state";

import { proposedDecisionSchema } from "./schemas";
import {
  AlignmentDraftNotFoundError,
  type BeginDraftInput,
  type FillDraftInput,
  type FillDraftResult,
  type ProposeDecisionsInput,
} from "./service";

const logger = createLogger("session-alignment.tools");

// Alignment authoring is attended-only: it gates the active charter behind a
// human Approve-Charter step, so it has no meaning on an autonomous turn (R12.3).
const AUTONOMOUS_DENIAL_MESSAGE =
  "Autonomous optimistic mode — alignment tools are unavailable; make your best judgment and proceed.";

export interface SessionAlignmentToolContext {
  projectPath: string;
  sessionName: string;
  conversationId: string;
}

/** Injected service + runtime seams (method syntax → bivariant params). */
export interface SessionAlignmentToolDeps {
  getRuntime(key: string): ConversationRuntimeState | undefined;
  beginDraft(
    input: BeginDraftInput,
  ): Promise<{ authoringPrompt: string; draftId: string }>;
  fillDraft(input: FillDraftInput): Promise<FillDraftResult>;
  proposeDecisions(input: ProposeDecisionsInput): Promise<{ batchId: string }>;
}

const writeSessionCharterInputSchema = {
  content: z
    .string()
    .min(1)
    .describe(
      "The full free-text markdown charter content. Fills the session's open Alignment draft (created by `/align`); the result is a draft pending the user's approval unless an auto-activating decision draft is open.",
    ),
};

const proposeDecisionsInputSchema = {
  decisions: z
    .array(proposedDecisionSchema)
    .min(1)
    .describe(
      "Decisions to propose for the user's review. Each has a `statement` plus optional `rationale` and `context`. Non-blocking: the batch is persisted for review and the turn continues without waiting.",
    ),
};

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true as const } : {}),
  };
}

/**
 * Resolve the conversation runtime and refuse (isError) when absent or on an
 * autonomous turn. Returns the runtime when the tool may proceed.
 */
function resolveAttendedRuntime(
  context: SessionAlignmentToolContext,
  deps: SessionAlignmentToolDeps,
  toolName: string,
):
  | { runtime: ConversationRuntimeState }
  | { refusal: ReturnType<typeof textResult> } {
  const key = conversationRuntimeKey(
    context.projectPath,
    context.sessionName,
    context.conversationId,
  );
  const runtime = deps.getRuntime(key);
  if (!runtime) {
    logger.warn("tool.no_runtime", {
      tool: toolName,
      conversationId: context.conversationId,
    });
    return {
      refusal: textResult(
        `${toolName}: no active conversation runtime; cannot author alignment.`,
        true,
      ),
    };
  }
  if (runtime.currentTurnAutonomous === true) {
    return { refusal: textResult(AUTONOMOUS_DENIAL_MESSAGE, true) };
  }
  return { runtime };
}

function describeFillResult(result: FillDraftResult): string {
  if (result.status === "activated") {
    return `Charter activated as version ${result.version}.`;
  }
  return "Charter draft saved; it is pending the user's approval before it becomes active.";
}

function createWriteSessionCharterHandler(
  context: SessionAlignmentToolContext,
  deps: SessionAlignmentToolDeps,
) {
  return async (args: { content: string }) => {
    // The attended-only gate (R12.3) takes priority over input validation.
    const resolved = resolveAttendedRuntime(
      context,
      deps,
      "write_session_charter",
    );
    if ("refusal" in resolved) {
      return resolved.refusal;
    }

    if (args.content.length === 0) {
      return textResult(
        "write_session_charter requires non-empty charter content.",
        true,
      );
    }

    const fillInput: FillDraftInput = {
      projectPath: context.projectPath,
      sessionName: context.sessionName,
      conversationId: context.conversationId,
      content: args.content,
    };

    try {
      const result = await fillOpenDraft(deps, context, fillInput);
      logger.info("tool.write_charter", {
        conversationId: context.conversationId,
        status: result.status,
        version: result.version,
      });
      return textResult(describeFillResult(result));
    } catch (err) {
      logger.warn("tool.write_charter.failed", {
        conversationId: context.conversationId,
        error: getErrorMessage(err),
      });
      return textResult(
        `write_session_charter failed: ${getErrorMessage(err)}`,
        true,
      );
    }
  };
}

/**
 * Fill the session's open draft. If none is open (e.g. the agent wrote a charter
 * without running `/align` first), defensively begin a gated draft and fill it.
 */
async function fillOpenDraft(
  deps: SessionAlignmentToolDeps,
  context: SessionAlignmentToolContext,
  fillInput: FillDraftInput,
): Promise<FillDraftResult> {
  try {
    return await deps.fillDraft(fillInput);
  } catch (err) {
    if (!(err instanceof AlignmentDraftNotFoundError)) {
      throw err;
    }
    const beginInput: BeginDraftInput = {
      projectPath: context.projectPath,
      sessionName: context.sessionName,
      conversationId: context.conversationId,
    };
    await deps.beginDraft(beginInput);
    return deps.fillDraft(fillInput);
  }
}

function createProposeDecisionsHandler(
  context: SessionAlignmentToolContext,
  deps: SessionAlignmentToolDeps,
) {
  return async (args: {
    decisions: { statement: string; rationale?: string; context?: string }[];
  }) => {
    // The attended-only gate (R12.3) takes priority over input validation.
    const resolved = resolveAttendedRuntime(context, deps, "propose_decisions");
    if ("refusal" in resolved) {
      return resolved.refusal;
    }

    if (args.decisions.length === 0) {
      return textResult(
        "propose_decisions requires at least one decision.",
        true,
      );
    }

    try {
      const originMessageId = resolved.runtime.currentTurnMessageId ?? null;
      const { batchId } = await deps.proposeDecisions({
        projectPath: context.projectPath,
        sessionName: context.sessionName,
        conversationId: context.conversationId,
        decisions: args.decisions,
        originMessageId,
      });
      logger.info("tool.propose_decisions", {
        conversationId: context.conversationId,
        originMessageId,
        batchId,
        count: args.decisions.length,
      });
      return textResult(
        `Proposed ${args.decisions.length} decision${args.decisions.length === 1 ? "" : "s"} for the user's review; continuing.`,
      );
    } catch (err) {
      logger.warn("tool.propose_decisions.failed", {
        conversationId: context.conversationId,
        error: getErrorMessage(err),
      });
      return textResult(
        `propose_decisions failed: ${getErrorMessage(err)}`,
        true,
      );
    }
  };
}

export function registerSessionAlignmentTools(
  server: McpServer,
  context: SessionAlignmentToolContext,
  deps: SessionAlignmentToolDeps,
): void {
  server.registerTool(
    "write_session_charter",
    {
      description:
        "Author or revise the session's Alignment charter. Fills the open charter draft (created by `/align`) with your free-text markdown; the charter governs the whole session. The result is a draft pending the user's approval — the active charter is unchanged until they approve.",
      inputSchema: writeSessionCharterInputSchema,
    },
    createWriteSessionCharterHandler(context, deps),
  );
  server.registerTool(
    "propose_decisions",
    {
      description:
        "Propose one or more decisions for the user to review and approve. Non-blocking: the batch is persisted for review and your turn continues immediately — do not wait for a response. Approved decisions are folded into the Alignment charter; rejected ones come back with feedback.",
      inputSchema: proposeDecisionsInputSchema,
    },
    createProposeDecisionsHandler(context, deps),
  );
}
