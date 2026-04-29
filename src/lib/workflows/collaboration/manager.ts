/**
 * Collaboration Mode manager.
 *
 * The thin glue between an HTTP entrypoint and `runCollaborationSlice`. The
 * manager:
 *
 *  - validates the start request (Zod schema mirrors the route body),
 *  - resolves the session worktree path so the slice writes artifacts under
 *    `SessionState.worktreePath` only (per the worktree-isolation rule in
 *    CLAUDE.md),
 *  - constructs production deps via `createCollaborationDeps`,
 *  - kicks off `runCollaborationSlice` in the background so the route can
 *    return a `workflowId` immediately (rounds take minutes; the UI polls the
 *    envelope status for progress),
 *  - exposes `getEnvelope` and `listActive` so the route layer can answer
 *    status questions without re-implementing the repository wiring.
 *
 * The manager keeps the agent-call factory injectable so tests can supply a
 * deterministic `callAgent` without exercising the heavy production runtime
 * resolvers. Production wiring of `callAgent` (`executeAgentCall` with
 * `resolveConversationRuntime`/`resolveTaskRunner` resolvers) is a follow-up
 * concern: this module does NOT bake in those resolvers, so changing them
 * later does not require touching the manager's contract.
 */

import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/errors";
import {
  runCollaborationSlice,
  type CollaborationResumeContext,
  type CollaborationRoundResponse,
  type CollaborationSliceDeps,
  type CollaborationSliceInput,
  type CollaborationSliceResult,
} from "./slice";
import { createCollaborationDeps } from "./deps-factory";
import { createCollaborationProductionCallAgent } from "./agent-caller-production";
import { createSessionWorkflowEnvelopeRepositoryForProduction } from "@/lib/workflows/primitives/default-session-workflow-envelope-store";
import type { WorkflowEnvelope } from "@/lib/workflows/primitives/workflow-envelope-vocabulary";
import type { WorkflowEnvelopeRepository } from "@/lib/workflows/primitives/workflow-envelope-repository";
import {
  createLaneService,
  type LaneService,
} from "@/lib/workflows/primitives/lane-service";
import { createSessionLaneStoreForProduction } from "@/lib/workflows/primitives/lane-store";
import { getSession as defaultGetSession } from "@/lib/state";
import { collaborationRoundResponseSchema } from "./types";

function extractTranscriptFromSnapshot(
  snapshot: Record<string, unknown>,
): CollaborationRoundResponse[][] {
  const raw = snapshot["transcript"];
  if (!Array.isArray(raw)) return [];
  const result: CollaborationRoundResponse[][] = [];
  for (const round of raw) {
    if (!Array.isArray(round)) continue;
    const parsed: CollaborationRoundResponse[] = [];
    for (const entry of round) {
      const candidate = collaborationRoundResponseSchema.safeParse(entry);
      if (candidate.success) parsed.push(candidate.data);
    }
    result.push(parsed);
  }
  return result;
}

const logger = createLogger("workflows.collaboration.manager");

export const collaborationStartRequestSchema = z.object({
  brief: z.string().trim().min(1, "brief is required"),
  maxIterations: z.number().int().min(1).max(20),
  scribeBackend: z.enum(["claude", "codex"]),
});
export type CollaborationStartRequest = z.infer<
  typeof collaborationStartRequestSchema
>;

export const collaborationResumeRequestSchema = z.object({
  resumeToken: z.string().trim().min(1, "resumeToken is required"),
  userAnswers: z.record(z.string(), z.string()).default({}),
});
export type CollaborationResumeRequest = z.infer<
  typeof collaborationResumeRequestSchema
>;

export interface CollaborationManagerStartInput extends CollaborationStartRequest {
  projectPath: string;
  sessionName: string;
}

export interface CollaborationManagerStartResult {
  workflowId: string;
  status: "started";
}

export interface CollaborationManagerSessionResolution {
  worktreePath: string;
}

export interface CollaborationManagerDeps {
  /**
   * Resolves the session worktree path the slice will write artifacts under.
   * Returning `null` means the session does not exist; the manager surfaces
   * this as a typed error to the caller.
   */
  resolveSession(input: {
    projectPath: string;
    sessionName: string;
  }): Promise<CollaborationManagerSessionResolution | null>;

