import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { acceptanceCriteriaText } from "@/lib/workflow-graph/criteria/criterion-records";
import { validateWorkflowPlan } from "@/lib/workflows/plan-validation";
import { runEngineScenario } from "../compat/engine-harness";
import type {
  CompatibilityValidatorSeat,
  CompatibilityValidatorTurn,
  EngineScenarioRun,
} from "../compat/engine-harness";
import { resolveUpstreamInputs } from "../context-outputs";
import { workflowSemanticDefinitionSchema } from "../definition-schemas";
import {
  COHORT_SEATS,
  expectAdversarialCohort,
  settledSpecialists,
} from "./adversarial-cohort-assertions";

/**
 * Pattern proof: the approved composite — Fanout-And-Synthesize feeding
 * Adversarial Verification, in one ordinary workflow (D6 R2.7).
 *
 * The composite is not "run both plans". Composing them exposes an ordering the
 * two patterns never meet separately: a context's cohort validates BEFORE its
 * structured output is captured. In
 * `src/lib/workflow-graph/iteration-orchestrator.ts`, both iteration paths — the
 * validation-only one and the agent-turn one — call
 * `processContextCompletionValidation` and only then
 * `processContextOutputCapture`, and each phase stands down on the same
 * condition (`getIncompleteTasks(...).length > 0`), so they compete for the same
 * moment and validation always reaches it first. A synthesizer that delivered
 * ONLY through captured output would therefore hand four reviewers a candidate
 * that does not exist yet — they would be reviewing an empty diff and passing
 * it.
 *
 * That is why the composite's synthesizer is the one write-capable context in
 * the catalog's read-only half: its task materializes the synthesis as a file
 * inside its lane, so the panel has something real to review, and its captured
 * output afterwards records where that artifact is and which readers it came
 * from. The assertions below pin exactly that — the shape that makes the
 * composite honest, and the run that shows the ordering holding.
 */

const PLAN_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fanout-adversarial-composite.plan.json",
);

const READERS = [
  "context-read-runtime",
  "context-read-tests",
  "context-read-docs",
] as const;
const SYNTHESIZE = "context-synthesize";

/** Where the synthesizer's reviewable candidate lands inside its lane. */
const ARTIFACT_PATH = "docs/reports/synthesis.md";

function synthesisArtifact(revision: number): string {
  return `# Reviewed synthesis\n\nRevision ${revision} from every reader.\n`;
}

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

function readerFinding(contextId: string): Record<string, unknown> {
  return {
    area: contextId.replace("context-read-", ""),
    findings: [`${contextId} observed one thing worth reporting`],
    confidence: "medium",
  };
}

/** The provenance the synthesizer banks once its artifact exists. */
function synthesisOutput(): Record<string, unknown> {
  return {
    artifactPath: ARTIFACT_PATH,
    synthesis: "One picture, assembled from every reader's report.",
    readerProvenance: READERS.map((contextId) => ({
      contextId,
      area: contextId.replace("context-read-", ""),
      findingsUsed: 1,
    })),
  };
}

/**
 * One run of the composite through the real engine, using the in-turn capture
 * stand-in. Enough for the fan-out and cohort assertions; the ordering the
 * pattern rests on is proven separately, against the production capture gate.
 */
async function runComposite<T>(
  inspect: (run: EngineScenarioRun) => Promise<T>,
): Promise<T> {
  return runEngineScenario(
    {
      name: "fanout-adversarial-composite",
      definition: planDefinition(),
      sessionLaneEnabled: false,
      agent: () => "complete-next-task",
      validator: () => ({ verdict: "pass" }),
      capture: ({ contextId }) => {
        if ((READERS as readonly string[]).includes(contextId)) {
          return readerFinding(contextId);
        }
        if (contextId === SYNTHESIZE) {
          return synthesisOutput();
        }
        return null;
      },
    },
    inspect,
  );
}

