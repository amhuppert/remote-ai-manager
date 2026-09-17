import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging")>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { runCli } from "@/cli/core";
import type { CliEnv, CliHost } from "@/cli/shared";
import {
  _resetPublicationForTesting,
  setPublicationBroadcastForTesting,
} from "@/lib/events/publication";
import { _resetForTesting as resetJobQueue } from "@/lib/jobs/queue";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import {
  holdsExecutionLease,
  isTerminalStatus,
} from "@/lib/workflow-graph/lifecycle-classifier";

import type {
  SpecExecutionCleanupPhase,
  SpecExecutionRow,
  SpecRevision,
} from "./schemas";
import {
  approveAndSignOffSpine,
  authorSpineDraft,
  createSpecSpineWorld,
  proposeSpineRevision,
  SPINE_BEARER_TOKEN,
  SPINE_CONVERSATION_ID,
  SPINE_PROJECT_NAME,
  SPINE_SESSION_NAME,
  SPINE_WORKFLOW_EXECUTION_ID,
  startSpineExecution,
  startSpineWorkflowThroughProductionGate,
  type SpecSpineWorld,
} from "./spine-test-fixture";
import {
  integrityReportSchema,
  type IntegrityReport,
  type SpecConsistencyFinding,
} from "./view-schemas";

const SLUG = "spec-spine";

const cliEnv: CliEnv = {
  CC_SERVER_URL: "http://cc.test",
  CC_API_TOKEN: SPINE_BEARER_TOKEN,
  CC_PROJECT: SPINE_PROJECT_NAME,
  CC_SESSION: SPINE_SESSION_NAME,
  CC_CONVERSATION_ID: SPINE_CONVERSATION_ID,
};

/**
 * Bridges the real `cctl` implementations onto the spine world's production
 * route handlers, so the recovery verbs a finding names are the exact commands
 * a reader of the receipt would run.
 */
