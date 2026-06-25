import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { SessionState, SpawnedFrom } from "@/lib/sessions/schemas";
import { createSpawnedSession as defaultCreateSpawnedSession } from "@/lib/sessions/service";
import {
  setSessionSpawnedFrom as defaultSetSessionSpawnedFrom,
  addPlcSpawnedSessionIds as defaultAddPlcSpawnedSessionIds,
} from "@/lib/state-store";
import { isConversationBusy as defaultIsConversationBusy } from "@/lib/prompt/single-flight";
import { executePromptStream as defaultExecutePromptStream } from "@/lib/prompt/sdk-driver";
import {
  createFirstTurnDispatcher,
  type DispatchFirstTurnInput,
} from "@/lib/prompt/first-turn-dispatch";
import { getDefaultCollaborationManager } from "@/lib/workflows/collaboration/manager";
import { broadcast as defaultBroadcast } from "@/lib/events/broadcaster";
import {
  spawnProposalSchema,
  spawnResultEventSchema,
  type ProposedSession,
  type SpawnProposal,
  type SpawnResult,
  type SpawnResultEvent,
} from "./schemas";
import { resolveCommittedHeadBase as defaultResolveCommittedHeadBase } from "./spawn-base";

const logger = createLogger("chat-spawning.service");

export interface ChatSpawnDeps {
  createSession(input: {
    projectPath: string;
    proposed: ProposedSession;
    baseBranch: string;
  }): Promise<SessionState>;
  resolveCommittedHeadBase(projectPath: string): Promise<string>;
  setSessionSpawnedFrom(
    projectPath: string,
    sessionName: string,
    spawnedFrom: SpawnedFrom,
  ): Promise<void>;
  addPlcSpawnedSessionIds(
    projectPath: string,
    conversationId: string,
    sessionNames: string[],
  ): Promise<void>;
  dispatchFirstTurn(
    input: DispatchFirstTurnInput,
  ): Promise<{ dispatched: boolean }>;
  broadcast(event: SpawnResultEvent): void;
}

export interface CreateFromProposalInput {
  projectPath: string;
  projectName: string;
  conversationId: string;
  proposal: SpawnProposal;
}

/**
 * Deterministic spawn orchestrator: validate a (possibly edited) proposal, then
 * create each proposed session via the existing session-creation primitives
 * (committed-HEAD base), tag it `from chat`, back-link it to the spawning PLC,
 * and dispatch its optional first turn. Best-effort across the batch: a failed
 * session is recorded and its prompt dropped without rolling back successes.
 * The agent never reaches this path with creation authority — only a validated
 * proposal does.
 */
export function createChatSpawnService(deps: ChatSpawnDeps): {
  createFromProposal(input: CreateFromProposalInput): Promise<SpawnResult>;
} {
  async function createFromProposal(
    input: CreateFromProposalInput,
  ): Promise<SpawnResult> {
    const { projectPath, projectName, conversationId } = input;
    // Trusted server boundary: re-`parse` (not safeParse) — the proposal was
    // already validated upstream; defaults (e.g. target) are applied here too.
    const proposal = spawnProposalSchema.parse(input.proposal);

    const baseBranch = await deps.resolveCommittedHeadBase(projectPath);

    const created: SpawnResult["created"] = [];
    const failed: SpawnResult["failed"] = [];
    const createdSessionNames: string[] = [];

    // Sequential, not Promise.all: concurrent `git worktree add` against the
    // same parent repo races on `.git/config.lock` (see bulkDeleteSessions).
    for (const proposed of proposal.sessions) {
      try {
        const session = await deps.createSession({
          projectPath,
          proposed,
          baseBranch,
        });

        await deps.setSessionSpawnedFrom(projectPath, session.sessionName, {
          source: "chat",
          projectName,
          conversationId,
        });
        createdSessionNames.push(session.sessionName);

        // Mode-independent: every created session's first turn — for any
        // creation mode and any agent (claude / codex / dual race) — goes
        // through the shared readiness-gated dispatcher. A session with no
        // initialPrompt stays idle.
        let initialPromptDispatched = false;
        if (proposed.initialPrompt !== undefined) {
          const result = await deps.dispatchFirstTurn({
            projectPath,
            projectName,
            session,
            initialPrompt: proposed.initialPrompt,
            agent: proposed.agent,
            model: proposed.model,
            reasoningEffort: proposed.reasoningEffort,
          });
          initialPromptDispatched = result.dispatched;
        }

        created.push({
          name: proposed.name,
          sessionName: session.sessionName,
          branchName: session.branchName,
          initialPromptDispatched,
        });
      } catch (err) {
        logger.error("chat-spawning.create_failed", {
          projectName,
          conversationId,
          proposedName: proposed.name,
          error: getErrorMessage(err),
        });
        // Best-effort: record the failure, drop this session's prompt, continue.
        failed.push({ name: proposed.name, error: getErrorMessage(err) });
      }
    }

    if (createdSessionNames.length > 0) {
      try {
        await deps.addPlcSpawnedSessionIds(
          projectPath,
          conversationId,
          createdSessionNames,
        );
      } catch (err) {
        logger.error("chat-spawning.backlink_failed", {
          projectName,
          conversationId,
          error: getErrorMessage(err),
        });
      }
    }

    const result: SpawnResult = { created, failed };
    deps.broadcast(
      spawnResultEventSchema.parse({
        type: "spawn-result",
        scope: "project",
        projectName,
        conversationId,
        result,
      }),
    );

    logger.info("chat-spawning.batch_complete", {
      projectName,
      conversationId,
      createdCount: created.length,
      failedCount: failed.length,
    });

    return result;
  }

  return { createFromProposal };
}

