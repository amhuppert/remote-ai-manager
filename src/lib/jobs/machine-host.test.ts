import { describe, it, expect, vi } from "vitest";
import { createActor, fromPromise, setup, assign, toPromise } from "xstate";
import type { BackgroundJob } from "./schemas";
import {
  observePhaseTransitions,
  createJobActorSubscription,
  dispatchMachineJob,
  type JobDispatchHost,
  type JobDispatchResult,
} from "./machine-host";

// ============================================================
// Tiny real machine — phase-annotated two-step pipeline
// ============================================================

interface HostTestContext {
  phase: string | null;
  result: string | null;
  finalStatus: "completed" | "failed" | null;
}

interface HostTestOutput {
  status: "completed" | "failed";
  result: string | null;
}

function buildTestMachine(work: () => Promise<string>) {
  return setup({
    types: {
      context: {} as HostTestContext,
      output: {} as HostTestOutput,
    },
    actors: {
      work: fromPromise<string, void>(async () => work()),
    },
  }).createMachine({
    id: "hostTest",
    context: { phase: null, result: null, finalStatus: null },
    initial: "stepOne",
    states: {
      stepOne: {
        entry: assign({ phase: "one" as string | null }),
        invoke: {
          src: "work",
          onDone: {
            target: "stepTwo",
            actions: assign({ result: ({ event }) => event.output }),
          },
          onError: "failed",
        },
      },
      stepTwo: {
        entry: assign({ phase: "two" as string | null }),
        invoke: {
          src: "work",
          onDone: "completed",
          onError: "failed",
        },
      },
      completed: {
        type: "final",
        entry: assign({
          phase: null,
          finalStatus: "completed" as const,
        }),
      },
      failed: {
        type: "final",
        entry: assign({
          phase: null,
          finalStatus: "failed" as const,
        }),
      },
    },
    output: ({ context }) => ({
      status: context.finalStatus ?? ("completed" as const),
      result: context.result,
    }),
  });
}

function buildJob(): BackgroundJob {
  return {
    jobId: "job-1",
    jobType: "merge",
    status: "running",
    projectName: "proj",
    sessionName: "sess",
    branchName: "csm/sess",
    startedAt: new Date().toISOString(),
  };
}

// ============================================================
// observePhaseTransitions
// ============================================================

describe("observePhaseTransitions", () => {
  it("emits each distinct phase once while the actor is active", async () => {
    const machine = buildTestMachine(async () => "ok");
    const actor = createActor(machine);
    const phases: (string | undefined)[] = [];

    observePhaseTransitions(
      actor,
      (context: HostTestContext) => context.phase ?? undefined,
      (phase) => phases.push(phase),
    );
    actor.start();
    await toPromise(actor);

    expect(phases).toEqual(["one", "two"]);
  });

  it("does not re-emit when consecutive snapshots share a phase", async () => {
    const machine = buildTestMachine(async () => "ok");
    const actor = createActor(machine);
    const phases: (string | undefined)[] = [];

    observePhaseTransitions(
      actor,
      (context: HostTestContext) => context.phase ?? undefined,
      (phase) => phases.push(phase),
    );
    actor.start();
    await toPromise(actor);

    for (let i = 1; i < phases.length; i++) {
      expect(phases[i]).not.toBe(phases[i - 1]);
    }
  });
});

// ============================================================
// createJobActorSubscription
// ============================================================

