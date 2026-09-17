import { createTestGraphExecutionContract } from "@/lib/workflow-graph/testing/execution-contract";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createAgentAuth,
  ensureInstanceToken,
  _resetInstanceTokenCacheForTesting,
} from "@/lib/agent-gateway/token";
import {
  LANE_IDENTITY_HEADER,
  encodeLaneIdentity,
  readLaneIdentity as readLaneHeader,
} from "@/lib/agent-gateway/lane-identity";
import { validateWorkflowPlan } from "@/lib/workflows/plan-validation";
import { structuralWarningsOf } from "./pattern-plan-warnings";
import { workflowSemanticDefinitionSchema } from "../definition-schemas";
import { runEngineScenario } from "../compat/engine-harness";
import type {
  ContextStatusTransition,
  SchedulingDecision,
  TypedEventRecord,
} from "../compat/projections";
import { resolveUpstreamInputs } from "../context-outputs";
import {
  createGraphWorkflowExpansionService,
  expansionContextId,
  graphExpansionRequestSchema,
  type GraphExpansionRequest,
} from "../expansion-service";
import { resolveExpansionProvenance } from "../expansion-receipts";
import {
  expansionCanonicalPayload,
  expansionPayloadHash,
} from "../expansion-payload";
import {
  createLaneRouteHandlers,
  type LaneRouteDeps,
} from "../lane-route-handlers";
import { harnessLiveEditDeps } from "./pattern-live-edit-deps";
import type { GraphWorkflowExecution } from "../schemas";

/**
 * Pattern proof: Generate-And-Filter (R15.2).
 *
 * The claim under test is that a dynamic fan-out is an ORDINARY template — so
 * the graph comes from a real plan body admitted through the production
 * authoring path, and the expansion that creates the candidates goes through
 * the real lane route with a real signed capability, not through a direct call
 * to the service. Everything that decides control flow is production code; only
 * the agent turn, the validator verdict, and the git side effects are scripted.
 *
 * Follows the shape T19 set for Classify-And-Act (see
 * `.cc/graph-workflow-docs/pattern-proofs.md`): admit the template, execute it,
 * assert from durable state and events, and vary only the scripted judgment so
 * the assertions are load-bearing.
 */

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = path.join(moduleDir, "generate-and-filter.plan.json");

const GENERATOR = "context-generate";
const FILTER = "context-filter";
const REQUEST_ID = "expand-candidates-1";
const RATIONALE =
  "One candidate context per surveyed approach; the pre-declared filter picks the winner from their outputs.";

function readPlan(): unknown {
  return JSON.parse(readFileSync(PLAN_PATH, "utf8"));
}

function planDefinition() {
  const plan = readPlan();
  const definition =
    typeof plan === "object" && plan !== null && "definition" in plan
      ? (plan as { definition: unknown }).definition
      : undefined;
  return workflowSemanticDefinitionSchema.parse(definition);
}

interface Candidate {
  handle: string;
  approach: string;
  score: number;
}

const THREE_CANDIDATES: readonly Candidate[] = [
  { handle: "candidate-inline", approach: "inline projection", score: 9 },
  { handle: "candidate-cached", approach: "cached projection", score: 6 },
  { handle: "candidate-streamed", approach: "streamed projection", score: 3 },
];

/**
 * The payload the generator's lane posts. Every candidate gets an edge FROM the
 * invoker and an edge INTO the pre-declared filter — the second half is what
 * makes this Generate-And-Filter rather than an unbounded fan-out.
 *
 * `omitFilterEdges` drops that second half, which is the case the template's
 * guidance has to describe correctly: the engine refuses a context unreachable
 * FROM THE INVOKER, and a candidate with only the inbound edge is reachable, so
 * the omission is accepted and silently starves the filter instead.
 */