describe("Fanout-And-Synthesize + Adversarial Verification composite (D6 R2.7)", () => {
  it("fans out read-only readers into one write-capable synthesizer", () => {
    const result = validateWorkflowPlan(readPlan());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);

    const definition = result.draft.definition;
    const byId = new Map(
      definition.executionContexts.map((context) => [context.id, context]),
    );
    expect([...byId.keys()].sort()).toEqual([...READERS, SYNTHESIZE].sort());

    for (const reader of READERS) {
      expect(byId.get(reader)?.placement).toEqual({
        lane: "session",
        mode: "readOnly",
      });
      expect(byId.get(reader)?.outputSchema).toMatchObject({ type: "object" });
    }

    // The synthesizer is the composite's whole reason for being write-capable:
    // it has to leave a candidate on disk. `owned` rather than `full` keeps it
    // to the narrowest surface that can hold the artifact.
    const synthesizer = byId.get(SYNTHESIZE);
    expect(synthesizer?.placement?.mode).toBe("owned");
    expect(synthesizer?.placement?.lane).not.toBe("session");
    const ownedPaths =
      synthesizer?.placement?.mode === "owned"
        ? synthesizer.placement.ownedPaths
        : [];
    expect(
      ownedPaths.some(
        (owned) =>
          ARTIFACT_PATH === owned || ARTIFACT_PATH.startsWith(`${owned}/`),
      ),
      `no owned path covers ${ARTIFACT_PATH} (owned: ${ownedPaths.join(", ")})`,
    ).toBe(true);

    expect(
      definition.edges
        .filter((edge) => edge.targetContextId === SYNTHESIZE)
        .map((edge) => edge.sourceContextId)
        .sort(),
    ).toEqual([...READERS].sort());
  });

  it("attaches the approved four-seat cohort to the synthesizer and to nothing else", () => {
    const result = validateWorkflowPlan(readPlan());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expectAdversarialCohort(result.draft.definition, SYNTHESIZE);

    // A reader has nothing to review — it leaves no diff — so a cohort there
    // would be four agents inspecting an empty candidate.
    for (const reader of READERS) {
      const cohort = result.draft.definition.executionContexts.find(
        (context) => context.id === reader,
      )?.contextValidator;
      expect(cohort?.assignments ?? []).toEqual([]);
    }
  });

  it("materializes the candidate before the panel reviews it, not in captured output", () => {
    const result = validateWorkflowPlan(readPlan());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const definition = result.draft.definition;
    const instructions =
      definition.tasks.find((task) => task.contextId === SYNTHESIZE)
        ?.instructions ?? "";

    // The artifact is named where the agent will read it, and writing it is
    // ordered BEFORE completion — the cohort runs on task completion, so an
    // instruction to bank the synthesis "as output" would be a candidate that
    // does not exist when the four reviewers open the diff.
    expect(instructions).toContain(ARTIFACT_PATH);
    expect(instructions).toMatch(/before you complete this task/i);

    // Every reader's contribution has to reach the FILE, so the panel reviews
    // the whole fan-out rather than whichever reader the synthesizer liked.
    for (const reader of READERS) {
      expect(instructions).toContain(reader);
    }

    // The acceptance criteria are what the blocking seat is held to, so the
    // artifact has to be legible there too, not only in the implementer's
    // instructions.
    const criteria =
      definition.executionContexts.find((context) => context.id === SYNTHESIZE)
        ?.acceptanceCriteria ?? "";
    expect(acceptanceCriteriaText(criteria)).toContain(ARTIFACT_PATH);
  });

  it("preserves the artifact path and every reader's provenance in captured output", () => {
    const result = validateWorkflowPlan(readPlan());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const schema = result.draft.definition.executionContexts.find(
      (context) => context.id === SYNTHESIZE,
    )?.outputSchema as
      | { required?: unknown; properties?: Record<string, unknown> }
      | undefined;

    expect(schema?.required).toEqual(
      expect.arrayContaining(["artifactPath", "readerProvenance"]),
    );

    // At least one entry per reader, each naming the context it came from:
    // provenance that could not be traced back to a reader would not show that
    // the fan-out survived synthesis.
    expect(schema?.properties?.readerProvenance).toMatchObject({
      type: "array",
      minItems: READERS.length,
      items: {
        type: "object",
        required: expect.arrayContaining(["contextId"]),
      },
    });
  });

  it("runs the whole composite: one reader wave, the panel, and banked provenance", async () => {
    await runComposite(async (run) => {
      const { settled } = run;
      expect(settled.status).toBe("completed");
      expect(settled.haltReason).toBeNull();

      // Every seat settled with its own durable identity against one candidate.
      const specialists = settledSpecialists(settled, SYNTHESIZE);
      expect(Object.keys(specialists).sort()).toEqual(
        COHORT_SEATS.map((seat) => seat.id).sort(),
      );
      for (const seat of COHORT_SEATS) {
        expect(specialists[seat.id]?.state).toBe("verdict_pass");
      }

      // Every reader's output reached the synthesizer — the fan-out half of the
      // composite, unchanged by the panel bolted onto its downstream.
      const upstream = resolveUpstreamInputs(settled, SYNTHESIZE);
      expect(upstream.map((input) => input.contextId).sort()).toEqual(
        [...READERS].sort(),
      );
      for (const reader of READERS) {
        expect(settled.contextStates[reader]?.laneId).toBeNull();
      }

      // ...and survived into the banked provenance, with the artifact path.
      expect(settled.contextOutputs[SYNTHESIZE]?.value).toMatchObject({
        artifactPath: ARTIFACT_PATH,
      });
      const banked = settled.contextOutputs[SYNTHESIZE]?.value as
        | { readerProvenance?: Array<{ contextId?: string }> }
        | undefined;
      expect(
        (banked?.readerProvenance ?? []).map((entry) => entry.contextId).sort(),
      ).toEqual([...READERS].sort());
      return null;
    });
  }, 120_000);
});