describe("createJobActorSubscription", () => {
  it("publishes phase updates, maps the terminal output, then releases", async () => {
    const machine = buildTestMachine(async () => "done-result");
    const actor = createActor(machine);
    const job = buildJob();
    const published: string[] = [];
    const release = vi.fn();

    createJobActorSubscription(
      actor,
      job,
      {
        publishStatus(j) {
          published.push(`${j.status}:${j.phase ?? "-"}`);
        },
        release,
      },
      {
        phaseOf: (context) => context.phase ?? undefined,
        mapOutput(j, output) {
          j.status = output.status;
          j.errorMessage = output.result ?? undefined;
          j.phase = undefined;
        },
      },
    );
    actor.start();
    await toPromise(actor);
    await new Promise((r) => setTimeout(r, 10));

    expect(job.status).toBe("completed");
    expect(job.errorMessage).toBe("done-result");
    expect(job.completedAt).toBeDefined();
    expect(release).toHaveBeenCalledTimes(1);
    // Two phase publications then the terminal publication.
    expect(published).toEqual(["running:one", "running:two", "completed:-"]);
  });

  it("marks the job failed and releases when the actor errors", async () => {
    const throwingMachine = setup({
      types: { context: {} as HostTestContext, output: {} as HostTestOutput },
      actors: {
        work: fromPromise<string, void>(async () => {
          throw new Error("boom");
        }),
      },
    }).createMachine({
      id: "hostTestError",
      context: { phase: null, result: null, finalStatus: null },
      initial: "stepOne",
      states: {
        // No onError: the actor itself transitions to an error status.
        stepOne: { invoke: { src: "work" } },
      },
      output: ({ context }) => ({
        status: context.finalStatus ?? ("completed" as const),
        result: context.result,
      }),
    });
    const actor = createActor(throwingMachine);
    const job = buildJob();
    const release = vi.fn();
    const published: string[] = [];

    createJobActorSubscription(
      actor,
      job,
      {
        publishStatus(j) {
          published.push(j.status);
        },
        release,
      },
      {
        phaseOf: (context) => context.phase ?? undefined,
        mapOutput() {},
      },
    );
    actor.start();
    await new Promise((r) => setTimeout(r, 10));

    expect(job.status).toBe("failed");
    expect(job.errorMessage).toBe("boom");
    expect(job.completedAt).toBeDefined();
    expect(release).toHaveBeenCalledTimes(1);
    expect(published).toEqual(["failed"]);
  });
});

// ============================================================
// dispatchMachineJob
// ============================================================

function buildDispatchHost(overrides?: {
  prepare?: JobDispatchHost["prepare"];
}): { host: JobDispatchHost; published: BackgroundJob[]; release: () => void } {
  const published: BackgroundJob[] = [];
  const release = vi.fn();
  const host: JobDispatchHost = {
    prepare(params) {
      const job: BackgroundJob = {
        jobId: "dispatched-1",
        jobType: params.jobType,
        status: "running",
        projectName: params.projectName,
        sessionName: params.sessionName,
        branchName: params.branchName,
        ...(params.targetBranch && { targetBranch: params.targetBranch }),
        startedAt: new Date().toISOString(),
      };
      return { ok: true, value: { job, release } };
    },
    publishStatus(job) {
      published.push({ ...job });
    },
  };
  if (overrides?.prepare) host.prepare = overrides.prepare;
  return { host, published, release };
}

describe("dispatchMachineJob", () => {
  it("prepares, decorates, starts the actor, and resolves the terminal job", async () => {
    const { host, published, release } = buildDispatchHost();
    const machine = buildTestMachine(async () => "ok");
    const logStart = vi.fn();

    const result = dispatchMachineJob<HostTestContext, HostTestOutput>({
      jobType: "merge",
      session: {
        projectPath: "/p",
        projectName: "proj",
        sessionName: "sess",
        branchName: "csm/sess",
        targetBranch: "main",
      },
      host,
      createJobActor: (jobId) => {
        expect(jobId).toBe("dispatched-1");
        return createActor(machine);
      },
      decorateJob: (job) => {
        job.resolutionContext = "ctx";
      },
      logStart,
      subscription: {
        phaseOf: (context) => context.phase ?? undefined,
        mapOutput(job, output) {
          job.status = output.status;
          job.phase = undefined;
        },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.jobId).toBe("dispatched-1");
    expect(logStart).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 25));
    const terminal = published[published.length - 1];
    expect(terminal?.status).toBe("completed");
    expect(terminal?.resolutionContext).toBe("ctx");
    expect(terminal?.targetBranch).toBe("main");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("propagates the prepare error without creating an actor", () => {
    const { host } = buildDispatchHost({
      prepare: () =>
        ({ ok: false, error: "JOB_ALREADY_RUNNING" }) as JobDispatchResult<{
          job: BackgroundJob;
          release(): void;
        }>,
    });
    const createJobActor = vi.fn();

    const result = dispatchMachineJob<HostTestContext, HostTestOutput>({
      jobType: "commit",
      session: {
        projectPath: "/p",
        projectName: "proj",
        sessionName: "sess",
        branchName: "csm/sess",
      },
      host,
      createJobActor,
      logStart: () => {},
      subscription: {
        phaseOf: () => undefined,
        mapOutput() {},
      },
    });

    expect(result).toEqual({ ok: false, error: "JOB_ALREADY_RUNNING" });
    expect(createJobActor).not.toHaveBeenCalled();
  });
});