function expansionPayload(
  candidates: readonly Candidate[],
  options: { omitFilterEdges?: boolean } = {},
): GraphExpansionRequest {
  return graphExpansionRequestSchema.parse({
    requestId: REQUEST_ID,
    rationale: RATIONALE,
    contexts: candidates.map((candidate) => ({
      handle: candidate.handle,
      title: `Candidate: ${candidate.approach}`,
      acceptanceCriteria: `The ${candidate.approach} approach is implemented end to end and reports its own score.`,
      // Tournament candidates write the SAME paths by construction, so each one
      // keeps a single-member lane of its own — the case the spec names as the
      // reason concurrent same-lane sharing is a validation error rather than a
      // merge problem.
      placement: {
        lane: candidate.handle,
        mode: "owned",
        ownedPaths: [`src/${candidate.handle}`],
      },
      outputSchema: {
        type: "object",
        properties: {
          approach: { type: "string" },
          score: { type: "number", minimum: 0, maximum: 10 },
        },
        required: ["approach", "score"],
        additionalProperties: false,
      },
    })),
    tasks: candidates.map((candidate) => ({
      contextHandle: candidate.handle,
      title: `Build the ${candidate.approach} candidate`,
      instructions: `Implement the ${candidate.approach} approach against the brief and score it out of 10.`,
    })),
    edges: [
      ...candidates.map((candidate) => ({
        from: GENERATOR,
        to: candidate.handle,
      })),
      ...(options.omitFilterEdges
        ? []
        : candidates.map((candidate) => ({
            from: candidate.handle,
            to: FILTER,
          }))),
    ],
  });
}

/**
 * The ids the payload's handles compile to. Derived with the SAME production
 * function the service uses, so the proof asserts against ids the engine minted
 * rather than against a pattern this test invented.
 */
function candidateIdsFor(candidates: readonly Candidate[]): string[] {
  return candidates.map((candidate) =>
    expansionContextId(GENERATOR, REQUEST_ID, candidate.handle),
  );
}

/**
 * The lanes the payload PLACED those candidates on. Distinct from their context
 * ids: placement is the lane authority, so the roster a join merges is what the
 * expansion authored, not what the engine minted.
 */
function candidateLanesFor(candidates: readonly Candidate[]): string[] {
  return candidates.map((candidate) => candidate.handle);
}

function candidateByContextId(
  candidates: readonly Candidate[],
): Map<string, Candidate> {
  return new Map(
    candidates.map((candidate) => [
      expansionContextId(GENERATOR, REQUEST_ID, candidate.handle),
      candidate,
    ]),
  );
}

function winningCandidateId(candidates: readonly Candidate[]): string {
  const best = [...candidates].sort(
    (left, right) => right.score - left.score,
  )[0];
  return best ? expansionContextId(GENERATOR, REQUEST_ID, best.handle) : "";
}

/**
 * The route's expand response, parsed rather than cast: an assertion about a
 * body nobody validated is an assertion about a shape the route may have
 * stopped returning. Permissive across both branches so a refusal is captured
 * and asserted on rather than throwing here.
 */
const expandResponseBodySchema = z.object({
  ok: z.boolean().optional(),
  replayed: z.boolean().optional(),
  liveRevision: z.number().optional(),
  createdContextIds: z.array(z.string()).optional(),
  createdTaskIds: z.array(z.string()).optional(),
  rejoinContextIds: z.array(z.string()).optional(),
  error: z.string().optional(),
  code: z.string().optional(),
});

interface ExpansionAttempt {
  status: number;
  body: z.infer<typeof expandResponseBodySchema>;
}

interface PatternRun {
  settled: GraphWorkflowExecution;
  /** Every typed event the run published, projected to kind/subject/detail. */
  events: readonly TypedEventRecord[];
  statusTransitions: readonly ContextStatusTransition[];
  scheduling: readonly SchedulingDecision[];
  attempts: ExpansionAttempt[];
  refusalCodes: string[];
  /** The last prompt each context's implementer was handed. */
  prompts: Map<string, string>;
  reloaded: GraphWorkflowExecution | null;
}

/**
 * Execute the template and drive the generator's expansion through the real
 * lane route. `attempts` posts the SAME payload more than once so the
 * idempotent-replay contract is exercised by the pattern itself and not only by
 * the service's own unit tests.
 */