  /**
   * Builds the slice deps. Production wiring composes `createCollaborationDeps`
   * with a real `callAgent`; tests inject deterministic deps here. Receives
   * an optional `laneService` so the manager can share one LaneService
   * between this and `buildCallAgent` — that's required for production WAC
   * post-turn outcomes to hit the same lane state the slice operates on.
   */
  createDeps(input: {
    projectPath: string;
    sessionName: string;
    worktreePath: string;
    callAgent: CollaborationSliceDeps["callAgent"];
    laneService?: LaneService;
  }): CollaborationSliceDeps;

  /**
   * Constructs the per-run LaneService that the manager will share between
   * `buildCallAgent` (for WAC continuity / outcome bookkeeping) and
   * `createDeps` (for the slice's lane initialization, scheduling, and
   * recordOutcome calls). Tests can override this to produce a fake
   * LaneService that does not need to be shared.
   */
  buildLaneService(input: {
    projectPath: string;
    sessionName: string;
  }): LaneService;

  /**
   * Builds the per-run `callAgent`. Kept separate from `createDeps` so the
   * agent-call wiring can evolve independently of the deps shape. The
   * manager passes the same `laneService` it gives to `createDeps` so the
   * production WAC's lane outcome bookkeeping lands on the same lane state
   * the slice's `recordOutcome` writes to.
   */
  buildCallAgent(input: {
    projectPath: string;
    sessionName: string;
    worktreePath: string;
    workflowId: string;
    laneService: LaneService;
  }): CollaborationSliceDeps["callAgent"];

  /**
   * Runs the slice. Production uses the imported `runCollaborationSlice`;
   * tests can substitute a deterministic implementation that resolves with a
   * scripted result.
   */
  runSlice(
    input: CollaborationSliceInput,
    deps: CollaborationSliceDeps,
  ): Promise<CollaborationSliceResult>;

  /**
   * Builds the envelope repository scoped to a single session. Defaults to
   * the production session-state-backed factory.
   */
  createEnvelopeRepository(input: {
    projectPath: string;
    sessionName: string;
  }): WorkflowEnvelopeRepository;

  newWorkflowId(): string;
  now(): string;
}

const defaultBuildCallAgent: CollaborationManagerDeps["buildCallAgent"] = (
  input,
) =>
  createCollaborationProductionCallAgent({
    workflowId: input.workflowId,
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    worktreePath: input.worktreePath,
    sessionKey: `${input.projectPath}::${input.sessionName}`,
    laneService: input.laneService,
  });

const defaultDeps: CollaborationManagerDeps = {
  async resolveSession(input) {
    const session = await defaultGetSession(
      input.projectPath,
      input.sessionName,
    );
    if (!session) return null;
    return { worktreePath: session.worktreePath };
  },
  createDeps(input) {
    return createCollaborationDeps({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      worktreePath: input.worktreePath,
      callAgent: input.callAgent,
      ...(input.laneService ? { laneService: input.laneService } : {}),
    });
  },
  buildLaneService: (input) =>
    createLaneService({
      store: createSessionLaneStoreForProduction({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      }),
    }),
  buildCallAgent: defaultBuildCallAgent,
  runSlice: runCollaborationSlice,
  createEnvelopeRepository(input) {
    return createSessionWorkflowEnvelopeRepositoryForProduction({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
    });
  },
  newWorkflowId: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
};

export class CollaborationSessionNotFoundError extends Error {
  constructor(
    public readonly projectPath: string,
    public readonly sessionName: string,
  ) {
    super(`Session "${sessionName}" not found under project "${projectPath}"`);
    this.name = "CollaborationSessionNotFoundError";
  }
}

export class CollaborationWorkflowNotFoundError extends Error {
  constructor(public readonly workflowId: string) {
    super(`Collaboration workflow "${workflowId}" not found`);
    this.name = "CollaborationWorkflowNotFoundError";
  }
}

export class CollaborationResumeTokenMismatchError extends Error {
  constructor(public readonly workflowId: string) {
    super(`Resume token does not match workflow "${workflowId}"`);
    this.name = "CollaborationResumeTokenMismatchError";
  }
}

