/**
 * Agent-facing Run endpoints for the shared supervision path.
 *
 * - GET  /api/projects/[name]/sessions/[session]/runs                → the session's runs, newest first
 * - POST /api/projects/[name]/sessions/[session]/runs                → launch an agent run
 * - POST /api/projects/[name]/sessions/[session]/runs/workflow       → launch a workflow run
 * - GET  /api/projects/[name]/sessions/[session]/runs/[runId]        → the run view
 * - GET  /api/projects/[name]/sessions/[session]/runs/[runId]/page  → the run as the run page shows it
 * - GET  /api/projects/[name]/sessions/[session]/runs/[runId]/definition → the workflow as written
 * - POST /api/projects/[name]/sessions/[session]/runs/[runId]/answer → answer a seat's question
 * - POST /api/projects/[name]/sessions/[session]/runs/[runId]/control → pause | resume | cancel | retry (a lane) (owner or person)
 * - POST /api/projects/[name]/sessions/[session]/runs/[runId]/amend  → replace a workflow's definition (owner)
 * - POST /api/projects/[name]/sessions/[session]/runs/[runId]/decide → human approval decision (people only)
 * - POST /api/projects/[name]/sessions/[session]/contexts/tasks      → a seat's task command
 * - POST /api/projects/[name]/sessions/[session]/contexts/documents  → a seat publishes a run document
 *
 * The calling conversation is the principal: it owns the runs it launches, and
 * only the owner answers or amends them. A person in Command Center, whose
 * request carries no agent credential, reads and steers runs beside their
 * owners and alone decides human approval. A seat conversation changes tasks,
 * and publishes documents, only for the Context its seat binding names.
 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CONVERSATION_IDENTITY_HEADER,
  readConversationIdentity,
} from "@/lib/agent-gateway/conversation-identity";
import { LANE_IDENTITY_HEADER } from "@/lib/agent-gateway/lane-identity";
import type { AgentAuth } from "@/lib/agent-gateway/token";
import { isContextRefusal } from "@/lib/execution-context/advance";
import { haltDispositionSchema } from "@/lib/execution-context/schemas";
import type { Logger } from "@/lib/logging";
import {
  jsonError,
  notFound,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import {
  agentLaunchRequestSchema,
  resolveAgentLaunch,
  type AgentLaunchRequest,
  type LaunchPlacement,
  type ResolvedSeat,
} from "./launch";
import { amendmentIssuesOf, isRunRefusal, type RunLaunchInput } from "./host";
import { describeRun } from "./observation";
import { frozenKeys, writtenEntry } from "./amendment";
import type {
  RunCharter,
  RunDefinitionContext,
  RunDocumentRevision,
  RunPrincipal,
  RunRecord,
} from "./schemas";
import {
  withCurrentDocuments,
  type DocumentIssue,
  type ProposedDocument,
  type RunDocumentRequest,
} from "./documents";
import type { FrozenCharter } from "./charter";
import {
  runPage,
  runSummary,
  type ConversationFacts,
  type RunPageSources,
} from "./page";
import type { Supervision } from "@/lib/supervision/supervision";
import {
  compileWorkflow,
  workflowContextRequestSchema,
  workflowLaunchRequestSchema,
  withoutDocuments,
  type WorkflowLaunchRequest,
} from "./workflow-definition";

type RouteContext = { params: Promise<Record<string, string>> };
type Handler = (request: Request, context: RouteContext) => Promise<Response>;

export interface RunRouteDeps {
  auth: Pick<AgentAuth, "requireToken" | "validateOptionalToken">;
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{
    sessionName: string;
    worktreePath: string;
    branchName: string;
    conversations: Array<{ id: string }>;
  } | null>;
  /** Where this session's lanes live, by lane id, as the lane worktree naming decides. */
  laneTargets(input: {
    projectPath: string;
    sessionWorktreePath: string;
  }): Promise<LaunchPlacement["laneTargets"]>;
  supervision(): Supervision;
  /** Whether the subscription inbox can wake this conversation, which is how a run's owner hears from it. */
  ownerWakeable(projectPath: string, conversationId: string): Promise<boolean>;
  /** Backend, model selection and admission for every seat the launch names. */
  resolveSeats(input: {
    projectPath: string;
    request: AgentLaunchRequest;
  }): Promise<
    | {
        ok: true;
        seats: { implementer: ResolvedSeat; reviewers: ResolvedSeat[] };
      }
    | { ok: false; status: number; error: string; code?: string }
  >;
  newRunId(): string;
  /**
   * Freezes a launch's or amendment's documents as artifacts, reading each
   * `from` file in the session worktree; a kept revision takes its bytes
   * from `current`, the run's revisions.
   */
  snapshotDocuments(
    requests: readonly RunDocumentRequest[],
    worktreePath: string,
    current?: readonly RunDocumentRevision[],
  ): Promise<
    | { ok: true; documents: ProposedDocument[] }
    | { ok: false; issues: DocumentIssue[] }
  >;
  /** Freezes a file a seat publishes, read inside its working directory, with its path relative to it. */
  snapshotFile(
    worktreePath: string,
    file: string,
  ): Promise<
    | { ok: true; path: string; artifactId: string; bytes: number }
    | { ok: false; message: string }
  >;
  /** Renders and freezes the charter's bundles. */
  freezeCharter(charter: RunCharter): Promise<FrozenCharter>;
  /** The session's conversations by id, as the run page names them: the owners and every seat. */
  sessionConversations(
    projectPath: string,
    sessionName: string,
  ): Promise<ReadonlyMap<string, ConversationFacts>>;
  /** A frozen document's text. */
  readText(artifactId: string): Promise<string>;
  /** What a candidate changed, from its Workspace evidence; null when that cannot be read now. */
  candidateChanges: RunPageSources["candidateChanges"];
  log: Pick<Logger, "info" | "warn" | "error">;
}