async function runPattern(options: {
  candidates: readonly Candidate[];
  attempts?: number;
  omitFilterEdges?: boolean;
}): Promise<PatternRun> {
  const candidates = options.candidates;
  const attemptCount = options.attempts ?? 1;
  const request = expansionPayload(candidates, {
    ...(options.omitFilterEdges === undefined
      ? {}
      : { omitFilterEdges: options.omitFilterEdges }),
  });

  const configDir = await mkdtemp(path.join(tmpdir(), "cc-pattern-token-"));
  const token = await ensureInstanceToken(configDir);
  // The lane capability is signed with the server-only key, not this token.
  const auth = createAgentAuth({ configDir });
  const readLaneIdentity = async (request: Request) =>
    readLaneHeader(request.headers.get(LANE_IDENTITY_HEADER));

  const attempts: ExpansionAttempt[] = [];
  const refusalCodes: string[] = [];
  const prompts = new Map<string, string>();
  const byContextId = candidateByContextId(candidates);

  try {
    return await runEngineScenario(
      {
        name: "generate-and-filter",
        definition: planDefinition(),
        sessionLaneEnabled: false,
        agent: () => "complete-next-task",
        capture: ({ contextId }) => {
          if (contextId === GENERATOR) {
            return {
              approaches: candidates.map((candidate) => candidate.approach),
              expansionRequestId: REQUEST_ID,
            };
          }
          const candidate = byContextId.get(contextId);
          if (candidate) {
            return { approach: candidate.approach, score: candidate.score };
          }
          if (contextId === FILTER) {
            return {
              chosenContextId: winningCandidateId(candidates),
              rationale: "Highest scored candidate.",
            };
          }
          return null;
        },
        async onAgentTurn(turn) {
          prompts.set(turn.contextId, turn.prompt);
          if (turn.contextId !== GENERATOR || turn.turn !== 1) return;

          const expansionService = createGraphWorkflowExpansionService({
            executionContract: createTestGraphExecutionContract(),
            getActiveExecution: turn.repository.getActive,
            mutateActive: turn.repository.mutateActive,
            buildLiveEditDeps: async () => harnessLiveEditDeps(),
            publishLiveEditApplied: turn.eventPublisher.publishLiveEditApplied,
            publishGraphExpansion: turn.eventPublisher.publishGraphExpansion,
            deliver: turn.eventPublisher.deliver,
            now: () => "2026-08-05T00:00:00.000Z",
          });

          const deps: LaneRouteDeps = {
            auth,
            readLaneIdentity,
            expandGraph: (input) => expansionService.expand(input),
            publishExpansionRefusal: (notice) => {
              refusalCodes.push(notice.refusalCode);
            },
            resolveProjectPath: async () => turn.projectPath,
            // The two halves the expand path actually reads off the loader: the
            // stale-lane guard and the pre-dispatch halt check, both against the
            // live execution.
            loadLaneToolContext: async (
              projectPath,
              sessionName,
              executionId,
              contextId,
            ) => {
              const execution = await turn.repository.getActive(
                projectPath,
                sessionName,
              );
              const definitionContext =
                execution?.workingDefinition.executionContexts.find(
                  (candidate) => candidate.id === contextId,
                );
              if (!execution || execution.id !== executionId) {
                return {
                  ok: false,
                  status: 404,
                  error: "Workflow execution context not found",
                };
              }
              if (!definitionContext) {
                return {
                  ok: false,
                  status: 404,
                  error: "Workflow execution context not found",
                };
              }
              const contextState = execution.contextStates[contextId];
              return {
                ok: true,
                reminderState: {
                  iterationCount: contextState?.iterationCount ?? 0,
                  circuitBreakerThreshold:
                    definitionContext.circuitBreaker
                      .consecutiveFailureThreshold ?? 3,
                  remainingTaskCount: contextState
                    ? Math.max(
                        0,
                        contextState.totalTaskCount -
                          contextState.completedTaskCount,
                      )
                    : 0,
                },
                context: {
                  executionContextTitle: definitionContext.title,
                  allowAgentTaskAdd:
                    definitionContext.mutability.allowAgentTaskAdd,
                  allowAgentCollaboration: false,
                  completeTask: () => {
                    throw new Error("not reached by the expand verb");
                  },
                  addTask: () => {
                    throw new Error("not reached by the expand verb");
                  },
                  upsertSharedDocument: () => {
                    throw new Error("not reached by the expand verb");
                  },
                  getPendingHaltReason: async () => {
                    const fresh = await turn.repository.getActive(
                      projectPath,
                      sessionName,
                    );
                    return fresh?.pendingHaltReason ?? null;
                  },
                  getPendingToolBlock: async () => null,
                },
              };
            },
          };

          const handlers = createLaneRouteHandlers(deps);
          // Minted the way `implementer-runner` mints it at dispatch, from the
          // instance token this run provisioned — so the route's verifier is
          // checking a real signature, not a stubbed verdict.
          const capability = encodeLaneIdentity({
            laneKind: "implementer",
            executionId: turn.executionId,
            contextId: turn.contextId,
            conversationId: turn.conversationId,
          });
          if (capability === null) {
            throw new Error("no instance token to mint a lane capability from");
          }

          const projectName = path.basename(turn.projectPath);
          for (let attempt = 0; attempt < attemptCount; attempt += 1) {
            const response = await handlers.expandGraph(
              new Request(
                `http://cc.local/api/projects/${projectName}/sessions/${turn.sessionName}/graph-workflow/contexts/${turn.contextId}/expand`,
                {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${token}`,
                    [LANE_IDENTITY_HEADER]: capability,
                  },
                  body: JSON.stringify({
                    executionId: turn.executionId,
                    request,
                  }),
                },
              ),
              {
                params: Promise.resolve({
                  name: projectName,
                  session: turn.sessionName,
                  contextId: turn.contextId,
                }),
              },
            );
            attempts.push({
              status: response.status,
              body: expandResponseBodySchema.parse(await response.json()),
            });
          }
        },
      },
      async (run) => ({
        settled: run.settled,
        events: run.recording.events,
        statusTransitions: run.recording.statusTransitions,
        scheduling: run.recording.scheduling,
        attempts,
        refusalCodes,
        prompts,
        reloaded: await run.repository.getActive(
          run.projectPath,
          run.sessionName,
        ),
      }),
    );
  } finally {
    _resetInstanceTokenCacheForTesting();
    await rm(configDir, { recursive: true, force: true });
  }
}

// ============================================================
// 1. The template is admitted by the production authoring path
// ============================================================

describe("Generate-And-Filter template — authoring (R15.2)", () => {
  it("is accepted, warning-free, by the validator `cctl workflow create` runs", () => {
    const result = validateWorkflowPlan(readPlan());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A warned plan is still creatable, but a pattern template nobody should
    // copy is not a pattern proof.
    expect(structuralWarningsOf(result.warnings)).toEqual([]);
  });
});

// ============================================================
// 1b. The agent-facing expansion example (D6 R2.4)
// ============================================================

/**
 * The expansion example the generator's task hands a real agent, with its
 * angle-bracket placeholders filled in so the PRODUCTION request schema can
 * judge it.
 *
 * Substituting placeholders is not repairing the artifact: the example is a
 * template, and every field it actually declares survives the substitution
 * untouched. What the schema then answers is the question that matters — would
 * the payload this template tells an agent to write be accepted?
 */
function exampleExpansionRequest(): unknown {
  const instructions =
    planDefinition().tasks.find((task) => task.contextId === GENERATOR)
      ?.instructions ?? "";
  const fenced = /```json\n([\s\S]*?)\n```/.exec(instructions);
  if (fenced?.[1] === undefined) {
    throw new Error(
      "the generator's instructions carry no fenced json expansion example",
    );
  }
  return JSON.parse(fenced[1].replace(/<[^>]+>/g, "example"));
}

describe("Generate-And-Filter — the expansion example it hands an agent (D6 R2.4)", () => {
  it("is a payload the production expansion schema accepts, with placement on every generated context", () => {
    const parsed = graphExpansionRequestSchema.safeParse(
      exampleExpansionRequest(),
    );

    // The engine refuses a placement-less generated context outright
    // (`expansion-placement-missing`), so an example that omits placement is an
    // instruction to write a payload the engine will reject.
    expect(
      parsed.success ? [] : parsed.error.issues.map((issue) => issue.message),
    ).toEqual([]);
    if (!parsed.success) return;

    for (const context of parsed.data.contexts) {
      expect(
        context.placement,
        `generated context "${context.handle}" declares no placement`,
      ).toBeDefined();
    }
  });

  it("gives every generated context both edges — from the generator and into the filter", () => {
    const parsed = graphExpansionRequestSchema.parse(exampleExpansionRequest());

    for (const context of parsed.contexts) {
      expect(
        parsed.edges.some(
          (edge) => edge.from === GENERATOR && edge.to === context.handle,
        ),
        `"${context.handle}" has no edge from the generator`,
      ).toBe(true);
      expect(
        parsed.edges.some(
          (edge) => edge.from === context.handle && edge.to === FILTER,
        ),
        `"${context.handle}" has no edge into the filter`,
      ).toBe(true);
    }
  });

  it("describes the missing-filter-edge consequence the way the engine actually behaves", () => {
    const instructions =
      planDefinition().tasks.find((task) => task.contextId === GENERATOR)
        ?.instructions ?? "";

    // Reachability is measured FROM THE INVOKER, so a candidate carrying only
    // the inbound edge is reachable and admitted. Telling an agent it would be
    // "refused as unreachable" teaches it to rely on a guard that does not
    // exist — the far more dangerous error, because the fan-out then runs and
    // the filter judges a subset without anyone noticing.
    expect(instructions).not.toMatch(/refused as unreachable/i);
    expect(instructions).toMatch(/starve/i);
  });

  it("proves that consequence: the engine accepts the omission and the filter never sees the candidate", async () => {
    const run = await runPattern({
      candidates: THREE_CANDIDATES,
      omitFilterEdges: true,
    });

    // Accepted, not refused — the claim the guidance has to make honestly.
    expect(run.attempts.at(0)?.status).toBe(200);
    expect(run.attempts.at(0)?.body.ok).toBe(true);
    expect(run.refusalCodes).toEqual([]);
    expect(run.attempts.at(0)?.body.createdContextIds).toEqual(
      candidateIdsFor(THREE_CANDIDATES),
    );

    // ...and the starvation it causes: the filter ran on the generator alone.
    const filterInputs = resolveUpstreamInputs(run.settled, FILTER);
    expect(filterInputs.map((input) => input.contextId)).toEqual([GENERATOR]);
    for (const candidateId of candidateIdsFor(THREE_CANDIDATES)) {
      expect(filterInputs.map((input) => input.contextId)).not.toContain(
        candidateId,
      );
    }
  }, 120_000);
});

// ============================================================
// 2. The engine proof
// ============================================================

describe("Generate-And-Filter — engine proof (R15.2)", () => {
  it("expands N candidates through the real lane route, runs the filter on all of them, and publishes", async () => {
    const run = await runPattern({ candidates: THREE_CANDIDATES });
    const candidateIds = candidateIdsFor(THREE_CANDIDATES);

    // --- the expansion went through the route, authorized ------------------
    expect(run.refusalCodes).toEqual([]);
    expect(run.attempts).toHaveLength(1);
    const accepted = run.attempts[0];
    expect(accepted?.status).toBe(200);
    expect(accepted?.body.ok).toBe(true);
    expect(accepted?.body.replayed).toBe(false);
    expect(accepted?.body.createdContextIds).toEqual(candidateIds);
    expect(accepted?.body.rejoinContextIds).toEqual([FILTER]);

    // --- the candidates appeared mid-run and completed ----------------------
    for (const candidateId of candidateIds) {
      expect(run.settled.contextStates[candidateId]?.status).toBe("completed");
      // `from: null` is the signature of a context materialized at runtime.
      expect(
        run.statusTransitions.some(
          (transition) =>
            transition.contextId === candidateId && transition.from === null,
        ),
      ).toBe(true);
    }

    // --- the filter consumed every candidate's output ----------------------
    expect(run.settled.contextStates[FILTER]?.status).toBe("completed");
    const filterInputs = resolveUpstreamInputs(run.settled, FILTER);
    expect(filterInputs.map((input) => input.contextId).sort()).toEqual(
      [GENERATOR, ...candidateIds].sort(),
    );
    expect(filterInputs.every((input) => input.output !== null)).toBe(true);
    // What the filter's agent was actually handed. Asserted on the SCORE rather
    // than the approach name: the generator's own output lists the approaches
    // too, so a prompt naming them proves nothing about the candidates having
    // reported anything. Only a candidate's own capture carries its score.
    const filterPrompt = run.prompts.get(FILTER) ?? "";
    for (const [candidateId, candidate] of candidateByContextId(
      THREE_CANDIDATES,
    )) {
      expect(filterPrompt).toContain(candidateId);
      expect(filterPrompt).toContain(`"score": ${candidate.score}`);
    }

    // --- the execution completed and published -----------------------------
    expect(run.settled.status).toBe("completed");
    expect(
      run.events.some(
        (event) =>
          event.kind === "graph-workflow-status" &&
          event.detail === "completed",
      ),
    ).toBe(true);
    // The publication itself, not just the terminal status. Asserted on the
    // join TOPOLOGY rather than on an exact lane roster: lane ids are not
    // context ids, because lane continuity lets a context continue a
    // predecessor's lane instead of taking its own, so pinning the roster would
    // pin continuity arithmetic rather than the pattern.
    const joins = run.scheduling.filter(
      (decision) => decision.decision === "join",
    );
    const filterFanIn = joins.find(
      (join) =>
        join.decision === "join" &&
        join.joinKind === "context_merge" &&
        join.contextId === FILTER,
    );
    expect(filterFanIn).toBeDefined();
    if (filterFanIn?.decision === "join") {
      // The fan-out converged through a real merge, and every lane it merged
      // belongs to this graph's generator or to a candidate the expansion
      // created — nothing foreign, and at least one runtime-created lane.
      const candidateLanes = candidateLanesFor(THREE_CANDIDATES);
      expect(filterFanIn.sourceLaneIds.length).toBeGreaterThan(1);
      expect(
        filterFanIn.sourceLaneIds.every(
          (laneId) => laneId === GENERATOR || candidateLanes.includes(laneId),
        ),
      ).toBe(true);
      expect(
        filterFanIn.sourceLaneIds.some((laneId) =>
          candidateLanes.includes(laneId),
        ),
      ).toBe(true);
    }
    expect(
      joins.some(
        (join) =>
          join.decision === "join" &&
          join.joinKind === "final_publish" &&
          join.targetLaneId === "__session__",
      ),
    ).toBe(true);

    // --- the expansion events -----------------------------------------------
    expect(
      run.events.filter(
        (event) => event.kind === "graph-workflow-graph-expanded",
      ),
    ).toEqual([
      {
        kind: "graph-workflow-graph-expanded",
        subject: GENERATOR,
        detail: "accepted",
      },
    ]);
    expect(
      run.events.some(
        (event) =>
          event.kind === "graph-workflow-live-edit-applied" &&
          event.detail === "lane-agent",
      ),
    ).toBe(true);

    // --- the receipt, and the provenance it anchors -------------------------
    const receipts = run.settled.expansionReceipts;
    expect(receipts.refusals).toEqual([]);
    expect(receipts.accepted).toHaveLength(1);
    const receipt = receipts.accepted[0];
    expect(receipt?.requestId).toBe(REQUEST_ID);
    expect(receipt?.invokerContextId).toBe(GENERATOR);
    expect(receipt?.rationale).toBe(RATIONALE);
    expect(receipt?.addedContextIds).toEqual(candidateIds);
    expect(receipt?.payloadHash).toBe(
      expansionPayloadHash(
        expansionCanonicalPayload(expansionPayload(THREE_CANDIDATES)),
      ),
    );

    for (const candidateId of candidateIds) {
      expect(resolveExpansionProvenance(receipts, candidateId)).toMatchObject({
        nodeKind: "context",
        receipt: { requestId: REQUEST_ID, rationale: RATIONALE },
      });
    }
    for (const taskId of receipt?.addedTaskIds ?? []) {
      expect(resolveExpansionProvenance(receipts, taskId)?.nodeKind).toBe(
        "task",
      );
    }
    // A planner-authored node has no expansion provenance.
    expect(resolveExpansionProvenance(receipts, GENERATOR)).toBeNull();

    // --- and it survives a reload through the repository --------------------
    expect(run.reloaded?.status).toBe("completed");
    expect(run.reloaded?.expansionReceipts.accepted).toHaveLength(1);
    expect(
      run.reloaded?.workingDefinition.executionContexts.map(
        (context) => context.id,
      ),
    ).toEqual(expect.arrayContaining(candidateIds));
  });

  it("answers a re-posted expansion from its receipt instead of fanning out twice", async () => {
    const run = await runPattern({ candidates: THREE_CANDIDATES, attempts: 2 });
    const candidateIds = candidateIdsFor(THREE_CANDIDATES);

    expect(run.attempts.map((attempt) => attempt.status)).toEqual([200, 200]);
    expect(run.attempts.map((attempt) => attempt.body.replayed)).toEqual([
      false,
      true,
    ]);
    // The replay reports the same ids without adding them again.
    expect(run.attempts[1]?.body.createdContextIds).toEqual(candidateIds);
    expect(run.settled.expansionReceipts.accepted).toHaveLength(1);
    expect(
      run.settled.workingDefinition.executionContexts.filter((context) =>
        context.id.includes("-x"),
      ),
    ).toHaveLength(candidateIds.length);
    expect(run.settled.status).toBe("completed");
  });
});
