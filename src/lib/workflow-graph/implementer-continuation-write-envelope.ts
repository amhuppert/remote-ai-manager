import { getErrorMessage } from "@/lib/shared/errors";
import type { ContextPlacement } from "@/lib/workflow-graph/definition-schemas";
import {
  composeImplementerLaneWriteEnvelope,
  type ImplementerLaneWriteEnvelope,
} from "@/lib/workspace/write-envelope";

/**
 * The write envelope a graph implementer context continues under, resolved
 * from its placement and execution target.
 */

export interface ResolveImplementerContinuationWriteEnvelopeInput {
  executionId: string;
  contextId: string;
  projectPath: string;
  sessionName: string;
  placement: ContextPlacement;
  executionTarget?: { worktreePath: string };
}

export interface ResolveImplementerContinuationWriteEnvelopeDeps {
  composeWriteEnvelope?: typeof composeImplementerLaneWriteEnvelope;
  resolveWorktreePath?(
    projectPath: string,
    sessionName: string,
  ): Promise<string>;
}

export type ImplementerContinuationWriteEnvelopeResolution =
  | {
      ok: true;
      envelope: ImplementerLaneWriteEnvelope | null;
      worktreePath: string | null;
    }
  | { ok: false; error: string; worktreePath: string | null };

export async function resolveImplementerContinuationWriteEnvelope(
  input: ResolveImplementerContinuationWriteEnvelopeInput,
  deps: ResolveImplementerContinuationWriteEnvelopeDeps = {},
): Promise<ImplementerContinuationWriteEnvelopeResolution> {
  if (input.placement.mode === "full") {
    return { ok: true, envelope: null, worktreePath: null };
  }

  let worktreePath = input.executionTarget?.worktreePath;
  if (
    worktreePath === undefined &&
    input.placement.lane === "session" &&
    input.placement.mode === "readOnly"
  ) {
    try {
      worktreePath = await deps.resolveWorktreePath?.(
        input.projectPath,
        input.sessionName,
      );
    } catch (error) {
      return {
        ok: false,
        error: getErrorMessage(error),
        worktreePath: null,
      };
    }
  }
  if (worktreePath === undefined) {
    return {
      ok: false,
      error: "no execution target or session worktree was available",
      worktreePath: null,
    };
  }

  try {
    const composeWriteEnvelope =
      deps.composeWriteEnvelope ?? composeImplementerLaneWriteEnvelope;
    return {
      ok: true,
      envelope: composeWriteEnvelope({
        executionId: input.executionId,
        contextId: input.contextId,
        worktreePath,
        ownedPaths:
          input.placement.mode === "owned" ? input.placement.ownedPaths : [],
        payloadLocation:
          input.placement.mode === "readOnly" ? "scratch" : "worktree",
      }),
      worktreePath,
    };
  } catch (error) {
    return {
      ok: false,
      error: getErrorMessage(error),
      worktreePath,
    };
  }
}