function bridgeHost(world: SpecSpineWorld): CliHost {
  return {
    async fetch(url, init) {
      const parsed = new URL(url);
      const segments = parsed.pathname
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent);
      const request = new Request(`http://cc.test${parsed.pathname}`, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
      });
      if (segments[1] === "specs" && segments[4] === "verify") {
        return world.getRoute("getSpecVerifyGET", { slug: segments[3] ?? "" });
      }
      if (segments[1] === "projects" && segments[5] === "graph-workflow") {
        const tail = segments[6];
        if (tail === "abort") {
          return world.postWorkflowRoute("ABORT", await request.json());
        }
      }
      throw new Error(`Unbridged CLI request: ${init.method} ${url}`);
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

/**
 * `cctl spec verify` reports the consistency findings a spec cannot see from
 * its own content hashes (design §9): a cleanup the abandon coordinator never
 * finished, and a run left owning the session after the spec gave up on it.
 * The families are asserted through the production verify route so the report
 * a reader receives is the one under test.
 */
describe("spec verify reports execution-lifecycle consistency findings", () => {
  let world: SpecSpineWorld;

  beforeEach(() => {
    resetJobQueue();

    world = createSpecSpineWorld();
    setPublicationBroadcastForTesting(() => ({ delivered: true }));
  });

  afterEach(() => {
    resetJobQueue();

    _resetPublicationForTesting();
  });

  async function liveExecution(): Promise<{ specExecutionId: string }> {
    const authored = await authorSpineDraft(world, SLUG);
    await proposeSpineRevision(world, SLUG, authored);
    await approveAndSignOffSpine(world, SLUG, authored);
    const started = await startSpineExecution(world, SLUG, authored);
    await startSpineWorkflowThroughProductionGate(world, started);
    expect(world.readActiveWorkflowExecution()).not.toBeNull();
    return { specExecutionId: started.specExecutionId };
  }

  async function report(): Promise<IntegrityReport> {
    const response = await world.getRoute("getSpecVerifyGET", { slug: SLUG });
    expect(response.status).toBe(200);
    return integrityReportSchema.parse(await response.json());
  }

  function lifecycleFindings(
    value: IntegrityReport,
  ): Extract<
    IntegrityReport["consistencyFindings"][number],
    { family: "execution-lifecycle" }
  >[] {
    return value.consistencyFindings.filter(
      (finding) => finding.family === "execution-lifecycle",
    );
  }

  /** `--execution` takes the workflow execution id, never the spec-side row. */
  function abandon(): Promise<Response> {
    return world.postAction(
      SLUG,
      "abandon-execution",
      {
        executionId: SPINE_WORKFLOW_EXECUTION_ID,
        reason: "superseded by a replanned run",
      },
      "agent",
    );
  }

  function row(specExecutionId: string): SpecExecutionRow {
    const found = world.repos.delivery.findExecutionById(specExecutionId);
    if (found === null) throw new Error("spec execution vanished");
    return found;
  }

  /**
   * The lease, not the row position, is what "released" means (D4/R3.3): the
   * abort seam transitions the run and stops, so a lease-free record sits in
   * the active row until the next launch normalizes it.
   */
  function expectLeaseReleased(): void {
    const active = world.readActiveWorkflowExecution();
    if (active === null) return;
    expect(
      holdsExecutionLease(active.status, active.haltReason, active.abandonment),
    ).toBe(false);
  }

  function activeWorkflow(): GraphWorkflowExecution {
    const active = world.readActiveWorkflowExecution();
    if (active === null) {
      throw new Error("the session owns no active workflow execution");
    }
    return active;
  }

  function onlyFinding(
    findings: readonly SpecConsistencyFinding[],
  ): SpecConsistencyFinding {
    expect(findings).toHaveLength(1);
    const finding = findings.at(0);
    if (finding === undefined) throw new Error("expected exactly one finding");
    return finding;
  }

  /**
   * One case per cleanup phase, each seeded by the fault the abandon
   * coordinator's own integration tests inject, so the stored state under
   * verification is the canonical residue that phase's interruption leaves —
   * and the three residues genuinely differ in what the linked run still owns.
   */
  const phases: Array<{
    phase: SpecExecutionCleanupPhase;
    inject(): void;
    expectWorld(): void;
  }> = [
    {
      phase: "abort_workflow",
      inject: () => {
        world.cleanupFaults.beforeOp = (op) => {
          if (op === "abort") throw new Error("injected abort fault");
        };
      },
      expectWorld: () => {
        expect(isTerminalStatus(activeWorkflow().status)).toBe(false);
      },
    },
    {
      phase: "finalize",
      inject: () => {
        let observed = 0;
        world.cleanupFaults.beforeOp = (op) => {
          if (op !== "observe") return;
          observed += 1;
          if (observed === 2) throw new Error("injected post-abort fault");
        };
      },
      // The abort already released the lease, so the parked finalize sees a run
      // History owns — the residue is the spec row alone, which is precisely
      // the case no other surface reports.
      expectWorld: () => {
        expectLeaseReleased();
      },
    },
  ];

  for (const phaseCase of phases) {
    it(`reports a row stuck in ${phaseCase.phase} and clears it through the abandon retry`, async () => {
      const { specExecutionId } = await liveExecution();
      phaseCase.inject();
      expect((await abandon()).status).not.toBe(200);

      const parked = row(specExecutionId);
      expect(parked.state).toBe("abandoning");
      expect(parked.cleanup_phase).toBe(phaseCase.phase);
      phaseCase.expectWorld();

      const finding = onlyFinding(lifecycleFindings(await report()));
      expect(finding).toMatchObject({
        code: "abandon_cleanup_unfinished",
        specExecutionId,
        cleanupPhase: phaseCase.phase,
      });
      // refusals-name-remedy: the executable retry, with the target id.
      expect(finding.remedy).toMatch(
        new RegExp(
          `cctl spec abandon .*--execution ${SPINE_WORKFLOW_EXECUTION_ID}`,
        ),
      );
      expect(finding.remedy.toLowerCase()).toContain("retry");

      world.cleanupFaults.beforeOp = null;
      expect((await abandon()).status).toBe(200);
      expect(row(specExecutionId).state).toBe("abandoned");
      expect(lifecycleFindings(await report())).toEqual([]);
    });
  }

  /** Strand the spec row on its run, the way pre-coordinator abandons did. */
  function strandRun(specExecutionId: string): void {
    world.repos.delivery.updateExecutionLifecycle({
      executionId: specExecutionId,
      state: "abandoned",
      deliveredAt: null,
      abandonedReason: "legacy abandonment that stranded its run",
      updatedAt: world.now(),
    });
  }

  /**
   * The argv a remedy prints, lifted out of the sentence and run verbatim.
   * A remedy is only a remedy if THIS is what exits 0, `--reason` included.
   */
  function printedCommands(remedy: string): string[][] {
    const quoted = remedy.match(/cctl workflow live [a-z]+[^']*/g) ?? [];
    return quoted.map((command) =>
      command
        // A single token: the placeholder stands for one shell argument, and
        // splitting a prose reason into positional args would test the parser
        // rather than the recovery.
        .replace(/<reason>/g, "legacy-abandon-recovery")
        .trim()
        .split(/\s+/)
        .slice(1),
    );
  }

  async function runPrinted(remedy: string): Promise<void> {
    const host = bridgeHost(world);
    const commands = printedCommands(remedy);
    expect(commands.length).toBeGreaterThan(0);
    for (const argv of commands) {
      const result = await runCli(argv, cliEnv, host);
      expect(
        result.exitCode,
        `${argv.join(" ")} failed: ${result.stderr}`,
      ).toBe(0);
    }
  }

  it("reports a lease-holding running orphan and clears it through the exact command printed", async () => {
    const { specExecutionId } = await liveExecution();
    // The legacy orphan shape: pre-coordinator abandonment touched spec state
    // only. No coordinator re-entry exists from `abandoned`, so the remedy has
    // to be the workflow-side recovery verb rather than another abandon.
    strandRun(specExecutionId);
    const stranded = activeWorkflow();
    expect(
      holdsExecutionLease(
        stranded.status,
        stranded.haltReason,
        stranded.abandonment,
      ),
    ).toBe(true);

    const finding = onlyFinding(lifecycleFindings(await report()));
    expect(finding).toMatchObject({
      code: "abandoned_execution_workflow_unreleased",
      specExecutionId,
      workflowExecutionId: stranded.id,
      ownsExecutionSlot: true,
    });
    expect(finding.remedy).toContain("cctl workflow live abort");
    // Abort releases the lease by itself, so there is no second command — and
    // no release verb left to name.
    expect(finding.remedy).not.toContain("release --reason");

    await runPrinted(finding.remedy);
    expectLeaseReleased();
    expect(lifecycleFindings(await report())).toEqual([]);
  });

  it("names abandon for a stranded run whose resumable halt still holds the lease", async () => {
    const { specExecutionId } = await liveExecution();
    // A resumable halt is terminal yet lease-HOLDING, and abandon is the one
    // act that ends that tenure while preserving the halt reason.
    await world.haltWorkflowExecution({
      type: "execution_loop_failed",
      contextId: null,
      message: "halted before the spec gave up on it",
      cause: "unknown",
    });
    strandRun(specExecutionId);
    const stranded = activeWorkflow();
    expect(stranded.status).toBe("halted");
    expect(
      holdsExecutionLease(
        stranded.status,
        stranded.haltReason,
        stranded.abandonment,
      ),
    ).toBe(true);

    const finding = onlyFinding(lifecycleFindings(await report()));
    expect(finding).toMatchObject({
      code: "abandoned_execution_workflow_unreleased",
      workflowExecutionId: stranded.id,
      ownsExecutionSlot: true,
    });
    expect(finding.remedy).toContain(
      `cctl workflow abandon --reason <reason> --execution ${stranded.id}`,
    );
    expect(finding.remedy).not.toContain("abort");
  });

  it("does not report a stranded run whose halt cannot be resumed — History already owns it", async () => {
    const { specExecutionId } = await liveExecution();
    // A non-resumable halt holds no lease (R4.2): it blocks nothing, no act
    // addresses it, and the next launch normalizes the row. Reporting it would
    // be a finding that never clears.
    await world.haltWorkflowExecution({
      type: "recovery_error",
      message: "unrecoverable",
    });
    const stranded = activeWorkflow();
    expect(
      holdsExecutionLease(
        stranded.status,
        stranded.haltReason,
        stranded.abandonment,
      ),
    ).toBe(false);
    strandRun(specExecutionId);

    expect(lifecycleFindings(await report())).toEqual([]);
  });

  it("does not report an abandoned execution whose run was already aborted while paused", async () => {
    const { specExecutionId } = await liveExecution();
    // Pausing then aborting is the ordinary way a parked run ends: `aborted`
    // releases the lease automatically, so nothing is left to report.
    await world.pauseWorkflowExecution();
    const paused = activeWorkflow();
    expect(isTerminalStatus(paused.status)).toBe(false);
    const aborted = await world.postWorkflowRoute("ABORT", {
      reason: "parked this run for later",
    });
    expect(aborted.status).toBe(200);
    expect(world.readActiveWorkflowExecution()).toBeNull();
    strandRun(specExecutionId);

    expect(lifecycleFindings(await report())).toEqual([]);
  });

  it("reports no consistency findings for a healthy running execution", async () => {
    await liveExecution();
    const value = await report();
    expect(value.consistencyFindings).toEqual([]);
    expect(value.ok).toBe(true);
  });

  it("renders every finding with its remedy through the one CLI verify renderer", async () => {
    const { specExecutionId } = await liveExecution();
    world.cleanupFaults.beforeOp = (op) => {
      if (op === "abort") throw new Error("injected abort fault");
    };
    await abandon();

    const result = await runCli(
      ["spec", "verify", SLUG],
      cliEnv,
      bridgeHost(world),
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("execution-lifecycle");
    expect(result.stderr).toContain(specExecutionId);
    expect(result.stderr).toContain("cctl spec abandon");
  });
});

/**
 * Ticket #50's dead end as `cctl spec verify` reports it: which live proposals
 * are stranded, and — per proposal — the act that actually disposes of THAT
 * one. A remedy the dismiss act would refuse is worse than no remedy, so
 * eligibility comes from the shared supersession predicate and every remedy the
 * report names is run here against the production route.
 */
describe("spec verify reports proposal-integrity consistency findings", () => {
  let world: SpecSpineWorld;

  beforeEach(() => {
    resetJobQueue();

    world = createSpecSpineWorld();
    setPublicationBroadcastForTesting(() => ({ delivered: true }));
  });

  afterEach(() => {
    resetJobQueue();

    _resetPublicationForTesting();
  });

  async function report(): Promise<IntegrityReport> {
    const response = await world.getRoute("getSpecVerifyGET", { slug: SLUG });
    expect(response.status).toBe(200);
    return integrityReportSchema.parse(await response.json());
  }

  function proposalFindings(
    value: IntegrityReport,
  ): Extract<SpecConsistencyFinding, { family: "proposal-integrity" }>[] {
    return value.consistencyFindings.filter(
      (finding) => finding.family === "proposal-integrity",
    );
  }

  /** Clone `base` into a new revision and propose it, at the repository. */
  async function proposeFromBase(
    specId: string,
    id: string,
    baseRevisionId: string,
    at: string,
  ): Promise<SpecRevision> {
    await world.repos.specs.createDraftFromBase({
      id,
      specId,
      baseRevisionId,
      authoringStage: "plan",
      createdAt: at,
    });
    return world.repos.specs.proposeRevision({
      revisionId: id,
      proposedAt: at,
    });
  }

  /**
   * #50's live shape, built at the repository because the propose guard now
   * prevents the routes from producing it: a proposed revision, and a revision
   * cloned off its approved BASE approved above it.
   */
  async function strandedSpec(): Promise<{
    specId: string;
    stranded: SpecRevision;
    superseding: SpecRevision;
    approvedBase: string;
  }> {
    const authored = await authorSpineDraft(world, SLUG);
    await proposeSpineRevision(world, SLUG, authored);
    const approvedBase = authored.designRevisionId;
    await proposeFromBase(
      authored.specId,
      "revision-superseding",
      approvedBase,
      "2026-08-06T09:00:00.000Z",
    );
    const superseding = await world.repos.specs.approveRevision({
      revisionId: "revision-superseding",
      approvedAt: "2026-08-06T09:00:02.000Z",
    });
    const stranded = await world.repos.specs.findRevision(
      authored.draftRevisionId,
    );
    if (stranded === null) throw new Error("fixture revision missing");
    return { specId: authored.specId, stranded, superseding, approvedBase };
  }

  it("reports a superseded live proposal with the dismiss remedy, and the production dismiss act clears it", async () => {
    const { stranded, superseding } = await strandedSpec();

    const findings = proposalFindings(await report());
    expect(findings).toHaveLength(1);
    expect(findings.at(0)).toMatchObject({
      code: "superseded_proposal",
      revisionId: stranded.id,
      revisionNumber: stranded.number,
      supersededByRevisionId: superseding.id,
    });
    // The remedy names the act AND both revision ids a reader has to reconcile.
    expect(findings.at(0)?.remedy).toContain("Dismiss");
    expect(findings.at(0)?.remedy).toContain(stranded.id);
    expect(findings.at(0)?.detail).toContain(superseding.id);

    const dismissed = await world.postAction(
      SLUG,
      "dismiss-superseded",
      {
        revisionId: stranded.id,
        reason: "The design base was approved above it.",
      },
      "human",
    );
    expect(dismissed.status).toBe(200);

    expect(proposalFindings(await report())).toEqual([]);
  });

  it("does not report a proposal that a later approval descends from", async () => {
    const authored = await authorSpineDraft(world, SLUG);
    await proposeSpineRevision(world, SLUG, authored);
    // Approved DESCENDANT: the proposal's content is carried forward, so
    // nothing was forked past and nothing is stranded.
    await proposeFromBase(
      authored.specId,
      "revision-descendant",
      authored.draftRevisionId,
      "2026-08-06T09:05:00.000Z",
    );
    await world.repos.specs.approveRevision({
      revisionId: "revision-descendant",
      approvedAt: "2026-08-06T09:05:02.000Z",
    });

    expect(proposalFindings(await report())).toEqual([]);
  });

  it("reports one finding per live proposal with a per-proposal remedy, dismissing only where the predicate passes", async () => {
    const { specId, stranded, superseding } = await strandedSpec();
    const competing = await proposeFromBase(
      specId,
      "revision-successor",
      superseding.id,
      "2026-08-06T09:10:00.000Z",
    );

    const findings = proposalFindings(await report());
    expect(findings).toHaveLength(2);
    const bySupersession = findings.find(
      (finding) => finding.revisionId === stranded.id,
    );
    const byReview = findings.find(
      (finding) => finding.revisionId === competing.id,
    );
    expect(bySupersession).toMatchObject({
      code: "superseded_proposal",
      supersededByRevisionId: superseding.id,
    });
    expect(bySupersession?.remedy).toContain("Dismiss");
    // Nothing forked past the successor, so offering dismissal on it would name
    // an act the dismiss route refuses. It gets the human review acts instead.
    expect(byReview).toMatchObject({
      code: "competing_live_proposal",
      supersededByRevisionId: null,
    });
    expect(byReview?.remedy).not.toContain("Dismiss superseded proposal");
    expect(byReview?.remedy).toContain("Request Changes");
    expect(byReview?.remedy).toContain(competing.id);
    // Sign-off is NOT offered: a competing finding means a live sibling exists,
    // and the sign-off recheck refuses whenever the target forks past one — the
    // same "remedy the act would refuse" failure this family exists to avoid.
    expect(byReview?.remedy.toLowerCase()).not.toContain("sign");
    // Nor Withdraw: the act exists on the route, but Studio ships no control
    // for it, so naming it would send a reader to a surface with no button.
    expect(byReview?.remedy).not.toContain("Withdraw");
  });

  /**
   * The finding clears on either human disposal, run through the production
   * route. Only `request-changes` is NAMED as the remedy — it is the one with
   * a Studio control — but `withdraw` must clear it too, or the report would
   * keep accusing a proposal an operator already ended.
   */
  for (const act of ["request-changes", "withdraw"] as const) {
    it(`clears the competing proposal through the ${act} act, leaving the superseded one reported`, async () => {
      const { specId, stranded, superseding } = await strandedSpec();
      const competing = await proposeFromBase(
        specId,
        "revision-successor",
        superseding.id,
        "2026-08-06T09:10:00.000Z",
      );

      const concluded = await world.postAction(
        SLUG,
        act,
        { revisionId: competing.id },
        "human",
      );
      expect(concluded.status).toBe(200);

      const findings = proposalFindings(await report());
      expect(findings).toHaveLength(1);
      expect(findings.at(0)).toMatchObject({
        code: "superseded_proposal",
        revisionId: stranded.id,
      });
    });
  }

  it("carries both families in one report shape with no parallel section", async () => {
    const authored = await authorSpineDraft(world, SLUG);
    await proposeSpineRevision(world, SLUG, authored);
    await approveAndSignOffSpine(world, SLUG, authored);
    const started = await startSpineExecution(world, SLUG, authored);
    await startSpineWorkflowThroughProductionGate(world, started);
    world.cleanupFaults.beforeOp = (op) => {
      if (op === "abort") throw new Error("injected abort fault");
    };
    await world.postAction(
      SLUG,
      "abandon-execution",
      { executionId: SPINE_WORKFLOW_EXECUTION_ID, reason: "replanned" },
      "agent",
    );
    const proposal = await proposeFromBase(
      authored.specId,
      "revision-parallel-proposal",
      authored.draftRevisionId,
      "2026-08-06T09:20:00.000Z",
    );
    await proposeFromBase(
      authored.specId,
      "revision-parallel-superseding",
      authored.draftRevisionId,
      "2026-08-06T09:21:00.000Z",
    );
    await world.repos.specs.approveRevision({
      revisionId: "revision-parallel-superseding",
      approvedAt: "2026-08-06T09:21:02.000Z",
    });

    const response = await world.getRoute("getSpecVerifyGET", { slug: SLUG });
    const payload: unknown = await response.json();
    // One report shape: the strict schema accepts it, and the report carries no
    // key beyond the four the single schema declares — a second family cannot
    // arrive as a parallel section.
    const value = integrityReportSchema.parse(payload);
    expect(Object.keys(payload as Record<string, unknown>).sort()).toEqual([
      "checkedRevisionIds",
      "consistencyFindings",
      "mismatches",
      "ok",
    ]);
    expect(
      value.consistencyFindings.map((finding) => finding.family).sort(),
    ).toEqual(["execution-lifecycle", "proposal-integrity"]);
    expect(
      value.consistencyFindings.every(
        (finding) => finding.remedy.length > 0 && finding.detail.length > 0,
      ),
    ).toBe(true);
    expect(
      value.consistencyFindings.some(
        (finding) =>
          finding.family === "proposal-integrity" &&
          finding.revisionId === proposal.id,
      ),
    ).toBe(true);

    // One renderer, not one per family: a single `cctl spec verify` prints both
    // families' findings with their remedies, so neither family can drift into
    // a section of its own.
    const rendered = await runCli(
      ["spec", "verify", SLUG],
      cliEnv,
      bridgeHost(world),
    );
    expect(rendered.exitCode).not.toBe(0);
    for (const finding of value.consistencyFindings) {
      expect(rendered.stderr).toContain(finding.family);
      expect(rendered.stderr).toContain(finding.remedy);
    }
  });
});