export class CollaborationNotPausedError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly status: string,
  ) {
    super(
      `Workflow "${workflowId}" is not paused (status=${status}); resume only valid for paused workflows`,
    );
    this.name = "CollaborationNotPausedError";
  }
}

export interface CollaborationManagerResumeInput extends CollaborationResumeRequest {
  projectPath: string;
  sessionName: string;
  workflowId: string;
}

export interface CollaborationManagerResumeResult {
  workflowId: string;
  status: "resumed";
}

export interface CollaborationManager {
  start(
    input: CollaborationManagerStartInput,
  ): Promise<CollaborationManagerStartResult>;
  resume(
    input: CollaborationManagerResumeInput,
  ): Promise<CollaborationManagerResumeResult>;
  getEnvelope(input: {
    projectPath: string;
    sessionName: string;
    workflowId: string;
  }): Promise<WorkflowEnvelope | null>;
  listActive(input: {
    projectPath: string;
    sessionName: string;
  }): Promise<WorkflowEnvelope[]>;
  listAll(input: {
    projectPath: string;
    sessionName: string;
  }): Promise<WorkflowEnvelope[]>;
}

export function createCollaborationManager(
  overrides: Partial<CollaborationManagerDeps> = {},
): CollaborationManager {
  const deps: CollaborationManagerDeps = { ...defaultDeps, ...overrides };

  return {
    async start(input) {
      const parsed = collaborationStartRequestSchema.parse({
        brief: input.brief,
        maxIterations: input.maxIterations,
        scribeBackend: input.scribeBackend,
      });

      const session = await deps.resolveSession({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
      if (!session) {
        throw new CollaborationSessionNotFoundError(
          input.projectPath,
          input.sessionName,
        );
      }

      const workflowId = deps.newWorkflowId();
      const sessionKey = `${input.projectPath}::${input.sessionName}`;

      const laneService = deps.buildLaneService({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });

      const callAgent = deps.buildCallAgent({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        worktreePath: session.worktreePath,
        workflowId,
        laneService,
      });

      const sliceDeps = deps.createDeps({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        worktreePath: session.worktreePath,
        callAgent,
        laneService,
      });

      const sliceInput: CollaborationSliceInput = {
        workflowId,
        brief: parsed.brief,
        worktreePath: session.worktreePath,
        sessionKey,
        maxIterations: parsed.maxIterations,
        scribeBackend: parsed.scribeBackend,
      };

      logger.info("collaboration.manager.start", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        workflowId,
        maxIterations: parsed.maxIterations,
        scribeBackend: parsed.scribeBackend,
      });

      void deps
        .runSlice(sliceInput, sliceDeps)
        .then((result) => {
          logger.info("collaboration.manager.slice_finished", {
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            workflowId,
            kind: result.kind,
          });
        })
        .catch((err) => {
          logger.error("collaboration.manager.slice_threw", {
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            workflowId,
            error: getErrorMessage(err),
          });
        });

      return { workflowId, status: "started" };
    },

    async resume(input) {
      const parsed = collaborationResumeRequestSchema.parse({
        resumeToken: input.resumeToken,
        userAnswers: input.userAnswers,
      });

      const repo = deps.createEnvelopeRepository({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });

      const envelope = await repo.get(input.workflowId);
      if (!envelope) {
        throw new CollaborationWorkflowNotFoundError(input.workflowId);
      }
      if (envelope.status !== "paused") {
        throw new CollaborationNotPausedError(
          input.workflowId,
          envelope.status,
        );
      }
      if (envelope.pause?.resumeToken !== parsed.resumeToken) {
        throw new CollaborationResumeTokenMismatchError(input.workflowId);
      }

      const session = await deps.resolveSession({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
      if (!session) {
        throw new CollaborationSessionNotFoundError(
          input.projectPath,
          input.sessionName,
        );
      }

      const existingSnapshot =
        envelope.featureSnapshot &&
        typeof envelope.featureSnapshot === "object" &&
        !Array.isArray(envelope.featureSnapshot)
          ? (envelope.featureSnapshot as Record<string, unknown>)
          : {};

      const brief =
        typeof existingSnapshot["brief"] === "string"
          ? (existingSnapshot["brief"] as string)
          : "";
      const maxIterations =
        typeof existingSnapshot["maxIterations"] === "number"
          ? (existingSnapshot["maxIterations"] as number)
          : 5;
      const scribeBackend: "claude" | "codex" =
        existingSnapshot["scribeBackend"] === "claude" ||
        existingSnapshot["scribeBackend"] === "codex"
          ? (existingSnapshot["scribeBackend"] as "claude" | "codex")
          : "claude";
      const completedRounds =
        typeof existingSnapshot["rounds"] === "number"
          ? (existingSnapshot["rounds"] as number)
          : 0;

      const priorTranscript = extractTranscriptFromSnapshot(existingSnapshot);

      const priorAnswers =
        existingSnapshot["userAnswersByRound"] &&
        typeof existingSnapshot["userAnswersByRound"] === "object"
          ? (existingSnapshot["userAnswersByRound"] as Record<
              string,
              Record<string, string>
            >)
          : {};
      const userAnswersByRound: Record<number, Record<string, string>> = {};
      for (const [k, v] of Object.entries(priorAnswers)) {
        const n = Number(k);
        if (Number.isFinite(n)) userAnswersByRound[n] = v;
      }
      userAnswersByRound[completedRounds] = parsed.userAnswers;

      const userAnswersByRoundString: Record<
        string,
        Record<string, string>
      > = {};
      for (const [k, v] of Object.entries(userAnswersByRound)) {
        userAnswersByRoundString[String(k)] = v;
      }
      const updatedSnapshot: Record<string, unknown> = {
        ...existingSnapshot,
        userAnswersByRound: userAnswersByRoundString,
      };

      await repo.update(input.workflowId, {
        featureSnapshot: updatedSnapshot,
      });
      await repo.markRunning(input.workflowId);

      const sessionKey = `${input.projectPath}::${input.sessionName}`;
      const laneService = deps.buildLaneService({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
      const callAgent = deps.buildCallAgent({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        worktreePath: session.worktreePath,
        workflowId: input.workflowId,
        laneService,
      });
      const sliceDeps = deps.createDeps({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        worktreePath: session.worktreePath,
        callAgent,
        laneService,
      });

      const resumeContext: CollaborationResumeContext = {
        resumeFromRound: completedRounds,
        priorTranscript,
        userAnswersByRound,
      };

      const sliceInput: CollaborationSliceInput = {
        workflowId: input.workflowId,
        brief,
        worktreePath: session.worktreePath,
        sessionKey,
        maxIterations,
        scribeBackend,
        resume: resumeContext,
      };

      logger.info("collaboration.manager.resume", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        workflowId: input.workflowId,
        userAnswerCount: Object.keys(parsed.userAnswers).length,
        resumeFromRound: completedRounds,
      });

      void deps
        .runSlice(sliceInput, sliceDeps)
        .then((result) => {
          logger.info("collaboration.manager.resume_slice_finished", {
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            workflowId: input.workflowId,
            kind: result.kind,
          });
        })
        .catch((err) => {
          logger.error("collaboration.manager.resume_slice_threw", {
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            workflowId: input.workflowId,
            error: getErrorMessage(err),
          });
        });

      return { workflowId: input.workflowId, status: "resumed" as const };
    },

    async getEnvelope(input) {
      const repo = deps.createEnvelopeRepository({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
      return repo.get(input.workflowId);
    },

    async listActive(input) {
      const repo = deps.createEnvelopeRepository({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
      const all = await repo.listActive();
      return all.filter((env) => env.workflowType === "collaboration");
    },

    async listAll(input) {
      const repo = deps.createEnvelopeRepository({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
      const all = await repo.listAll();
      return all.filter((env) => env.workflowType === "collaboration");
    },
  };
}

let cachedManager: CollaborationManager | null = null;

export function getDefaultCollaborationManager(): CollaborationManager {
  if (!cachedManager) {
    cachedManager = createCollaborationManager();
  }
  return cachedManager;
}

export function _resetDefaultCollaborationManagerForTesting(): void {
  cachedManager = null;
}