const answerSchema = z
  .object({ questionId: z.string().min(1), text: z.string().min(1) })
  .strict();
const controlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }).strict(),
  z
    .object({
      action: z.literal("resume"),
      dispositions: z
        .array(
          z
            .object({
              contextId: z.string().min(1),
              occurrence: z.string().min(1),
              disposition: haltDispositionSchema,
            })
            .strict(),
        )
        .optional(),
    })
    .strict(),
  z.object({ action: z.literal("cancel") }).strict(),
  z.object({ action: z.literal("retry"), lane: z.string().min(1) }).strict(),
]);
const decideSchema = z
  .object({
    contextId: z.string().min(1),
    candidateId: z.string().min(1),
    decision: z.enum(["approved", "rejected"]),
    notes: z.string().min(1).optional(),
  })
  .strict();
const amendSchema = z
  .object({
    definition: workflowLaunchRequestSchema,
    /** The definition revision the proposal was made from. */
    basedOn: z.number().int().min(1).optional(),
    /** Why, recorded with the charter revision the amendment makes. */
    reason: z.string().trim().min(1).optional(),
  })
  .strict();
const publishDocumentSchema = z
  .object({
    /** A file in the seat's working directory. */
    file: z.string().min(1),
    /** The document's path among the run's documents; the file's path when absent. */
    as: z.string().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    readWhen: z.string().trim().min(1).optional(),
  })
  .strict();
const taskCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("complete"), taskId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("reopen"), taskId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("add"),
      taskId: z.string().min(1),
      title: z.string().min(1),
      instructions: z.string().min(1).optional(),
    })
    .strict(),
]);

/** Refusals the Run or a Context reports without changing anything; anything else is a fault. */
function isRefusal(error: unknown): error is Error {
  return isRunRefusal(error) || isContextRefusal(error);
}

/** The project and session a request reads, with the session's branch. */
interface Place {
  projectPath: string;
  sessionName: string;
  branch: string;
}

interface Caller {
  projectPath: string;
  sessionName: string;
  worktreePath: string;
  branch: string;
  conversationId: string;
}

async function readBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  what: string,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: jsonError("Request body must be JSON", 400) };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    response: NextResponse.json(
      {
        error: `Invalid ${what}`,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    ),
  };
}

/** A launch's documents, frozen; or the refusal that names each one that cannot be. */
async function freezeDocuments(
  deps: Pick<RunRouteDeps, "snapshotDocuments">,
  requests: readonly RunDocumentRequest[] | undefined,
  worktreePath: string,
  current?: readonly RunDocumentRevision[],
): Promise<
  | { ok: true; documents: ProposedDocument[] }
  | { ok: false; response: Response }
