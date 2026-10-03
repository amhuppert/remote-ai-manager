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
} from "@/lib/execution-context/schemas";
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

/** Freezes a standalone agent launch into one session-placed Context. Pure. */
export function resolveAgentLaunch(input: {
  request: AgentLaunchRequest;
  runId: string;
  cause: string;
  projectPath: string;
  session: { sessionName: string; worktreePath: string };
  owner: { conversationId: string; sessionName: string | null };
  seats: { implementer: ResolvedSeat; reviewers: ResolvedSeat[] };
}): RunLaunchInput {
  const { request, seats } = input;
  const reviewerRequests = request.reviewers ?? [];
  if (reviewerRequests.length !== seats.reviewers.length) {
    throw new Error(
      `Resolved ${seats.reviewers.length} reviewer seats for ${reviewerRequests.length} requested reviewers`,
    );
  }
  const title = titleOf(request);
  const contract = contextContractSchema.parse({
    title,
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
    checks: request.checks ?? [],
    humanApproval: request.humanApproval ?? false,
    ownerQuestions: request.ownerQuestions ?? true,
    documents: [],
  });
  return {
    runId: input.runId,
    cause: input.cause,
    kind: "agent",
    title,
    projectPath: input.projectPath,
    sessionName: input.session.sessionName,
    owner: input.owner,
    invocations: [
      {
        key: "agent",
        request: {
          contextId: `${input.runId}.agent`,
          runId: input.runId,
          ownerConversationId: input.owner.conversationId,
          workspace: {
            kind: "session",
            projectPath: input.projectPath,
            sessionName: input.session.sessionName,
            worktreePath: input.session.worktreePath,
            scope: { mode: "full" },
          },
          contract,
          policy: {
            ...DEFAULT_CONTEXT_POLICY,
            invocationTimeoutMs: request.timeoutMs ?? null,
          },
        },
      },
    ],
  };
}
