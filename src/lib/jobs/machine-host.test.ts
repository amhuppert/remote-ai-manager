import { describe, it, expect, vi, beforeEach } from "vitest";
import { createActor, fromPromise, setup, assign, toPromise } from "xstate";
import { getErrorMessage } from "@/lib/shared/errors";
import type { BackgroundJob } from "./schemas";
import {
  observePhaseTransitions,
  createJobActorSubscription,
  dispatchMachineJob,
  abortJobActor,
  tearDownJobActor,
  _resetJobActorRegistryForTesting,
  type JobDispatchHost,
  type JobDispatchResult,
  type JobMachineActor,
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
        persistProgress() {},
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

  /**
   * A job the host closed out itself: it recorded a verdict and is tearing the
   * actor down. Returns the pieces a test needs to drive what the actor does
   * next.
   */
  async function subscribeToClosedOutJob(): Promise<{
    actor: ReturnType<
      typeof createActor<ReturnType<typeof buildAbortableMachine>>
    >;
    job: BackgroundJob;
    published: string[];
    release: ReturnType<typeof vi.fn>;
    onComplete: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
  }> {
    const actor = createActor(buildAbortableMachine());
    const job = buildJob();
    const published: string[] = [];
    const release = vi.fn();
    const onComplete = vi.fn();
    const onError = vi.fn();

    createJobActorSubscription(
      actor,
      job,
      {
        publishStatus(j) {
          published.push(`${j.status}:${j.errorMessage ?? "-"}`);
        },
        persistProgress() {},
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
      { onComplete, onError },
    );
    actor.start();
    await new Promise((r) => setTimeout(r, 10));

    job.status = "failed";
    job.errorMessage = "Job stopped reporting progress (stale recovery)";
    job.completedAt = new Date().toISOString();

    return { actor, job, published, release, onComplete, onError };
  }

  it("keeps a terminal state the host already recorded when the actor stops", async () => {
    const { actor, job, published, release, onComplete, onError } =
      await subscribeToClosedOutJob();

    actor.stop();
    await new Promise((r) => setTimeout(r, 10));

    expect(job.status).toBe("failed");
    expect(job.errorMessage).toBe(
      "Job stopped reporting progress (stale recovery)",
    );
    expect(published).toEqual(["running:-"]);
    expect(release).toHaveBeenCalledTimes(1);
    // A caller awaiting this actor still gets an answer — the host closed the
    // job record, not the promise the caller is on.
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(getErrorMessage(onError.mock.calls[0]?.[0])).toContain(
      "stale recovery",
    );
  });

  it("answers the awaiting caller when a closed-out job's machine reaches its own final state", async () => {
    const { actor, job, published, onComplete, onError } =
      await subscribeToClosedOutJob();

    actor.send({ type: "ABORT" });
    await new Promise((r) => setTimeout(r, 10));

    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0]?.[0]).toMatchObject({ status: "failed" });
    // The machine's own terminal still does not overwrite the host's verdict.
    expect(job.errorMessage).toBe(
      "Job stopped reporting progress (stale recovery)",
    );
    expect(published).toEqual(["running:-"]);
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
        persistProgress() {},
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
// Abortable machine — a job that only ends when told to
// ============================================================

/**
 * A never-settling step plus a root ABORT handler: the shape every job machine
 * an operator can stop has, reduced to what the registry needs to prove.
 */
function buildAbortableMachine() {
  return setup({
    types: {
      context: {} as HostTestContext,
      events: {} as { type: "ABORT" },
      output: {} as HostTestOutput,
    },
    actors: {
      work: fromPromise<string, void>(() => new Promise<string>(() => {})),
    },
  }).createMachine({
    id: "abortableHostTest",
    context: { phase: null, result: null, finalStatus: null },
    initial: "working",
    on: { ABORT: ".failed" },
    states: {
      working: {
        entry: assign({ phase: "working" as string | null }),
        invoke: { src: "work" },
      },
      failed: {
        type: "final",
        entry: assign({
          phase: null,
          finalStatus: "failed" as const,
          result: "Aborted by operator" as string | null,
        }),
      },
    },
    output: ({ context }) => ({
      status: context.finalStatus ?? ("completed" as const),
      result: context.result,
    }),
  });
}

/**
 * The shape of a job machine's unrecallable phase: the root ABORT is overridden
 * by a transition that records the request without leaving the state (the merge
 * machine's in-flight publish).
 */
function buildDeferringAbortMachine() {
  return setup({
    types: {
      context: {} as HostTestContext,
      events: {} as { type: "ABORT" },
      output: {} as HostTestOutput,
    },
    actors: {
      work: fromPromise<string, void>(() => new Promise<string>(() => {})),
    },
  }).createMachine({
    id: "deferringAbortHostTest",
    context: { phase: null, result: null, finalStatus: null },
    initial: "unrecallable",
    on: { ABORT: ".failed" },
    states: {
      unrecallable: {
        entry: assign({ phase: "unrecallable" as string | null }),
        on: { ABORT: { actions: assign({ result: "stop recorded" }) } },
        invoke: { src: "work" },
      },
      failed: {
        type: "final",
        entry: assign({
          phase: null,
          finalStatus: "failed" as const,
          result: "Aborted by operator" as string | null,
        }),
      },
    },
    output: ({ context }) => ({
      status: context.finalStatus ?? ("completed" as const),
      result: context.result,
    }),
  });
}

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
      params.decorateJob?.(job);
      return { ok: true, value: { job, release } };
    },
    publishStatus(job) {
      published.push({ ...job });
    },
    persistProgress() {},
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

// ============================================================
// Actor handle registry
// ============================================================

describe("job actor registry", () => {
  beforeEach(() => {
    _resetJobActorRegistryForTesting();
  });

  it("drives the dispatched job's machine to its terminal state on ABORT", async () => {
    const { host, published, release } = buildDispatchHost();
    const machine = buildAbortableMachine();

    dispatchMachineJob<HostTestContext, HostTestOutput>({
      jobType: "merge",
      session: {
        projectPath: "/p",
        projectName: "proj",
        sessionName: "sess",
        branchName: "csm/sess",
      },
      host,
      createJobActor: () => createActor(machine),
      logStart: () => {},
      subscription: {
        phaseOf: (context) => context.phase ?? undefined,
        mapOutput(job, output) {
          job.status = output.status;
          job.errorMessage = output.result ?? undefined;
          job.phase = undefined;
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(published[published.length - 1]?.status).toBe("running");

    expect(abortJobActor("dispatched-1")).toBe("stopping");
    await new Promise((r) => setTimeout(r, 10));

    const terminal = published[published.length - 1];
    expect(terminal?.status).toBe("failed");
    expect(terminal?.errorMessage).toBe("Aborted by operator");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("separates a stop the machine only recorded from one that ends the run", async () => {
    const { host, published } = buildDispatchHost();
    const machine = buildDeferringAbortMachine();

    dispatchMachineJob<HostTestContext, HostTestOutput>({
      jobType: "merge",
      session: {
        projectPath: "/p",
        projectName: "proj",
        sessionName: "sess",
        branchName: "csm/sess",
      },
      host,
      createJobActor: () => createActor(machine),
      logStart: () => {},
      subscription: {
        phaseOf: (context) => context.phase ?? undefined,
        mapOutput(job, output) {
          job.status = output.status;
          job.errorMessage = output.result ?? undefined;
          job.phase = undefined;
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(abortJobActor("dispatched-1")).toBe("deferred");
    await new Promise((r) => setTimeout(r, 10));

    // The run keeps going: a caller told "stopped" here would be told wrong.
    expect(published[published.length - 1]?.status).toBe("running");
  });

  it("forgets the handle once the job reaches a terminal state", async () => {
    const { host } = buildDispatchHost();
    const machine = buildTestMachine(async () => "ok");

    dispatchMachineJob<HostTestContext, HostTestOutput>({
      jobType: "merge",
      session: {
        projectPath: "/p",
        projectName: "proj",
        sessionName: "sess",
        branchName: "csm/sess",
      },
      host,
      createJobActor: () => createActor(machine),
      logStart: () => {},
      subscription: {
        phaseOf: (context) => context.phase ?? undefined,
        mapOutput(job, output) {
          job.status = output.status;
          job.phase = undefined;
        },
      },
    });

    await new Promise((r) => setTimeout(r, 25));

    expect(abortJobActor("dispatched-1")).toBe("no-actor");
  });

  it("reports no handle for a job id that was never dispatched", () => {
    expect(abortJobActor("never-dispatched")).toBe("no-actor");
  });
});

describe("tearDownJobActor", () => {
  beforeEach(() => {
    _resetJobActorRegistryForTesting();
  });

  /** Dispatch a job on `actor` and hand back the live job record. */
  function dispatchTeardownJob(
    actor: JobMachineActor<HostTestContext, HostTestOutput>,
  ): {
    job: BackgroundJob;
    published: BackgroundJob[];
    release: () => void;
  } {
    const { host, published, release } = buildDispatchHost();
    let dispatched: BackgroundJob | undefined;
    dispatchMachineJob<HostTestContext, HostTestOutput>({
      jobType: "merge",
      session: {
        projectPath: "/p",
        projectName: "proj",
        sessionName: "sess",
        branchName: "csm/sess",
      },
      host,
      createJobActor: () => actor,
      decorateJob: (job) => {
        dispatched = job;
      },
      logStart: () => {},
      subscription: {
        phaseOf: (context) => context.phase ?? undefined,
        mapOutput(job, output) {
          job.status = output.status;
          job.errorMessage = output.result ?? undefined;
          job.phase = undefined;
        },
      },
    });
    if (dispatched === undefined) throw new Error("job was never prepared");
    return { job: dispatched, published, release };
  }

  it("lets a machine that answers the stop end its own run", async () => {
    const { published, release } = dispatchTeardownJob(
      createActor(buildAbortableMachine()),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(tearDownJobActor("dispatched-1")).toBe("aborted");
    await new Promise((r) => setTimeout(r, 10));

    expect(published[published.length - 1]?.status).toBe("failed");
    expect(release).toHaveBeenCalledTimes(1);
    expect(abortJobActor("dispatched-1")).toBe("no-actor");
  });

  it("stops an actor outright when the machine stays where it was", async () => {
    const { job, release } = dispatchTeardownJob(
      createActor(buildDeferringAbortMachine()),
    );
    await new Promise((r) => setTimeout(r, 10));

    // The caller records the job's verdict before tearing the actor down.
    job.status = "failed";
    job.errorMessage = "Job stopped reporting progress (stale recovery)";
    job.completedAt = new Date().toISOString();

    expect(tearDownJobActor("dispatched-1")).toBe("stopped");
    await new Promise((r) => setTimeout(r, 10));

    // Nothing is left running for the job, and the host's verdict stands.
    expect(abortJobActor("dispatched-1")).toBe("no-actor");
    expect(job.errorMessage).toBe(
      "Job stopped reporting progress (stale recovery)",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reports no handle for a job with no live actor", () => {
    expect(tearDownJobActor("never-dispatched")).toBe("no-actor");
  });
});