// ============================================================
// The ordering itself, through the production capture gate
// ============================================================

/** What one cohort seat could see at the moment it reviewed. */
interface SeatObservation {
  assignmentId: string;
  attempt: number;
  /** Was the reviewable artifact on disk when this seat looked? */
  artifactMaterialized: boolean;
  /** The candidate bytes this seat read from the production execution target. */
  artifactContent: string | null;
  /** Had the synthesizer's structured output been banked when this seat looked? */
  outputBanked: boolean;
}

interface OrderingRecord {
  /** Engine actions in the order the engine took them. */
  timeline: string[];
  /** One entry per cohort seat dispatch against the synthesizer. */
  seats: SeatObservation[];
  /** Candidate bytes read by the production capture path. */
  capturedArtifactContents: string[];
}

/**
 * Run the composite with the PRODUCTION D2 capture gate wired, recording what
 * each cohort seat could see and the order the engine did things in.
 *
 * This is the proof the pattern actually needs. The in-turn capture stand-in
 * banks output BEFORE validation — the reverse of production — so a proof built
 * on it would stay green under exactly the regressions that matter: capture
 * reordered ahead of validation, or provenance banked before a blocking seat
 * rejects. Wiring `outputCapture` makes the engine decide when capture happens,
 * so both become observable.
 *
 * The scenario opts into a real temporary lane target. `onAgentTurn` writes the
 * artifact there before task completion, and both the production validator path
 * and production capture path read those same bytes from that same target.
 */