> {
  if (requests === undefined || requests.length === 0)
    return { ok: true, documents: [] };
  const frozen = await deps.snapshotDocuments(requests, worktreePath, current);
  if (frozen.ok) return frozen;
  return {
    ok: false,
    response: NextResponse.json(
      {
        error: "Invalid documents",
        issues: frozen.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    ),
  };
}

export function createRunRouteHandlers(
  deps: RunRouteDeps,
): Record<
  | "launch"
  | "launchWorkflow"
  | "show"
  | "definition"
  | "answer"
  | "control"
  | "amend"
  | "decide"
  | "tasks"
  | "publishDocument"
  | "list"
  | "page",
  Handler
> {
  /** Token, session and a verified calling conversation of that session. */
  async function resolveCaller(
    request: Request,
    context: RouteContext,
  ): Promise<{ ok: true; caller: Caller } | { ok: false; response: Response }> {
    const denied = await deps.auth.requireToken(request);
    if (denied) return { ok: false, response: denied };
    const { name, session } = await context.params;
    const resolved = await resolveProjectSessionOr404(
      deps,
      name ?? "",
      session ?? "",
    );
    if (!resolved.ok) return resolved;
    const { projectPath, session: sessionState } = resolved.value;
    const identity = readConversationIdentity(
      request.headers.get(CONVERSATION_IDENTITY_HEADER),
    );
    if (
      identity.kind !== "valid" ||
      identity.scope.sessionName !== sessionState.sessionName ||
      !sessionState.conversations.some(
        (conversation) => conversation.id === identity.scope.conversationId,
      )
    ) {
      return {
        ok: false,
        response: jsonError(
          "Runs are launched and steered by a conversation of this session",
          403,
          "conversation_identity_required",
          undefined,
          "Run this command from an agent conversation in the session.",
        ),
      };
    }
    return {
      ok: true,
      caller: {
        projectPath,
        sessionName: sessionState.sessionName,
        worktreePath: sessionState.worktreePath,
        branch: sessionState.branchName,
        conversationId: identity.scope.conversationId,
      },
    };
  }

  function amendmentRefused(
    runId: string,
    issues: readonly string[],
  ): Response {
    deps.log.warn("runs.amendment_refused", { runId, issues: issues.length });
    return NextResponse.json(
      {
        error: `The amendment changes work that already happened (${issues.length} ${issues.length === 1 ? "change" : "changes"})`,
        code: "amendment_refused",
        issues: issues.map((message) => ({ path: "definition", message })),
      },
      { status: 409 },
    );
  }

  /** The run, when it belongs to this session; any other id reads as not found. */
  function runInSession(
    runId: string | undefined,
    place: { projectPath: string; sessionName: string },
  ): { ok: true; run: RunRecord } | { ok: false; response: Response } {
    const run = deps.supervision().runs.observe(runId ?? "")?.record ?? null;
    if (
      run === null ||
      run.projectPath !== place.projectPath ||
      run.sessionName !== place.sessionName
    )
      return { ok: false, response: notFound(`Run "${runId}" not found`) };
    return { ok: true, run };
  }

  /** The caller's own run in this session; anyone else gets a refusal naming the owner. */
  async function resolveOwnedRun(
    request: Request,
    context: RouteContext,
  ): Promise<
    | { ok: true; caller: Caller; run: RunRecord }
    | { ok: false; response: Response }
  > {
    const resolved = await resolveCaller(request, context);
    if (!resolved.ok) return resolved;
    const { runId } = await context.params;
    const found = runInSession(runId, resolved.caller);
    if (!found.ok) return found;
    const { run } = found;
    if (run.ownerConversationId !== resolved.caller.conversationId) {
      return {
        ok: false,
        response: jsonError(
          `Only the conversation that launched run ${run.runId} can steer it`,
          403,
          "not_run_owner",
          { ownerConversationId: run.ownerConversationId },
        ),
      };
    }
    return { ok: true, caller: resolved.caller, run };
  }

  /**
   * Whether an agent or a person sent the request. Agents present a token or
   * an identity; a request with no agent credential at all comes from a
   * person in Command Center.
   */
  async function senderOf(
    request: Request,
  ): Promise<{ ok: true; sender: "agent" | "person" } | { ok: false; response: Response }> {
    const transport = await deps.auth.validateOptionalToken(request);
    if (transport.kind === "invalid")
      return { ok: false, response: jsonError("Invalid token", 401) };
    const agent =
      transport.kind === "valid" ||
      request.headers.has(CONVERSATION_IDENTITY_HEADER) ||
      request.headers.has(LANE_IDENTITY_HEADER);
    return { ok: true, sender: agent ? "agent" : "person" };
  }

  /** The run the route names, when it belongs to the route's session. */
  async function sessionRun(
    context: RouteContext,
  ): Promise<{ ok: true; run: RunRecord } | { ok: false; response: Response }> {
    const { name, session, runId } = await context.params;
    const resolved = await resolveProjectSessionOr404(
      deps,
      name ?? "",
      session ?? "",
    );
    if (!resolved.ok) return resolved;
    return runInSession(runId, {
      projectPath: resolved.value.projectPath,
      sessionName: resolved.value.session.sessionName,
    });
  }

  /** A run of this session, for a request no agent credential may make. */
  async function resolvePersonRun(
    request: Request,
    context: RouteContext,
    refusal: string,
    hint: string,
  ): Promise<{ ok: true; run: RunRecord } | { ok: false; response: Response }> {
    const sent = await senderOf(request);
    if (!sent.ok) return sent;
    if (sent.sender === "agent")
      return {
        ok: false,
        response: jsonError(
          refusal,
          403,
          "human_decision_required",
          undefined,
          hint,
        ),
      };
    return sessionRun(context);
  }

  /** A run its owner conversation, or a person, steers; any other agent is refused. */
  async function resolveSteeredRun(
    request: Request,
    context: RouteContext,
  ): Promise<
    | { ok: true; run: RunRecord; by: RunPrincipal }
    | { ok: false; response: Response }
  > {
    const sent = await senderOf(request);
    if (!sent.ok) return sent;
    if (sent.sender === "person") {
      const found = await sessionRun(context);
      return found.ok ? { ...found, by: "person" } : found;
    }
    const owned = await resolveOwnedRun(request, context);
    return owned.ok ? { ok: true, run: owned.run, by: "owner" } : owned;
  }

  /** The session, for a reader: a person, or any of the session's conversations. */
  async function resolveSessionReader(
    request: Request,
    context: RouteContext,
  ): Promise<{ ok: true; place: Place } | { ok: false; response: Response }> {
    const sent = await senderOf(request);
    if (!sent.ok) return sent;
    if (sent.sender === "agent") {
      const resolved = await resolveCaller(request, context);
      if (!resolved.ok) return resolved;
      const { projectPath, sessionName, branch } = resolved.caller;
      return { ok: true, place: { projectPath, sessionName, branch } };
    }
    const { name, session } = await context.params;
    const resolved = await resolveProjectSessionOr404(
      deps,
      name ?? "",
      session ?? "",
    );
    if (!resolved.ok) return resolved;
    return {
      ok: true,
      place: {
        projectPath: resolved.value.projectPath,
        sessionName: resolved.value.session.sessionName,
        branch: resolved.value.session.branchName,
      },
    };
  }

  /** A run of this session, read by any of its conversations or by a person. */
  async function resolveReadRun(
    request: Request,
    context: RouteContext,
  ): Promise<
    | { ok: true; run: RunRecord; place: Place }
    | { ok: false; response: Response }
  > {
    const reader = await resolveSessionReader(request, context);
    if (!reader.ok) return reader;
    const { runId } = await context.params;
    const found = runInSession(runId, reader.place);
    return found.ok ? { ...found, place: reader.place } : found;
  }

  /** What the run page reads, for one session. */
  async function pageSources(place: Place): Promise<RunPageSources> {
    return {
      supervision: deps.supervision(),
      conversations: await deps.sessionConversations(
        place.projectPath,
        place.sessionName,
      ),
      sessionBranch: place.branch,
      readText: (artifactId) => deps.readText(artifactId),
      candidateChanges: (input) => deps.candidateChanges(input),
    };
  }

  function refuseWorkflow(
    caller: Caller,
    definition: WorkflowLaunchRequest,
  ): Response | null {
    return refuseLaunch(
      caller,
      definition.contexts.some((c) => c.humanApproval === true),
    );
  }

  /**
   * Each context's own seats, or the refusal naming the context whose seat
   * cannot be resolved. A context kept as it started (`kept`) keeps the seats
   * it was admitted with: its work happened, and is not admitted again.
   */
  async function workflowSeats(
    caller: Caller,
    definition: WorkflowLaunchRequest,
    kept: ReadonlyMap<string, RunDefinitionContext> = new Map(),
  ): Promise<
    | {
        ok: true;
        seats: Record<
          string,
          { implementer: ResolvedSeat; reviewers: ResolvedSeat[] }
        >;
      }
    | { ok: false; response: Response }
  > {
    const seats: Record<
      string,
      { implementer: ResolvedSeat; reviewers: ResolvedSeat[] }
    > = {};
    for (const contextRequest of definition.contexts) {
      const frozen = kept.get(contextRequest.key);
      if (frozen !== undefined) {
        const { implementer, reviewers } = frozen.request.contract;
        const seatOf = ({ backend, modelSelection }: ResolvedSeat) => ({
          backend,
          modelSelection,
        });
        seats[contextRequest.key] = {
          implementer: seatOf(implementer),
          reviewers: reviewers.map(seatOf),
        };
        continue;
      }
      const resolvedSeats = await deps.resolveSeats({
        projectPath: caller.projectPath,
        request: contextRequest,
      });
      if (!resolvedSeats.ok)
        return {
          ok: false,
          response: seatFailure(resolvedSeats, contextRequest.key),
        };
      seats[contextRequest.key] = resolvedSeats.seats;
    }
    return { ok: true, seats };
  }

  /** Refusals that apply to every launch or amendment, whatever it starts. */
  function refuseLaunch(
    caller: Caller,
    humanApproval: boolean,
  ): Response | null {
    if (humanApproval) {
      return jsonError(
        "Human approval is not available for agent runs yet: no Command Center surface lets Alex make the decision",
        400,
        "human_approval_unavailable",
        undefined,
        "Launch without humanApproval and review the result yourself, or ask Alex.",
      );
    }
    // A seat's child would bind the workspace the seat's own context holds and
    // wait for it, while the seat waits for the child.
    if (deps.supervision().core.seatBinding(caller.conversationId) !== null) {
      return jsonError(
        "A supervised seat cannot launch runs",
        403,
        "seat_cannot_launch",
        undefined,
        "Finish your assigned work, or ask your owner with cctl ask.",
      );
    }
    return null;
  }

  /** A run's questions, halts and result reach its owner only as inbox wakes. */
  async function refuseUnwakeableOwner(
    caller: Caller,
  ): Promise<Response | null> {
    if (await deps.ownerWakeable(caller.projectPath, caller.conversationId))
      return null;
    return jsonError(
      "This conversation cannot be woken by the subscription inbox, so a run's questions and result would never reach it",
      409,
      "owner_not_wakeable",
      undefined,
      "Launch the run from an ordinary, unarchived conversation that no other execution owns.",
    );
  }

  /** A seat resolution refusal; a workflow's names the context it belongs to. */
  function seatFailure(
    failure: { status: number; error: string; code?: string },
    contextKey?: string,
  ): Response {
    return NextResponse.json(
      {
        error:
          contextKey === undefined
            ? failure.error
            : `Context "${contextKey}": ${failure.error}`,
        ...(failure.code !== undefined ? { code: failure.code } : {}),
        ...(contextKey !== undefined ? { context: contextKey } : {}),
      },
      { status: failure.status },
    );
  }

  async function startLaunch(
    caller: Caller,
    launch: RunLaunchInput,
  ): Promise<Response> {
    const record = await deps.supervision().runs.launch(launch);
    deps.log.info("runs.launched", {
      runId: launch.runId,
      kind: launch.kind,
      contexts: launch.contexts.length,
      sessionName: caller.sessionName,
      conversationId: caller.conversationId,
    });
    return NextResponse.json(
      {
        runId: launch.runId,
        contextIds: launch.contexts.map((context) => context.request.contextId),
        progress: record.progress,
      },
      { status: 202 },
    );
  }

  /** The workflow's charter with its bundles frozen, or none. */
  const freezeWorkflowCharter = async (
    workflow: WorkflowLaunchRequest,
  ): Promise<FrozenCharter | undefined> =>
    workflow.charter === undefined
      ? undefined
      : deps.freezeCharter(workflow.charter);

  const placementOf = async (
    caller: Caller,
    runId: string,
  ): Promise<LaunchPlacement> => ({
    runId,
    cause: `launch:${runId}`,
    projectPath: caller.projectPath,
    session: {
      sessionName: caller.sessionName,
      worktreePath: caller.worktreePath,
      branch: caller.branch,
    },
    owner: {
      conversationId: caller.conversationId,
      sessionName: caller.sessionName,
    },
    laneTargets: await deps.laneTargets({
      projectPath: caller.projectPath,
      sessionWorktreePath: caller.worktreePath,
    }),
  });

  return {
    async launch(request, context) {
      const resolved = await resolveCaller(request, context);
      if (!resolved.ok) return resolved.response;
      const body = await readBody(
        request,
        agentLaunchRequestSchema,
        "agent run launch",
      );
      if (!body.ok) return body.response;
      const { caller } = resolved;
      const refused =
        refuseLaunch(caller, body.value.humanApproval === true) ??
        (await refuseUnwakeableOwner(caller));
      if (refused !== null) return refused;
      const seats = await deps.resolveSeats({
        projectPath: caller.projectPath,
        request: body.value,
      });
      if (!seats.ok) return seatFailure(seats);
      const documents = await freezeDocuments(
        deps,
        body.value.documents,
        caller.worktreePath,
      );
      if (!documents.ok) return documents.response;
      const runId = deps.newRunId();
      return startLaunch(
        caller,
        resolveAgentLaunch({
          ...(await placementOf(caller, runId)),
          request: body.value,
          seats: seats.seats,
          documents: documents.documents,
        }),
      );
    },

    async launchWorkflow(request, context) {
      const resolved = await resolveCaller(request, context);
      if (!resolved.ok) return resolved.response;
      const body = await readBody(
        request,
        workflowLaunchRequestSchema,
        "workflow run launch",
      );
      if (!body.ok) return body.response;
      const { caller } = resolved;
      const refused =
        refuseWorkflow(caller, body.value) ??
        (await refuseUnwakeableOwner(caller));
      if (refused !== null) return refused;
      const seats = await workflowSeats(caller, body.value);
      if (!seats.ok) return seats.response;
      const documents = await freezeDocuments(
        deps,
        body.value.documents,
        caller.worktreePath,
      );
      if (!documents.ok) return documents.response;
      const charter = await freezeWorkflowCharter(body.value);
      const runId = deps.newRunId();
      return startLaunch(
        caller,
        compileWorkflow({
          ...(await placementOf(caller, runId)),
          request: body.value,
          seats: seats.seats,
          documents: documents.documents,
          ...(charter !== undefined ? { charter } : {}),
        }),
      );
    },

    async amend(request, context) {
      const owned = await resolveOwnedRun(request, context);
      if (!owned.ok) return owned.response;
      const body = await readBody(request, amendSchema, "workflow amendment");
      if (!body.ok) return body.response;
      const { caller, run } = owned;
      const proposed = body.value.definition;
      const refused = refuseWorkflow(caller, proposed);
      if (refused !== null) return refused;
      // Started work is compiled as its owner first wrote it, with the seats it started with; the
      // amendment then compares the proposal as written and names every change started work forbids.
      const frozen = frozenKeys(run.facts);
      const kept = new Map(
        run.facts.definition.contexts
          .filter((c) => frozen.has(c.key))
          .map((c) => [c.key, c]),
      );
      const asStarted = {
        ...proposed,
        contexts: proposed.contexts.map((context) => {
          const written = kept.has(context.key)
            ? writtenEntry(run.facts.definition.authored, context.key)
            : null;
          return written === null
            ? context
            : workflowContextRequestSchema.parse(written);
        }),
      };
      const seats = await workflowSeats(caller, asStarted, kept);
      if (!seats.ok) return seats.response;
      // Every document is declared again: kept by its revision, or read anew.
      const documents = await freezeDocuments(
        deps,
        proposed.documents,
        caller.worktreePath,
        run.facts.documents,
      );
      if (!documents.ok) return documents.response;
      const charter = await freezeWorkflowCharter(proposed);
      const compiled = compileWorkflow({
        ...(await placementOf(caller, run.runId)),
        existingLanes: run.facts.definition.lanes ?? [],
        request: asStarted,
        seats: seats.seats,
      });
      const runs = deps.supervision().runs;
      let removedDocuments: string[];
      try {
        ({ removedDocuments } = await runs.amend(run.runId, {
          definition: {
            title: compiled.title,
            contexts: compiled.contexts,
            ...(compiled.loops !== undefined ? { loops: compiled.loops } : {}),
            ...(compiled.lanes !== undefined ? { lanes: compiled.lanes } : {}),
            authored: withoutDocuments(proposed),
            documents: documents.documents,
            ...(charter !== undefined ? { charter } : {}),
          },
          basedOn: body.value.basedOn ?? null,
          ...(body.value.reason !== undefined
            ? { reason: body.value.reason }
            : {}),
        }));
      } catch (error) {
        const issues = amendmentIssuesOf(error);
        if (issues !== null) return amendmentRefused(run.runId, issues);
        if (!isRefusal(error)) throw error;
        deps.log.warn("runs.amendment_refused", {
          runId: run.runId,
          error: error.message,
        });
        return jsonError(error.message, 409, "run_control_refused");
      }
      const amended = runs.observe(run.runId)?.record;
      return NextResponse.json({
        ok: true,
        revision: amended?.facts.definition.revision ?? 0,
        progress: amended?.progress ?? null,
        halts:
          runs.inspect(run.runId)?.plan.halts.map((halt) => halt.reason) ?? [],
        // A document a seat published while the owner wrote the amendment may be among them; say so.
        removedDocuments,
      });
    },

    async list(request, context) {
      const reader = await resolveSessionReader(request, context);
      if (!reader.ok) return reader.response;
      const { projectPath, sessionName } = reader.place;
      const sources = await pageSources(reader.place);
      return NextResponse.json(
        deps
          .supervision()
          .runs.listSession(projectPath, sessionName)
          .map((record) => runSummary(sources, record)),
      );
    },

    async page(request, context) {
      const found = await resolveReadRun(request, context);
      if (!found.ok) return found.response;
      const { runId } = found.run;
      const page = await runPage(await pageSources(found.place), runId);
      if (page === null) return notFound(`Run "${runId}" not found`);
      return NextResponse.json(page);
    },

    async show(request, context) {
      const found = await resolveReadRun(request, context);
      if (!found.ok) return found.response;
      const { runId } = found.run;
      const view = describeRun(deps.supervision(), runId);
      if (view === null) return notFound(`Run "${runId}" not found`);
      return NextResponse.json(view);
    },

    async definition(request, context) {
      const found = await resolveReadRun(request, context);
      if (!found.ok) return found.response;
      const { run } = found;
      return NextResponse.json({
        runId: run.runId,
        revision: run.facts.definition.revision,
        definition:
          run.facts.definition.authored === undefined
            ? null
            : withCurrentDocuments(
                run.facts.definition.authored,
                run.facts.documents,
              ),
      });
    },

    async answer(request, context) {
      const owned = await resolveOwnedRun(request, context);
      if (!owned.ok) return owned.response;
      const body = await readBody(request, answerSchema, "answer");
      if (!body.ok) return body.response;
      const supervision = deps.supervision();
      const question = supervision.requests.question(body.value.questionId);
      const seat =
        question === null
          ? null
          : supervision.core.seatBinding(question.conversationId);
      const belongs =
        seat !== null &&
        owned.run.facts.invocations.some((i) => i.contextId === seat.contextId);
      if (!belongs)
        return notFound(
          `Question "${body.value.questionId}" is not open in run ${owned.run.runId}`,
        );
      if (
        !supervision.requests.answer(body.value.questionId, body.value.text)
      ) {
        return jsonError(
          `Question "${body.value.questionId}" is no longer open`,
          409,
          "question_closed",
        );
      }
      deps.log.info("runs.question_answered", {
        runId: owned.run.runId,
        questionId: body.value.questionId,
      });
      return NextResponse.json({ ok: true });
    },

    // The owner steers its run, and so does a person in Command Center.
    async control(request, context) {
      const steered = await resolveSteeredRun(request, context);
      if (!steered.ok) return steered.response;
      const body = await readBody(request, controlSchema, "run control");
      if (!body.ok) return body.response;
      const runs = deps.supervision().runs;
      const { run, by } = steered;
      const { runId } = run;
      // Neither the CLI nor the page holds a revision, so the act applies to the run as it is now.
      try {
        if (body.value.action === "pause") await runs.pause(runId, by);
        if (body.value.action === "resume")
          await runs.resume(runId, by, body.value.dispositions ?? []);
        if (body.value.action === "cancel") await runs.cancel(runId, by);
        if (body.value.action === "retry")
          await runs.retryLane(runId, by, body.value.lane);
      } catch (error) {
        if (!isRefusal(error)) throw error;
        deps.log.warn("runs.control_refused", {
          runId,
          action: body.value.action,
          by,
          error: error.message,
        });
        return jsonError(error.message, 409, "run_control_refused");
      }
      deps.log.info("runs.control_applied", {
        runId,
        action: body.value.action,
        by,
      });
      return NextResponse.json({
        ok: true,
        progress: runs.observe(runId)?.record.progress ?? null,
      });
    },

    // Human approval is a person's decision: no agent credential may make it,
    // including the run's owner (design §5.5, §7.7).
    async decide(request, context) {
      const person = await resolvePersonRun(
        request,
        context,
        "Only a person decides a result awaiting human approval",
        "Tell Alex the run, context and candidate awaiting the decision; agents cannot approve it.",
      );
      if (!person.ok) return person.response;
      const { run } = person;
      const body = await readBody(request, decideSchema, "approval decision");
      if (!body.ok) return body.response;
      const { contextId, ...decision } = body.value;
      try {
        deps.supervision().runs.decide(run.runId, contextId, decision);
      } catch (error) {
        if (!isRefusal(error)) throw error;
        deps.log.warn("runs.decision_refused", {
          runId: run.runId,
          contextId,
          error: error.message,
        });
        return jsonError(error.message, 409, "decision_refused");
      }
      deps.log.info("runs.decision_recorded", {
        runId: run.runId,
        contextId,
        decision: decision.decision,
      });
      return NextResponse.json({ ok: true });
    },

    async tasks(request, context) {
      const resolved = await resolveCaller(request, context);
      if (!resolved.ok) return resolved.response;
      const body = await readBody(request, taskCommandSchema, "task command");
      if (!body.ok) return body.response;
      const supervision = deps.supervision();
      const seat = supervision.core.seatBinding(resolved.caller.conversationId);
      if (seat === null) {
        return jsonError(
          "Only a supervised seat conversation changes its context's tasks",
          403,
          "not_a_seat",
        );
      }
      const result = supervision.contexts.applyTaskCommand(
        seat.contextId,
        seat,
        body.value,
      );
      if (result.kind === "refused")
        return jsonError(result.reason, 409, "task_command_refused");
      return NextResponse.json({ ok: true, contextId: seat.contextId });
    },

    async publishDocument(request, context) {
      const resolved = await resolveCaller(request, context);
      if (!resolved.ok) return resolved.response;
      const body = await readBody(
        request,
        publishDocumentSchema,
        "document publication",
      );
      if (!body.ok) return body.response;
      const supervision = deps.supervision();
      const seat = supervision.core.seatBinding(resolved.caller.conversationId);
      if (seat === null)
        return jsonError(
          "Only a supervised seat conversation publishes its run's documents",
          403,
          "not_a_seat",
        );
      const workplace = supervision.contexts.implementerWorkplace(
        seat.contextId,
        seat,
      );
      if (workplace.kind === "refused")
        return jsonError(workplace.reason, 409, "document_publish_refused");
      const frozen = await deps.snapshotFile(
        workplace.worktreePath,
        body.value.file,
      );
      if (!frozen.ok) return jsonError(frozen.message, 400, "invalid_document");
      // The seat may have been replaced, or its context finished, while the file was read; nothing awaits from here.
      const still = supervision.contexts.implementerWorkplace(
        seat.contextId,
        seat,
      );
      if (still.kind === "refused")
        return jsonError(still.reason, 409, "document_publish_refused");
      const documentPath = body.value.as ?? frozen.path;
      let published: { revision: number; unchanged: boolean };
      try {
        published = supervision.runs.publishDocument(workplace.runId, {
          path: documentPath,
          artifactId: frozen.artifactId,
          bytes: frozen.bytes,
          ...(body.value.description !== undefined
            ? { description: body.value.description }
            : {}),
          ...(body.value.readWhen !== undefined
            ? { readWhen: body.value.readWhen }
            : {}),
          by: seat.contextId,
        });
      } catch (error) {
        if (!isRefusal(error)) throw error;
        deps.log.warn("runs.document_publish_refused", {
          runId: workplace.runId,
          contextId: seat.contextId,
          error: error.message,
        });
        return jsonError(error.message, 409, "document_publish_refused");
      }
      return NextResponse.json({
        ok: true,
        runId: workplace.runId,
        path: documentPath,
        ...published,
      });
    },
  };
}

export const newRunId = (): string => `run-${randomUUID()}`;
