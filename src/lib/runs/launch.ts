import { z } from "zod";
import { agentProfileRefSchema } from "@/lib/agent-profiles/schemas";
import {
  backendModelSelectionSchema,
  type BackendModelSelection,
} from "@/lib/agent-backends/schemas";
import {
  DEFAULT_CONTEXT_POLICY,
  contextContractSchema,
  type ContextStartRequest,
} from "@/lib/execution-context/schemas";
import type { WorkspaceScope } from "@/lib/workspace/schemas";
import { validationCommandNameSchema } from "@/lib/validation/schemas";
import { agentBackendSchema, type AgentBackendId } from "@/lib/shared/schemas";
import type { RunLaunchInput } from "./host";
import { runDocumentRequestSchema } from "./documents";
import type { RunDocument } from "./schemas";
import {
  DEFAULT_REVIEWER_PROFILE,
  RUN_SETTING_DEFAULTS,
  reviewerSettingSchema,
  type RunSettingsRequestFields,
} from "./settings";

/** A reviewer seat as a launch names it; one without a profile runs under the default reviewer profile. */
const reviewerRequestSchema = reviewerSettingSchema.partial({ profile: true });

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
    /** Documents frozen at launch for the agent to read; see `runDocumentRequestSchema`. */
    documents: z
      .array(runDocumentRequestSchema.omit({ appliesTo: true, revision: true }))
      .optional(),
  })
  .strict();
export type AgentLaunchRequest = z.infer<typeof agentLaunchRequestSchema>;

// Settings map onto launch fields: these fail to compile when a mapped field
// leaves the request, or changes to a type the request does not accept.
const settingFieldsAreRequestFields: Exclude<
  keyof RunSettingsRequestFields,
  keyof AgentLaunchRequest
> extends never
  ? true
  : never = true;
const settingsFitTheRequest: RunSettingsRequestFields extends Partial<AgentLaunchRequest>
  ? true
  : never = true;
void settingFieldsAreRequestFields;
void settingsFitTheRequest;

/** A seat's backend and admitted model selection, resolved by the caller from configuration. */
export interface ResolvedSeat {
  backend: AgentBackendId;
  modelSelection: BackendModelSelection;
}

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
  /** The project's registered validation commands now, frozen for the implementers this placement adds. */
  validationCommands: readonly string[];
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
  /** Whether later work in its run could read what its implementer publishes. */
  documentPublishing?: boolean;
}): ContextStartRequest {
  const { request, seats, placement } = input;
  const reviewerRequests = request.reviewers ?? RUN_SETTING_DEFAULTS.reviewers;
  if (reviewerRequests.length !== seats.reviewers.length) {
    throw new Error(
      `Resolved ${seats.reviewers.length} reviewer seats for ${reviewerRequests.length} requested reviewers`,
    );
  }
  const deferred = input.deferredChecks ?? new Set<string>();
  const selected = request.checks ?? RUN_SETTING_DEFAULTS.checks;
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
      profile: request.profile ?? RUN_SETTING_DEFAULTS.implementer.profile,
      ...seats.implementer,
      validationAccess: [...placement.validationCommands],
    },
    // A reviewer judges a result whose context checks passed, and is shown them; it runs no suites of its own.
    reviewers: reviewerRequests.map((reviewer, index) => ({
      id: `reviewer-${index + 1}`,
      authority: reviewer.authority,
      ...(reviewer.focus !== undefined ? { focus: reviewer.focus } : {}),
      profile: reviewer.profile ?? DEFAULT_REVIEWER_PROFILE,
      ...seats.reviewers[index],
      validationAccess: [],
    })),
    checks: selected.filter((command) => !deferred.has(command)),
    deferredChecks: selected.filter((command) => deferred.has(command)),
    inputs: [],
    humanApproval: request.humanApproval ?? RUN_SETTING_DEFAULTS.humanApproval,
    ownerQuestions:
      request.ownerQuestions ?? RUN_SETTING_DEFAULTS.ownerQuestions,
    documents: [],
    documentPublishing: input.documentPublishing ?? false,
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
      invocationTimeoutMs: request.timeoutMs ?? RUN_SETTING_DEFAULTS.timeoutMs,
    },
  };
}

/** Freezes a standalone agent launch into one session-placed Context. Pure. */
export function resolveAgentLaunch(
  input: LaunchPlacement & {
    request: AgentLaunchRequest;
    seats: { implementer: ResolvedSeat; reviewers: ResolvedSeat[] };
    /** The launch's documents, already frozen. */
    documents?: RunDocument[];
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
    ...(input.documents !== undefined ? { documents: input.documents } : {}),
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