async function runThroughCaptureGate<T>(
  script: (seat: CompatibilityValidatorSeat) => CompatibilityValidatorTurn,
  inspect: (run: EngineScenarioRun, recorded: OrderingRecord) => Promise<T>,
): Promise<T> {
  const timeline: string[] = [];
  const seats: SeatObservation[] = [];
  const capturedArtifactContents: string[] = [];
  const worktreeRoot = await mkdtemp(
    path.join(tmpdir(), "cc-composite-pattern-"),
  );

  try {
    return await runEngineScenario(
      {
        name: "fanout-adversarial-composite-capture-gate",
        definition: planDefinition(),
        sessionLaneEnabled: false,
        worktreeRoot,
        agent: () => "complete-next-task",
        onAgentTurn: async ({ contextId, turn, worktreePath }) => {
          if (contextId !== SYNTHESIZE) return;
          if (worktreePath === undefined) {
            throw new Error(
              "the synthesizer has no production execution target",
            );
          }
          const artifactPath = path.join(worktreePath, ARTIFACT_PATH);
          await mkdir(path.dirname(artifactPath), { recursive: true });
          await writeFile(artifactPath, synthesisArtifact(turn), "utf8");
          timeline.push(`write:${ARTIFACT_PATH}:${turn}`);
        },
        validator: (seat) => {
          if (seat.contextId === SYNTHESIZE) {
            const artifactContent =
              seat.worktreePath === undefined
                ? null
                : readFileSync(
                    path.join(seat.worktreePath, ARTIFACT_PATH),
                    "utf8",
                  );
            timeline.push(`validate:${seat.assignmentId}:${seat.attempt}`);
            seats.push({
              assignmentId: seat.assignmentId,
              attempt: seat.attempt,
              artifactMaterialized: artifactContent !== null,
              artifactContent,
              outputBanked:
                seat.execution.contextOutputs[SYNTHESIZE] !== undefined,
            });
          }
          return script(seat);
        },
        outputCapture: ({ contextId, worktreePath }) => {
          timeline.push(`capture:${contextId}`);
          if ((READERS as readonly string[]).includes(contextId)) {
            return readerFinding(contextId);
          }
          if (contextId === SYNTHESIZE) {
            if (worktreePath === undefined) {
              throw new Error(
                "the synthesis capture has no production execution target",
              );
            }
            const artifactContent = readFileSync(
              path.join(worktreePath, ARTIFACT_PATH),
              "utf8",
            );
            capturedArtifactContents.push(artifactContent);
            if (!artifactContent.includes("Reviewed synthesis")) {
              throw new Error("the capture gate could not read the candidate");
            }
            return synthesisOutput();
          }
          return null;
        },
      },
      (run) => inspect(run, { timeline, seats, capturedArtifactContents }),
    );
  } finally {
    await rm(worktreeRoot, { recursive: true, force: true });
  }
}

/** The synthesizer's task id as the ENGINE minted it, for a scripted reopen. */
async function discoverSynthesisTaskId(): Promise<string> {
  return runThroughCaptureGate(
    () => ({ verdict: "pass" }),
    async (run) => {
      const task = Object.values(run.settled.taskStates).find(
        (state) => state.contextId === SYNTHESIZE,
      );
      expect(task, `no task state for "${SYNTHESIZE}"`).toBeDefined();
      return task?.taskId ?? "";
    },
  );
}

