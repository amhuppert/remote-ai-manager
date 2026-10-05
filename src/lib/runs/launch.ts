import { z } from "zod";
import { agentProfileRefSchema } from "@/lib/agent-profiles/schemas";
import { STANDARD_AGENT_PROFILE_ID } from "@/lib/agent-profiles/builtins";
import {
  backendModelSelectionSchema,
  type BackendModelSelection,
} from "@/lib/agent-backends/schemas";
import {
  DEFAULT_CONTEXT_POLICY,
  contextContractSchema,
  reviewerAuthoritySchema,
  type ContextStartRequest,
} from "@/lib/execution-context/schemas";
import type { WorkspaceScope } from "@/lib/workspace/schemas";
import { validationCommandNameSchema } from "@/lib/validation/schemas";
import { agentBackendSchema, type AgentBackendId } from "@/lib/shared/schemas";
import type { RunLaunchInput } from "./host";

const reviewerRequestSchema = z
  .object({
    authority: reviewerAuthoritySchema,
    focus: z.string().trim().min(1).optional(),
    profile: agentProfileRefSchema.optional(),
    backend: agentBackendSchema.optional(),
    modelSelection: backendModelSelectionSchema.optional(),
  })
  .strict();

/**
 * A standalone agent launch. Everything but the brief is opt-in; the resolver
 * supplies the rest. Unknown options are refused, never silently dropped.
 */
export const agentLaunchRequestSchema = z
  .object({
    brief: z.string().trim().min(1),
    title: z.string().trim().min(1).max(120).optional(),
    backend: agentBackendSchema.optional(),
    modelSelection: backendModelSelectionSchema.optional(),
    profile: agentProfileRefSchema.optional(),
    tasks: z
      .array(
        z
          .object({
            title: z.string().trim().min(1),
            instructions: z.string().trim().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
    acceptanceCriteria: z.array(z.string().trim().min(1)).optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    checks: z.array(validationCommandNameSchema).optional(),
    reviewers: z.array(reviewerRequestSchema).optional(),
    humanApproval: z.boolean().optional(),
    ownerQuestions: z.boolean().optional(),
    /** A limit per backend invocation, not a deadline for the whole run. */
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();
export type AgentLaunchRequest = z.infer<typeof agentLaunchRequestSchema>;

/** A seat's backend and admitted model selection, resolved by the caller from configuration. */
export interface ResolvedSeat {
  backend: AgentBackendId;
  modelSelection: BackendModelSelection;
}

const STANDARD_AGENT = {
  tier: "builtin" as const,
  id: STANDARD_AGENT_PROFILE_ID,
};
const GENERAL_REVIEWER = { tier: "builtin" as const, id: "general-reviewer" };

function titleOf(request: AgentLaunchRequest): string {
  if (request.title !== undefined) return request.title;
  const firstLine = request.brief.split("\n")[0]?.trim() ?? request.brief;
  return firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 117)}...`;
}

/** Where a run's contexts work and who owns them, resolved by the caller. */
export interface LaunchPlacement {
  runId: string;
  cause: string;
  projectPath: string;
  session: { sessionName: string; worktreePath: string; branch: string };
  owner: { conversationId: string; sessionName: string | null };
  /** Where a lane of this session lives, by lane id; owned by the lane worktree naming. */
  laneTargets(laneId: string): { worktreePath: string; branch: string };
}

/**
 * Freezes one context's launch fields into its start request. Pure. Agent and
 * workflow launches both resolve through here, so the same fields give the
 * same contract whichever way the context is launched.
 */
export function resolveContextStart(input: {
  request: AgentLaunchRequest;
  key: string;
  placement: LaunchPlacement;
  scope: WorkspaceScope;
  seats: { implementer: ResolvedSeat; reviewers: ResolvedSeat[] };
  /** The selected checks this context leaves to later work on the assembled tree. */
  deferredChecks?: ReadonlySet<string>;
  /** The lane worktree and branch, for a context placed in a lane. */
  lane?: { worktreePath: string; branch: string };
}): ContextStartRequest {
  const { request, seats, placement } = input;
  const reviewerRequests = request.reviewers ?? [];
  if (reviewerRequests.length !== seats.reviewers.length) {
    throw new Error(
      `Resolved ${seats.reviewers.length} reviewer seats for ${reviewerRequests.length} requested reviewers`,
    );
  }
  const deferred = input.deferredChecks ?? new Set<string>();
  const selected = request.checks ?? [];
  const contract = contextContractSchema.parse({
    title: titleOf(request),
    brief: request.brief,
    tasks: (request.tasks ?? []).map((task, index) => ({
      id: `t${index + 1}`,
      ...task,
    })),
    acceptanceCriteria: (request.acceptanceCriteria ?? []).map(
      (text, index) => ({ id: `ac-${index + 1}`, text }),
    ),
    outputSchema: request.outputSchema ?? null,
    allowTaskAddition: true,
    implementer: {
      id: "implementer",
      profile: request.profile ?? STANDARD_AGENT,
      ...seats.implementer,
    },
    reviewers: reviewerRequests.map((reviewer, index) => ({
      id: `reviewer-${index + 1}`,
      authority: reviewer.authority,
      ...(reviewer.focus !== undefined ? { focus: reviewer.focus } : {}),
      profile: reviewer.profile ?? GENERAL_REVIEWER,
      ...seats.reviewers[index],
    })),
    checks: selected.filter((command) => !deferred.has(command)),
    deferredChecks: selected.filter((command) => deferred.has(command)),
    inputs: [],
    humanApproval: request.humanApproval ?? false,
    ownerQuestions: request.ownerQuestions ?? true,
    documents: [],
  });
  return {
    contextId: `${placement.runId}.${input.key}`,
    runId: placement.runId,
    ownerConversationId: placement.owner.conversationId,
    workspace:
      input.lane === undefined
        ? {
            kind: "session",
            projectPath: placement.projectPath,
            sessionName: placement.session.sessionName,
            worktreePath: placement.session.worktreePath,
            scope: input.scope,
          }
        : {
            kind: "lane",
            projectPath: placement.projectPath,
            sessionName: placement.session.sessionName,
            worktreePath: input.lane.worktreePath,
            branch: input.lane.branch,
            scope: input.scope,
          },
    contract,
    policy: {
      ...DEFAULT_CONTEXT_POLICY,
      invocationTimeoutMs: request.timeoutMs ?? null,
    },
  };
}

/** Freezes a standalone agent launch into one session-placed Context. Pure. */
export function resolveAgentLaunch(
  input: LaunchPlacement & {
    request: AgentLaunchRequest;
    seats: { implementer: ResolvedSeat; reviewers: ResolvedSeat[] };
  },
): RunLaunchInput {
  return {
    runId: input.runId,
    cause: input.cause,
    kind: "agent",
    title: titleOf(input.request),
    projectPath: input.projectPath,
    sessionName: input.session.sessionName,
    owner: input.owner,
    contexts: [
      {
        key: "agent",
        dependsOn: [],
        request: resolveContextStart({
          request: input.request,
          key: "agent",
          placement: input,
          scope: { mode: "full" },
          seats: input.seats,
        }),
      },
    ],
  };
}