// ============================================================
// Mode mapping: ProposedSession → createSpawnedSession (provisionSession reuse)
// ============================================================

export interface SpawnSessionCreatorDeps {
  createSpawnedSession: typeof defaultCreateSpawnedSession;
}

/**
 * Build the `createSession` dep that maps a `ProposedSession` to
 * `createSpawnedSession` (which reuses `provisionSession`). It honors the
 * reviewed name, target, and creation mode exactly, branches from the
 * committed-HEAD `baseBranch`, and lets `createSpawnedSession` derive the branch
 * from the name (slug + prefix + uniqueness suffix) exactly as the New Session
 * dialog does. It never fires an auto-run workflow — the shared dispatcher
 * delivers the first turn for every mode. For focus/optimistic the objective
 * seeds focus.md / the stored objective from the initial prompt (or the name);
 * fast carries no objective.
 */
export function createSpawnSessionCreator(
  deps: SpawnSessionCreatorDeps,
): ChatSpawnDeps["createSession"] {
  return async ({ projectPath, proposed, baseBranch }) => {
    const objective =
      proposed.mode === "fast"
        ? null
        : (proposed.initialPrompt ?? proposed.name);
    return deps.createSpawnedSession(projectPath, {
      name: proposed.name,
      targetBranch: proposed.target,
      mode: proposed.mode,
      baseBranch,
      objective,
    });
  };
}

/** Production-wired `ChatSpawnDeps` composing the existing primitives. */
export function defaultChatSpawnDeps(): ChatSpawnDeps {
  const dispatcher = createFirstTurnDispatcher({
    executePromptStream: defaultExecutePromptStream,
    startDualRace: async ({ projectPath, session, conversationId, brief }) => {
      // Mirrors the /collab defaults the prompt route applies when a user starts
      // a dual race without explicit collaboration settings.
      await getDefaultCollaborationManager().start({
        projectPath,
        sessionName: session.sessionName,
        conversationId,
        brief,
        negotiationRounds: 3,
        autonomousResolutionThreshold: "major",
      });
    },
    isConversationBusy: defaultIsConversationBusy,
  });

  return {
    createSession: createSpawnSessionCreator({
      createSpawnedSession: defaultCreateSpawnedSession,
    }),
    resolveCommittedHeadBase: defaultResolveCommittedHeadBase,
    setSessionSpawnedFrom: defaultSetSessionSpawnedFrom,
    addPlcSpawnedSessionIds: defaultAddPlcSpawnedSessionIds,
    dispatchFirstTurn: dispatcher.dispatchFirstTurn,
    broadcast: defaultBroadcast,
  };
}