describe("the composite's validation boundary, through the production capture gate (D6 R2.7)", () => {
  it("shows every seat a materialized candidate and banks provenance only after the round settles", async () => {
    await runThroughCaptureGate(
      () => ({ verdict: "pass" }),
      async (run, { timeline, seats }) => {
        expect(run.settled.status).toBe("completed");

        // All four seats reviewed, and each saw the SAME two facts: the
        // artifact was on disk, and the structured output did not exist yet.
        // That pair is the pattern's entire justification — it is why the plan
        // has to write a file rather than deliver through captured output.
        expect(seats.map((seat) => seat.assignmentId).sort()).toEqual(
          COHORT_SEATS.map((seat) => seat.id).sort(),
        );
        for (const seat of seats) {
          expect(
            seat.artifactMaterialized,
            `seat "${seat.assignmentId}" reviewed before the artifact existed`,
          ).toBe(true);
          expect(seat.artifactContent).toContain("Reviewed synthesis");
          expect(
            seat.outputBanked,
            `seat "${seat.assignmentId}" saw output banked before it reviewed`,
          ).toBe(false);
        }

        // The engine's own order: the synthesizer's capture came after the last
        // seat's review, not before any of them.
        const captureAt = timeline.indexOf(`capture:${SYNTHESIZE}`);
        const lastValidateAt = timeline.findLastIndex((entry) =>
          entry.startsWith("validate:"),
        );
        expect(captureAt, `no capture ran for "${SYNTHESIZE}"`).toBeGreaterThan(
          -1,
        );
        expect(captureAt).toBeGreaterThan(lastValidateAt);

        // The gate is the only writer: it never found an output already banked.
        const synthesisCaptures = run.captureCalls.filter(
          (call) => call.contextId === SYNTHESIZE,
        );
        expect(synthesisCaptures).toHaveLength(1);
        expect(synthesisCaptures.at(0)?.outputAlreadyBanked).toBe(false);

        // ...and what it banked is the provenance the criterion asks for.
        expect(run.settled.contextOutputs[SYNTHESIZE]?.value).toMatchObject({
          artifactPath: ARTIFACT_PATH,
        });
        return null;
      },
    );
  }, 120_000);

  it("banks no provenance at all when the blocking seat rejects", async () => {
    const synthesisTaskId = await discoverSynthesisTaskId();
    expect(synthesisTaskId).not.toBe("");

    await runThroughCaptureGate(
      (seat) =>
        seat.contextId === SYNTHESIZE &&
        seat.authority === "blocking" &&
        seat.attempt === 1
          ? { verdict: "fail", reopenTaskIds: [synthesisTaskId] }
          : { verdict: "pass" },
      async (run, { timeline, seats, capturedArtifactContents }) => {
        expect(run.settled.status).toBe("completed");

        // The rejection happened, and the synthesizer was sent back.
        const rejectedRound = seats.filter((seat) => seat.attempt === 1);
        expect(rejectedRound.length).toBeGreaterThan(0);

        // The load-bearing claim: capture ran ONCE, after the reopened work was
        // re-reviewed. A gate that banked provenance on the first round would
        // have published a synthesis the panel had just rejected — and, because
        // the gate declines a context it already captured, the corrected
        // artifact's provenance would never have been banked at all.
        const synthesisCaptures = run.captureCalls.filter(
          (call) => call.contextId === SYNTHESIZE,
        );
        expect(synthesisCaptures).toHaveLength(1);

        const captureAt = timeline.indexOf(`capture:${SYNTHESIZE}`);
        const firstRejectionAt = timeline.indexOf("validate:acceptance:1");
        const secondRoundAt = timeline.indexOf("validate:acceptance:2");
        expect(firstRejectionAt).toBeGreaterThan(-1);
        expect(
          secondRoundAt,
          "the blocking seat never re-reviewed the reopened work",
        ).toBeGreaterThan(firstRejectionAt);
        expect(captureAt).toBeGreaterThan(secondRoundAt);

        const secondRoundSeats = seats.filter((seat) => seat.attempt === 2);
        expect(
          secondRoundSeats.map((seat) => seat.assignmentId).sort(),
        ).toEqual(COHORT_SEATS.map((seat) => seat.id).sort());
        for (const seat of secondRoundSeats) {
          expect(seat.artifactContent).toBe(synthesisArtifact(2));
        }
        expect(capturedArtifactContents).toEqual([synthesisArtifact(2)]);

        // Every seat, on every round, still reviewed an unbanked candidate.
        for (const seat of seats) {
          expect(
            seat.outputBanked,
            `seat "${seat.assignmentId}" (attempt ${seat.attempt}) saw banked output`,
          ).toBe(false);
        }
        return null;
      },
    );
  }, 120_000);
});
