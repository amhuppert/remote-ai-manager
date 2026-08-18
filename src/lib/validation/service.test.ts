import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@/lib/logging";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type { SSEEvent } from "@/lib/api/sse-events";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import {
  createValidationRunsRepo,
  type ValidationRunsRepo,
} from "@/lib/state-store/validation-runs-repo";
import type {
  SpawnValidationParams,
  ValidationProcessHandle,
  ValidationRunOutcome,
} from "./process-runner";
import type { ValidationProcessIdentity } from "./recovery";
import {
  createValidationScheduler,
  type ValidationScheduler,
} from "./scheduler";
import {
  repoValidationConfigSchema,
  type GlobalValidationConfig,
  type RepoValidationConfig,
  type ValidationRunEvent,
  type ValidationRunRecord,
} from "./schemas";
import {
  createValidationService,
  type ResolvedValidationCaller,
  type ValidationService,
  type ValidationSubmitRequest,
  type ValidationSystemSubmitRequest,
} from "./service";

// ============================================================
// Harness: real repo/scheduler/leases over SQLite; the process
// boundary (runner, identity) and config/resolver I/O are faked.
// ============================================================

interface FakeRun {
  params: SpawnValidationParams;
  complete(outcome: ValidationRunOutcome): void;
  cancelRequested: boolean;
  startConfirmed: boolean;
}

function createFakeRunner() {
  const spawns: SpawnValidationParams[] = [];
  const runs = new Map<string, FakeRun>();
  let nextPid = 1000;
  let gate: Promise<void> | null = null;
  const runner = {
    spawns,
    runs,
    /** Observation hook fired when the service releases a start barrier. */
    onConfirmStart: null as ((runId: string) => void) | null,
    /** Delay spawn resolution until the returned release fn is called. */
    holdSpawns(): () => void {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      gate = held;
      return () => {
        if (gate === held) gate = null;
        release();
      };
    },
    spawn: async (params: SpawnValidationParams) => {
      if (gate) await gate;
      spawns.push(params);
      let settle!: (outcome: ValidationRunOutcome) => void;
      const outcome = new Promise<ValidationRunOutcome>((resolve) => {
        let settled = false;
        settle = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
      });
      const run: FakeRun = {
        params,
        // Production-shaped barrier: a workload cannot exit naturally while
        // still barriered, so a test driving an exit before the service
        // confirmed the start has caught a real ordering bug.
        complete: (value) => {
          if (value.kind === "exited" && !run.startConfirmed) {
            throw new Error(
              `run ${params.runId} completed before its start was confirmed`,
            );
          }
          settle(value);
        },
        cancelRequested: false,
        startConfirmed: false,
      };
      const handle: ValidationProcessHandle = {
        processGroupPid: nextPid++,
        confirmStart: () => {
          run.startConfirmed = true;
          runner.onConfirmStart?.(params.runId);
        },
        wait: () => outcome,
        cancel: () => {
          run.cancelRequested = true;
          settle({ kind: "cancelled", output: "" });
          return outcome;
        },
      };
      runs.set(params.runId, run);
      return { kind: "spawned" as const, handle };
    },
  };
  return runner;
}

const REPO_VALIDATION = repoValidationConfigSchema.parse({
  commands: {
    test: {
      command: {
        full: "scripts/validate/test-full-suite.sh",
        changed: "scripts/validate/test.sh",
      },
      cost: 8,
      timeoutMs: 900_000,
      pathArgs: "paths",
    },
    typecheck: {
      command: { full: "scripts/validate/typecheck.sh" },
      cost: 2,
      pathArgs: "forbid",
    },
    format: {
      command: {
        full: "scripts/validate/format-full.sh",
        changed: "scripts/validate/format.sh",
      },
      cost: 1,
      pathArgs: "forbid",
    },
  },
  preMerge: ["typecheck", "test"],
});

const SESSION_CALLER: ResolvedValidationCaller = {
  kind: "session",
  worktreePath: "/projects/app/.worktrees/s1",
  sessionName: "s1",
  branchName: "csm/s1",
  targetBranch: "main",
};

function laneCaller(
  overrides: Partial<
    Extract<ResolvedValidationCaller, { kind: "graph_lane" }>
  > = {},
): ResolvedValidationCaller {
  return {
    kind: "graph_lane",
    worktreePath: "/projects/app/.worktrees/s1.api",
    sessionName: "s1",
    branchName: "csm/s1-api",
    targetBranch: "csm/s1",
    executionId: "exec-1",
    contextId: "api",
    role: "context_validator",
    allowedCommands: [],
    scriptGateCommands: [],
    ...overrides,
  };
}

let fixture: PersistenceFixture;
let repo: ValidationRunsRepo;
let runner: ReturnType<typeof createFakeRunner>;
let events: SSEEvent[];
let resolved: ResolvedValidationCaller;
let service: ValidationService;
let identityKills: number[];

const benignIdentity: ValidationProcessIdentity = {
  classifyGroup: async () => "not_ours",
  killGroup: async () => {},
};

function buildService(
  opts: {
    identity?: ValidationProcessIdentity;
    db?: PersistenceFixture["db"];
    now?: () => Date;
    concurrencyLimit?: number;
    resolveCaller?(
      caller: ValidationSubmitRequest["caller"],
    ): Promise<ResolvedValidationCaller>;
    readGlobal?(): Promise<GlobalValidationConfig>;
    readRepoValidation?(
      projectPath: string,
    ): Promise<RepoValidationConfig | null>;
    wrapScheduler?(scheduler: ValidationScheduler): ValidationScheduler;
    logger?: Logger;
  } = {},
): ValidationService {
  const db = opts.db ?? fixture.db;
  const serviceRepo = createValidationRunsRepo(db);
  const transact = <T>(_label: string, fn: () => T): T => db.transaction(fn)();
  const scheduler = createValidationScheduler({
    repo: serviceRepo,
    transact,
    now: opts.now,
  });
  let idSeq = 0;
  return createValidationService({
    repo: serviceRepo,
    transact,
    scheduler: opts.wrapScheduler?.(scheduler) ?? scheduler,
    runner: { spawn: (params) => runner.spawn(params) },
    resolver: {
      resolveCaller: opts.resolveCaller ?? (async () => resolved),
    },
    config: {
      readRepoValidation:
        opts.readRepoValidation ?? (async () => REPO_VALIDATION),
      readGlobal:
        opts.readGlobal ??
        (async () => ({
          concurrencyLimit: opts.concurrencyLimit ?? 8,
          defaultTimeoutMs: 600_000,
        })),
    },
    identity: opts.identity ?? benignIdentity,
    now: opts.now,
    logger: opts.logger,
    publish: (event) => {
      events.push(event);
      return { delivered: true };
    },
    leaseTtlMs: 60_000,
    ids: {
      runId: () => `run-${++idSeq}`,
      nonce: () => `nonce-${idSeq}`,
    },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function phases(): string[] {
  return events
    .filter(
      (event): event is ValidationRunEvent => event.type === "validation-run",
    )
    .map((event) => event.phase);
}

function request(
  overrides: Partial<ValidationSubmitRequest> = {},
): ValidationSubmitRequest {
  return {
    source: "agent_cli",
    commandName: "typecheck",
    caller: {
      projectPath: "/projects/app",
      sessionName: "s1",
      conversationId: "c1",
    },
    ...overrides,
  };
}

function systemRequest(
  overrides: Partial<ValidationSystemSubmitRequest> = {},
): ValidationSystemSubmitRequest {
  return {
    source: "graph_script_validator",
    command: { kind: "registered", name: "typecheck" },
    scope: "changed",
    projectPath: "/projects/app",
    conversationId: "c1",
    target: {
      worktreePath: "/projects/app/.worktrees/s1",
      sessionName: "s1",
      branchName: "csm/s1",
      targetBranch: "main",
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-05T10:00:00.000Z"));
  fixture = createPersistenceFixture();
  repo = createValidationRunsRepo(fixture.db);
  runner = createFakeRunner();
  events = [];
  identityKills = [];
  resolved = SESSION_CALLER;
  service = buildService();
});

afterEach(() => {
  fixture.close();
  vi.useRealTimers();
});

describe("service-owned listing", () => {
  it("resolves caller policy and reports global capacity without exposing executables", async () => {
    resolved = laneCaller({
      role: "implementer",
      allowedCommands: ["typecheck"],
    });
    await service.submit(request({ commandName: "typecheck" }));

    const listed = await service.list(request().caller);

    expect(listed.kind).toBe("ok");
    if (listed.kind !== "ok") return;
    expect(listed.commands).toEqual([
      {
        name: "test",
        cost: 8,
        description: null,
        pathArgs: "paths",
        changedScope: "native",
        timeoutMs: 900_000,
        enabled: false,
      },
      {
        name: "typecheck",
        cost: 2,
        description: null,
        pathArgs: "forbid",
        changedScope: "full_fallback",
        timeoutMs: null,
        enabled: true,
      },
      {
        name: "format",
        cost: 1,
        description: null,
        pathArgs: "forbid",
        changedScope: "native",
        timeoutMs: null,
        enabled: false,
      },
    ]);
    expect(listed.capacity).toEqual({ limit: 8, inUse: 2, queueDepth: 0 });
    expect(listed.runs).toEqual([
      {
        runId: "run-1",
        commandName: "typecheck",
        status: "running",
        cost: 2,
        source: "agent_cli",
        projectPath: "/projects/app",
        conversationId: "c1",
        requestedScope: "changed",
        effectiveScope: "full",
        position: null,
      },
    ]);
    expect(listed.commands[0]).not.toHaveProperty("command");
  });
});

describe("policy gate before admission", () => {
  it("returns skipped_by_policy with zero scheduler or runner involvement", async () => {
    resolved = laneCaller({ role: "context_validator", allowedCommands: [] });

    const submission = await service.submit(request({ commandName: "test" }));

    expect(submission.kind).toBe("not_started");
    if (submission.kind !== "not_started") return;
    expect(submission.result.kind).toBe("skipped_by_policy");
    // The runner dependency was never invoked and no ledger row exists: the
    // no-op consumed no capacity and no queue position.
    expect(runner.spawns).toHaveLength(0);
    expect(repo.findStaleActive()).toHaveLength(0);
    expect(phases()).toEqual(["requested", "policy_skipped"]);
  });

  it("claims script-gate coverage only when the command is in that context's selection", async () => {
    resolved = laneCaller({ scriptGateCommands: ["test"] });
    const covered = await service.submit(request({ commandName: "test" }));
    expect(covered.kind).toBe("not_started");
    if (covered.kind !== "not_started") return;
    if (covered.result.kind !== "skipped_by_policy") return;
    expect(covered.result.message).toContain("handled by the script validator");

    resolved = laneCaller({ scriptGateCommands: [] });
    const uncovered = await service.submit(request({ commandName: "format" }));
    expect(uncovered.kind).toBe("not_started");
    if (uncovered.kind !== "not_started") return;
    if (uncovered.result.kind !== "skipped_by_policy") return;
    expect(uncovered.result.message).toContain("workflow policy disables it");
    expect(uncovered.result.message).not.toContain("script validator");
  });

  it("admits an allowed command for a lane caller with lane env identity", async () => {
    resolved = laneCaller({
      role: "implementer",
      allowedCommands: ["test", "typecheck"],
    });

    const submission = await service.submit(
      request({ commandName: "typecheck" }),
    );

    expect(submission.kind).toBe("accepted");
    const params = runner.spawns[0];
    expect(params?.contextId).toBe("api");
    expect(params?.worktreePath).toBe("/projects/app/.worktrees/s1.api");
    const row = repo.findById("run-1");
    expect(row?.workflowExecutionId).toBe("exec-1");
    expect(row?.workflowContextId).toBe("api");
    expect(row?.workflowRole).toBe("implementer");
  });
});

describe("submission lifecycle", () => {
  it("runs a session-caller command end to end with timing on the terminal row", async () => {
    const submission = await service.submit(
      request({
        commandName: "test",
        scopePaths: ["src/a.test.ts"],
        wait: false,
      }),
    );

    expect(submission.kind).toBe("accepted");
    if (submission.kind !== "accepted") return;
    expect(submission.status).toBe("running");
    expect(submission.lease?.token).toBeTruthy();

    const params = runner.spawns[0];
    expect(params).toMatchObject({
      runId: "run-1",
      commandName: "test",
      command: "scripts/validate/test.sh",
      cost: 8,
      projectPath: "/projects/app",
      worktreePath: "/projects/app/.worktrees/s1",
      sessionName: "s1",
      branchName: "csm/s1",
      targetBranch: "main",
      requestedScope: "changed",
      effectiveScope: "changed",
      pathArgs: "paths",
      scopePaths: ["src/a.test.ts"],
      timeoutMs: 900_000,
    });
    expect(params?.contextId).toBeUndefined();

    vi.advanceTimersByTime(2_500);
    runner.runs.get("run-1")?.complete({
      kind: "exited",
      exitCode: 0,
      output: "42 tests passed",
    });
    await flush();

    const polled = service.poll("run-1", submission.lease?.token);
    expect(polled.status).toBe("passed");
    // This harness names a worktree that holds no files, so the forwarded path
    // resolves to nothing.
    expect(polled.result).toEqual({
      kind: "passed",
      runId: "run-1",
      exitCode: 0,
      output: "42 tests passed",
      filesMatched: 0,
    });

    const row = repo.findById("run-1");
    expect(row?.sessionName).toBe("s1");
    expect(row?.conversationId).toBe("c1");
    expect(row?.queueMs).toBe(0);
    expect(row?.execMs).toBe(2_500);
    expect(row?.requestedScope).toBe("changed");
    expect(row?.effectiveScope).toBe("changed");
    expect(row?.scopedPathCount).toBe(1);
    expect(row?.exitCode).toBe(0);
    expect(phases()).toEqual(["requested", "started", "completed"]);
  });

  it("dispatches changed fallback and explicit full from the same logical profile", async () => {
    const fallback = await service.submit(
      request({ commandName: "typecheck" }),
    );
    expect(fallback).toMatchObject({
      kind: "accepted",
      requestedScope: "changed",
      effectiveScope: "full",
    });
    expect(runner.spawns[0]).toMatchObject({
      commandName: "typecheck",
      command: "scripts/validate/typecheck.sh",
      requestedScope: "changed",
      effectiveScope: "full",
    });

    runner.runs
      .get("run-1")
      ?.complete({ kind: "exited", exitCode: 0, output: "clean" });
    await flush();

    const full = await service.submit(
      request({ commandName: "test", scope: "full" }),
    );
    expect(full).toMatchObject({
      kind: "accepted",
      requestedScope: "full",
      effectiveScope: "full",
    });
    expect(runner.spawns[1]).toMatchObject({
      commandName: "test",
      command: "scripts/validate/test-full-suite.sh",
      requestedScope: "full",
      effectiveScope: "full",
      scopePaths: [],
    });
  });

  it("queues behind running work and pumps the waiter after release", async () => {
    await service.submit(request({ commandName: "test", wait: false }));
    const queued = await service.submit(
      request({ commandName: "typecheck", wait: true }),
    );

    expect(queued.kind).toBe("accepted");
    if (queued.kind !== "accepted") return;
    expect(queued.status).toBe("queued");
    expect(queued.position).toBe(0);
    expect(runner.spawns).toHaveLength(1);

    runner.runs.get("run-1")?.complete({
      kind: "exited",
      exitCode: 1,
      output: "1 test failed",
    });
    await flush();

    // The failed release pumped the queue and spawned the waiter.
    expect(runner.spawns).toHaveLength(2);
    expect(runner.spawns[1]?.commandName).toBe("typecheck");
    expect(service.poll("run-1").result?.kind).toBe("failed");
    expect(repo.findById(queued.runId)?.status).toBe("running");
  });

  it("keeps a queued run's resolved executable after live config edits", async () => {
    let currentConfig = REPO_VALIDATION;
    service = buildService({
      readRepoValidation: async () => currentConfig,
    });
    await service.submit(request({ commandName: "test" }));
    const queued = await service.submit(
      request({ commandName: "typecheck", wait: true }),
    );
    expect(queued).toMatchObject({
      kind: "accepted",
      status: "queued",
      requestedScope: "changed",
      effectiveScope: "full",
    });

    currentConfig = repoValidationConfigSchema.parse({
      ...REPO_VALIDATION,
      commands: {
        ...REPO_VALIDATION.commands,
        typecheck: {
          ...REPO_VALIDATION.commands.typecheck,
          command: {
            full: "scripts/validate/typecheck-replacement-full.sh",
            changed: "scripts/validate/typecheck-replacement-changed.sh",
          },
        },
      },
    });
    runner.runs
      .get("run-1")
      ?.complete({ kind: "exited", exitCode: 0, output: "clean" });
    await flush();

    expect(runner.spawns[1]).toMatchObject({
      command: "scripts/validate/typecheck.sh",
      requestedScope: "changed",
      effectiveScope: "full",
    });
  });

  it("rejects unknown commands and over-limit costs without touching the runner", async () => {
    const unknown = await service.submit(request({ commandName: "nope" }));
    expect(unknown.kind).toBe("not_started");
    if (unknown.kind !== "not_started") return;
    expect(unknown.result).toEqual({
      kind: "command_not_found",
      name: "nope",
      knownCommands: ["test", "typecheck", "format"],
    });

    // The cost-8 "test" command fits the default limit of 8, so the reject
    // path needs a service whose global config reports a lower limit.
    const overService = createValidationService({
      repo,
      transact: (_l, fn) => fixture.db.transaction(fn)(),
      scheduler: createValidationScheduler({
        repo,
        transact: (_l, fn) => fixture.db.transaction(fn)(),
      }),
      runner: { spawn: (params) => runner.spawn(params) },
      resolver: { resolveCaller: async () => resolved },
      config: {
        readRepoValidation: async () => REPO_VALIDATION,
        readGlobal: async () => ({
          concurrencyLimit: 4,
          defaultTimeoutMs: 600_000,
        }),
      },
      identity: benignIdentity,
      publish: (event) => {
        events.push(event);
        return { delivered: true };
      },
    });
    const over = await overService.submit(
      request({ commandName: "test", wait: true }),
    );
    expect(over.kind).toBe("not_started");
    if (over.kind !== "not_started") return;
    expect(over.result).toEqual({
      kind: "cost_exceeds_limit",
      name: "test",
      cost: 8,
      limit: 4,
    });
    expect(runner.spawns).toHaveLength(0);
    expect(phases()).toContain("rejected");
  });

  it("rejects nested invocations and unresolved identity, failing closed", async () => {
    const nested = await service.submit(
      request({ nestedValidationRunId: "vrun-parent" }),
    );
    expect(nested).toMatchObject({
      kind: "invalid",
      reason: "nested_invocation",
    });

    resolved = { kind: "ambiguous", reason: "stale lane conversation" };
    const ambiguous = await service.submit(request());
    expect(ambiguous).toMatchObject({
      kind: "invalid",
      reason: "identity_unresolved",
    });
    expect(runner.spawns).toHaveLength(0);
    expect(repo.findStaleActive()).toHaveLength(0);
    expect(repo.nextQueueOrder()).toBe(0);
  });

  it("refuses forwarded paths before admission when the command forbids them", async () => {
    const submission = await service.submit(
      request({ commandName: "format", scopePaths: ["src/a.ts"] }),
    );
    expect(submission).toMatchObject({
      kind: "invalid",
      reason: "path_args_forbidden",
    });
    expect(repo.findStaleActive()).toHaveLength(0);
    expect(runner.spawns).toHaveLength(0);
  });

  it.each([
    {
      name: "full scope",
      request: request({
        commandName: "test",
        scope: "full",
        scopePaths: ["src/a.test.ts"],
      }),
      reason: "path_args_require_changed",
    },
    {
      name: "full fallback",
      request: request({
        commandName: "typecheck",
        scopePaths: ["src/a.ts"],
      }),
      reason: "path_args_require_changed",
    },
    {
      name: "unsafe path",
      request: request({
        commandName: "test",
        scopePaths: ["../outside.test.ts"],
      }),
      reason: "path_args_rejected",
    },
  ])("rejects $name paths before admission", async ({ request, reason }) => {
    await expect(service.submit(request)).resolves.toMatchObject({
      kind: "invalid",
      reason,
    });
    expect(repo.findStaleActive()).toHaveLength(0);
    expect(runner.spawns).toHaveLength(0);
  });
});

describe("matched-file disclosure for scoped runs", () => {
  let worktreePath: string;

  beforeEach(() => {
    worktreePath = mkdtempSync(path.join(tmpdir(), "cc-validation-scope-"));
    mkdirSync(path.join(worktreePath, "src"), { recursive: true });
    writeFileSync(path.join(worktreePath, "src", "a.test.ts"), "");
    resolved = { ...SESSION_CALLER, worktreePath };
  });

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true });
  });

  async function completeScopedRun(
    scopePaths: string[],
    outcome: ValidationRunOutcome,
  ): Promise<ReturnType<ValidationService["poll"]>> {
    const submission = await service.submit(
      request({ commandName: "test", scopePaths }),
    );
    expect(submission).toMatchObject({ kind: "accepted" });
    if (submission.kind !== "accepted") throw new Error("submission refused");
    runner.runs.get(submission.runId)?.complete(outcome);
    await flush();
    return service.poll(submission.runId);
  }

  it("reports how many named paths the run could reach", async () => {
    const polled = await completeScopedRun(["src/a.test.ts"], {
      kind: "exited",
      exitCode: 0,
      output: "1 test passed",
    });

    expect(polled.result).toEqual({
      kind: "passed",
      runId: "run-1",
      exitCode: 0,
      output: "1 test passed",
      filesMatched: 1,
    });
  });

  it("reports zero matched files for a mistyped path that still exits green", async () => {
    const polled = await completeScopedRun(["src/a.tset.ts"], {
      kind: "exited",
      exitCode: 0,
      output: "",
    });

    expect(polled.status).toBe("passed");
    expect(polled.result).toMatchObject({ kind: "passed", filesMatched: 0 });
  });

  it("counts only the reachable paths of a partially mistyped selection", async () => {
    const polled = await completeScopedRun(["src/a.test.ts", "src/b.test.ts"], {
      kind: "exited",
      exitCode: 1,
      output: "1 test failed",
    });

    expect(polled.result).toMatchObject({ kind: "failed", filesMatched: 1 });
  });

  it("omits the count when the run named no paths of its own", async () => {
    const submission = await service.submit(request({ commandName: "test" }));
    expect(submission).toMatchObject({ kind: "accepted" });
    if (submission.kind !== "accepted") return;
    runner.runs
      .get(submission.runId)
      ?.complete({ kind: "exited", exitCode: 0, output: "clean" });
    await flush();

    expect(service.poll(submission.runId).result).toEqual({
      kind: "passed",
      runId: submission.runId,
      exitCode: 0,
      output: "clean",
    });
  });
});

describe("cost table resolution at submission", () => {
  const TABLE_VALIDATION = repoValidationConfigSchema.parse({
    commands: {
      test: {
        command: {
          full: "scripts/validate/test-full-suite.sh",
          changed: "scripts/validate/test.sh",
        },
        cost: { full: 8, changed: 5, paths: { base: 2, perPath: 1 } },
        timeoutMs: 900_000,
        pathArgs: "paths",
      },
    },
    preMerge: ["test"],
  });

  beforeEach(() => {
    service = buildService({
      readRepoValidation: async () => TABLE_VALIDATION,
    });
  });

  it("snapshots the scoped weight for an agent submission with forwarded paths", async () => {
    const submission = await service.submit(
      request({ commandName: "test", scopePaths: ["src/a.test.ts"] }),
    );

    expect(submission).toMatchObject({ kind: "accepted", status: "running" });
    if (submission.kind !== "accepted") return;
    expect(runner.spawns[0]).toMatchObject({
      commandName: "test",
      command: "scripts/validate/test.sh",
      cost: 3,
      scopePaths: ["src/a.test.ts"],
    });
    const row = repo.findById(submission.runId);
    expect(row?.cost).toBe(3);
    expect(row?.scopedPathCount).toBe(1);
  });

  it("caps the scoped weight at the changed weight as path count grows", async () => {
    const submission = await service.submit(
      request({
        commandName: "test",
        scopePaths: [
          "src/a.test.ts",
          "src/b.test.ts",
          "src/c.test.ts",
          "src/d.test.ts",
          "src/e.test.ts",
        ],
      }),
    );

    expect(submission.kind).toBe("accepted");
    if (submission.kind !== "accepted") return;
    expect(repo.findById(submission.runId)?.cost).toBe(5);
  });

  it("snapshots the full weight for a pathless full submission", async () => {
    const submission = await service.submit(
      request({ commandName: "test", scope: "full" }),
    );

    expect(submission).toMatchObject({ kind: "accepted", status: "running" });
    if (submission.kind !== "accepted") return;
    expect(runner.spawns[0]).toMatchObject({
      command: "scripts/validate/test-full-suite.sh",
      cost: 8,
    });
    expect(repo.findById(submission.runId)?.cost).toBe(8);
  });

  it("snapshots the changed weight for a pathless system submission", async () => {
    const changed = await service.submitSystem(
      systemRequest({
        command: { kind: "registered", name: "test" },
        scope: "changed",
      }),
    );

    expect(changed).toMatchObject({ kind: "accepted", status: "running" });
    if (changed.kind !== "accepted") return;
    expect(runner.spawns[0]).toMatchObject({
      command: "scripts/validate/test.sh",
      cost: 5,
    });
    expect(repo.findById(changed.runId)?.cost).toBe(5);

    const full = await service.submitSystem(
      systemRequest({
        command: { kind: "registered", name: "test" },
        scope: "full",
      }),
    );
    expect(full).toMatchObject({ kind: "accepted", status: "queued" });
    if (full.kind !== "accepted") return;
    expect(repo.findById(full.runId)?.cost).toBe(8);
  });
});

describe("durable timing by validation source", () => {
  it("records the exact timing and scope tuple for every execution source", async () => {
    let clockMs = Date.parse("2026-08-05T10:00:00.000Z");
    service = buildService({ now: () => new Date(clockMs) });

    const runIds: string[] = [];
    const submission = await service.submit(
      request({
        source: "agent_cli",
        commandName: "test",
        scopePaths: ["src/a.test.ts", "src/b.test.ts"],
      }),
    );
    expect(submission.kind).toBe("accepted");
    if (submission.kind !== "accepted") return;
    runIds.push(submission.runId);
    clockMs += 125;
    const completion = service.waitForCompletion(submission.runId);
    runner.runs
      .get(submission.runId)
      ?.complete({ kind: "exited", exitCode: 0, output: "clean" });
    await expect(completion).resolves.toMatchObject({ kind: "passed" });

    for (const [source, execMs] of [
      ["graph_script_validator", 250],
      ["graph_lane_merge", 375],
      ["smart_merge", 500],
      ["smart_commit", 625],
    ] as const) {
      const systemSubmission = await service.submitSystem({
        source,
        command: { kind: "registered", name: "typecheck" },
        scope: "changed",
        projectPath: "/projects/app",
        conversationId: `conversation-${source}`,
        target: {
          worktreePath: "/projects/app/.worktrees/s1",
          sessionName: "s1",
          branchName: "csm/s1",
          targetBranch: "main",
        },
      });
      expect(systemSubmission.kind).toBe("accepted");
      if (systemSubmission.kind !== "accepted") return;
      runIds.push(systemSubmission.runId);
      clockMs += execMs;
      const systemCompletion = service.waitForCompletion(
        systemSubmission.runId,
      );
      runner.runs
        .get(systemSubmission.runId)
        ?.complete({ kind: "exited", exitCode: 0, output: "clean" });
      await expect(systemCompletion).resolves.toMatchObject({ kind: "passed" });
    }

    const reloaded = createValidationRunsRepo(fixture.db);
    const timingRows = runIds.map((runId) => {
      const row = reloaded.findById(runId);
      return {
        source: row?.source,
        sessionName: row?.sessionName,
        conversationId: row?.conversationId,
        status: row?.status,
        queueMs: row?.queueMs,
        execMs: row?.execMs,
        requestedScope: row?.requestedScope,
        effectiveScope: row?.effectiveScope,
        scopedPathCount: row?.scopedPathCount,
      };
    });

    expect(timingRows).toEqual([
      {
        source: "agent_cli",
        sessionName: "s1",
        conversationId: "c1",
        status: "passed",
        queueMs: 0,
        execMs: 125,
        requestedScope: "changed",
        effectiveScope: "changed",
        scopedPathCount: 2,
      },
      {
        source: "graph_script_validator",
        sessionName: "s1",
        conversationId: "conversation-graph_script_validator",
        status: "passed",
        queueMs: 0,
        execMs: 250,
        requestedScope: "changed",
        effectiveScope: "full",
        scopedPathCount: 0,
      },
      {
        source: "graph_lane_merge",
        sessionName: "s1",
        conversationId: "conversation-graph_lane_merge",
        status: "passed",
        queueMs: 0,
        execMs: 375,
        requestedScope: "changed",
        effectiveScope: "full",
        scopedPathCount: 0,
      },
      {
        source: "smart_merge",
        sessionName: "s1",
        conversationId: "conversation-smart_merge",
        status: "passed",
        queueMs: 0,
        execMs: 500,
        requestedScope: "changed",
        effectiveScope: "full",
        scopedPathCount: 0,
      },
      {
        source: "smart_commit",
        sessionName: "s1",
        conversationId: "conversation-smart_commit",
        status: "passed",
        queueMs: 0,
        execMs: 625,
        requestedScope: "changed",
        effectiveScope: "full",
        scopedPathCount: 0,
      },
    ]);
  });

  it("logs the terminal timing tuple when a lower limit retires a queued run", async () => {
    let clockMs = Date.parse("2026-08-05T10:00:00.000Z");
    let concurrencyLimit = 8;
    const captured = createCapturingLogger();
    service = buildService({
      now: () => new Date(clockMs),
      readGlobal: async () => ({
        concurrencyLimit,
        defaultTimeoutMs: 600_000,
      }),
      logger: captured,
    });

    const running = await service.submit(request({ commandName: "test" }));
    expect(running.kind).toBe("accepted");
    if (running.kind !== "accepted") return;
    const queued = await service.submit(
      request({ commandName: "test", wait: true }),
    );
    expect(queued).toMatchObject({ kind: "accepted", status: "queued" });
    if (queued.kind !== "accepted") return;

    concurrencyLimit = 4;
    clockMs += 250;
    const queuedCompletion = service.waitForCompletion(queued.runId);
    runner.runs
      .get(running.runId)
      ?.complete({ kind: "exited", exitCode: 0, output: "clean" });
    await expect(queuedCompletion).resolves.toEqual({
      kind: "cost_exceeds_limit",
      name: "test",
      cost: 8,
      limit: 4,
    });

    const terminal = createValidationRunsRepo(fixture.db).findById(
      queued.runId,
    );
    expect(terminal).toMatchObject({
      status: "cost_exceeds_limit",
      sessionName: "s1",
      conversationId: "c1",
      queueMs: null,
      execMs: null,
      requestedScope: "changed",
      effectiveScope: "changed",
      scopedPathCount: 0,
    });
    expect(
      captured.entries.find(
        (entry) =>
          entry.message === "validation.run_completed" &&
          entry.fields.runId === queued.runId,
      ),
    ).toEqual({
      level: "info",
      message: "validation.run_completed",
      fields: {
        runId: queued.runId,
        name: "test",
        cost: 8,
        source: "agent_cli",
        project: "/projects/app",
        sessionName: "s1",
        conversation: "c1",
        outcome: "cost_exceeds_limit",
        exitCode: null,
        queueMs: null,
        execMs: null,
        timedOut: false,
        requestedScope: "changed",
        effectiveScope: "changed",
        scopedPathCount: 0,
        limit: 4,
      },
    });
  });
});

describe("system submissions with explicit targets", () => {
  it("rejects an oversized system command even though system submissions always wait", async () => {
    service = buildService({ concurrencyLimit: 4 });

    const submission = await service.submitSystem({
      source: "graph_script_validator",
      command: { kind: "registered", name: "test" },
      scope: "changed",
      projectPath: "/projects/app",
      conversationId: "conv-oversized",
      target: {
        worktreePath: "/projects/app/.worktrees/s1",
        sessionName: "s1",
        branchName: "csm/s1",
        targetBranch: "main",
      },
    });

    expect(submission).toEqual({
      kind: "not_started",
      result: {
        kind: "cost_exceeds_limit",
        name: "test",
        cost: 8,
        limit: 4,
      },
    });
    expect(runner.spawns).toHaveLength(0);
    expect(repo.findStaleActive()).toHaveLength(0);
  });

  it("queues graph lane merges as lease-exempt work and durably records timing", async () => {
    const occupying = await service.submit(
      request({ commandName: "test", wait: false }),
    );
    expect(occupying.kind).toBe("accepted");

    vi.advanceTimersByTime(1_000);
    const submission = await service.submitSystem({
      source: "graph_lane_merge",
      command: { kind: "registered", name: "typecheck" },
      scope: "changed",
      projectPath: "/projects/app",
      conversationId: "conv-lane",
      workflow: { executionId: "exec-1", contextId: "api" },
      target: {
        worktreePath: "/projects/app/.worktrees/s1.api",
        sessionName: "s1",
        branchName: "csm/s1-api",
        targetBranch: "csm/s1",
        contextId: "api",
      },
    });

    expect(submission.kind).toBe("accepted");
    if (submission.kind !== "accepted") return;
    expect(submission.status).toBe("queued");
    expect(submission.lease).toBeNull();

    vi.advanceTimersByTime(2_000);
    runner.runs.get("run-1")?.complete({
      kind: "exited",
      exitCode: 0,
      output: "occupying run complete",
    });
    await flush();
    expect(runner.spawns.at(-1)).toMatchObject({
      runId: submission.runId,
      commandName: "typecheck",
      worktreePath: "/projects/app/.worktrees/s1.api",
    });

    vi.advanceTimersByTime(1_500);
    const resultP = service.waitForCompletion(submission.runId);
    runner.runs.get(submission.runId)?.complete({
      kind: "exited",
      exitCode: 0,
      output: "lane merge clean",
    });
    await expect(resultP).resolves.toMatchObject({ kind: "passed" });

    const reloaded = createValidationRunsRepo(fixture.db).findById(
      submission.runId,
    );
    expect(reloaded).toMatchObject({
      source: "graph_lane_merge",
      status: "passed",
      leaseToken: null,
      queueMs: 2_000,
      execMs: 1_500,
      workflowExecutionId: "exec-1",
      workflowContextId: "api",
    });
  });

  it("runs a registered command against the supplied lane target, lease-exempt", async () => {
    const submission = await service.submitSystem({
      source: "graph_script_validator",
      command: { kind: "registered", name: "typecheck" },
      scope: "changed",
      projectPath: "/projects/app",
      conversationId: "conv-lane",
      workflow: { executionId: "exec-1", contextId: "api" },
      target: {
        worktreePath: "/projects/app/.worktrees/s1.api",
        sessionName: "s1",
        branchName: "csm/s1-api",
        targetBranch: "csm/s1",
        contextId: "api",
      },
    });

    expect(submission.kind).toBe("accepted");
    if (submission.kind !== "accepted") return;
    expect(submission.status).toBe("running");
    expect(submission.lease).toBeNull();
    expect(submission.requestedScope).toBe("changed");
    expect(submission.effectiveScope).toBe("full");

    // The spawn targets exactly the caller-resolved lane worktree — no
    // resolver involvement, no session fallback.
    expect(runner.spawns[0]).toMatchObject({
      commandName: "typecheck",
      command: "scripts/validate/typecheck.sh",
      cost: 2,
      projectPath: "/projects/app",
      worktreePath: "/projects/app/.worktrees/s1.api",
      sessionName: "s1",
      branchName: "csm/s1-api",
      targetBranch: "csm/s1",
      contextId: "api",
      requestedScope: "changed",
      effectiveScope: "full",
    });
    const row = repo.findById(submission.runId);
    expect(row?.source).toBe("graph_script_validator");
    expect(row?.leaseToken).toBeNull();
    expect(row?.workflowExecutionId).toBe("exec-1");
    expect(row?.workflowContextId).toBe("api");
    expect(row?.conversationId).toBe("conv-lane");

    const resultP = service.waitForCompletion(submission.runId);
    runner.runs
      .get(submission.runId)
      ?.complete({ kind: "exited", exitCode: 0, output: "clean" });
    await expect(resultP).resolves.toEqual({
      kind: "passed",
      runId: submission.runId,
      exitCode: 0,
      output: "clean",
    });
  });

  it("always queues behind running work and resolves waitForCompletion only after admission and group death", async () => {
    await service.submit(request({ commandName: "test" }));
    const queued = await service.submitSystem({
      source: "graph_script_validator",
      command: { kind: "registered", name: "typecheck" },
      scope: "changed",
      projectPath: "/projects/app",
      target: {
        worktreePath: "/projects/app/.worktrees/s1",
        sessionName: "s1",
        branchName: "csm/s1",
        targetBranch: "main",
      },
    });

    expect(queued.kind).toBe("accepted");
    if (queued.kind !== "accepted") return;
    expect(queued.status).toBe("queued");

    let settled = false;
    const resultP = service.waitForCompletion(queued.runId).then((result) => {
      settled = true;
      return result;
    });
    await flush();
    expect(settled).toBe(false);
    expect(runner.spawns).toHaveLength(1);

    runner.runs.get("run-1")?.complete({
      kind: "exited",
      exitCode: 0,
      output: "ok",
    });
    await flush();
    expect(runner.spawns).toHaveLength(2);

    runner.runs.get(queued.runId)?.complete({
      kind: "exited",
      exitCode: 1,
      output: "type error",
    });
    await expect(resultP).resolves.toMatchObject({
      kind: "failed",
      exitCode: 1,
      output: "type error",
    });
  });

  it("returns command_not_found for an unregistered name without touching the runner", async () => {
    const submission = await service.submitSystem({
      source: "graph_script_validator",
      command: { kind: "registered", name: "nope" },
      scope: "changed",
      projectPath: "/projects/app",
      target: {
        worktreePath: "/projects/app/.worktrees/s1",
        sessionName: "s1",
        branchName: "csm/s1",
        targetBranch: "main",
      },
    });

    expect(submission.kind).toBe("not_started");
    if (submission.kind !== "not_started") return;
    expect(submission.result).toEqual({
      kind: "command_not_found",
      name: "nope",
      knownCommands: ["test", "typecheck", "format"],
    });
    expect(runner.spawns).toHaveLength(0);
    expect(repo.findStaleActive()).toHaveLength(0);
  });

  it("resolves waitForCompletion for a system-owned cancel with the cancelled verdict", async () => {
    const submission = await service.submitSystem({
      source: "smart_commit",
      command: { kind: "registered", name: "typecheck" },
      scope: "changed",
      projectPath: "/projects/app",
      target: {
        worktreePath: "/projects/app/.worktrees/s1",
        sessionName: "s1",
        branchName: "csm/s1",
        targetBranch: "main",
      },
    });
    if (submission.kind !== "accepted") return;

    const resultP = service.waitForCompletion(submission.runId);
    expect(await service.cancelSystemOwned(submission.runId)).toBe(true);
    await expect(resultP).resolves.toEqual({
      kind: "cancelled",
      runId: submission.runId,
    });
  });
});

describe("cancellation and leases", () => {
  it("cancels a running run only for the exact token holder", async () => {
    const submission = await service.submit(request({ commandName: "test" }));
    if (submission.kind !== "accepted") return;

    const stranger = await service.cancel(submission.runId, "wrong-token");
    expect(stranger.authorization).toBe("not_owner");
    expect(repo.findById(submission.runId)?.status).toBe("running");

    const owner = await service.cancel(
      submission.runId,
      submission.lease?.token ?? "",
    );
    await flush();
    expect(owner.authorization).toBe("authorized");
    expect(repo.findById(submission.runId)?.status).toBe("cancelled");
    expect(service.poll(submission.runId).result?.kind).toBe("cancelled");
    expect(phases()).toEqual(["requested", "started", "cancelled"]);
  });

  it("reaps an expired running lease as interrupted via the sweep", async () => {
    const submission = await service.submit(request({ commandName: "test" }));
    if (submission.kind !== "accepted") return;

    vi.advanceTimersByTime(61_000);
    const reaped = await service.sweepExpiredLeases();
    await flush();

    expect(reaped).toBe(1);
    expect(repo.findById(submission.runId)?.status).toBe("interrupted");
    expect(service.poll(submission.runId).result?.kind).toBe("interrupted");
    expect(phases()).toEqual(["requested", "started", "interrupted"]);
  });

  it("exempts system-owned runs from leases but allows orchestrator cancel", async () => {
    const submission = await service.submit(
      request({ source: "smart_merge", commandName: "test" }),
    );
    if (submission.kind !== "accepted") return;
    expect(submission.lease).toBeNull();

    vi.advanceTimersByTime(120_000);
    expect(await service.sweepExpiredLeases()).toBe(0);
    expect(repo.findById(submission.runId)?.status).toBe("running");

    expect(await service.cancelSystemOwned(submission.runId)).toBe(true);
    await flush();
    expect(repo.findById(submission.runId)?.status).toBe("cancelled");
  });
});

describe("recovery on construction (persistence fixture)", () => {
  function staleRunning(runId: string): ValidationRunRecord {
    return {
      runId,
      source: "agent_cli",
      commandName: "test",
      cost: 8,
      queueOrder: repo.nextQueueOrder(),
      status: "queued",
      nonce: `nonce-${runId}`,
      leaseToken: "tok",
      leaseExpiresAt: "2026-08-05T09:59:00.000Z",
      processGroupPid: null,
      projectPath: "/projects/app",
      worktreePath: "/projects/app/.worktrees/s1",
      sessionName: "s1",
      conversationId: "conv-recovery",
      workflowExecutionId: null,
      workflowContextId: null,
      workflowRole: null,
      submittedAt: "2026-08-05T09:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      queueMs: null,
      execMs: null,
      requestedScope: "changed",
      effectiveScope: "full",
      scopedPathCount: 0,
      exitCode: null,
      timedOut: false,
    };
  }

  it("keeps admission closed until reconciliation terminates owned groups and marks rows interrupted", async () => {
    // A prior process died uncleanly, leaving a running row with a live pid.
    repo.submit(staleRunning("stale-1"));
    repo.admit("stale-1");
    repo.markStarted("stale-1", {
      startedAt: "2026-08-05T09:00:01.000Z",
      queueMs: 1_000,
      processGroupPid: 4242,
    });

    let releaseIdentity!: () => void;
    const identityGate = new Promise<void>((resolve) => {
      releaseIdentity = resolve;
    });
    let releaseKill!: () => void;
    const killGate = new Promise<void>((resolve) => {
      releaseKill = resolve;
    });
    const captured = createCapturingLogger();
    const recovering = buildService({
      now: () => new Date("2026-08-05T09:00:03.000Z"),
      logger: captured,
      identity: {
        classifyGroup: async (pgid) => {
          await identityGate;
          return pgid === 4242 ? "owned" : "not_ours";
        },
        killGroup: async (pgid) => {
          identityKills.push(pgid);
          await killGate;
        },
      },
    });

    // Submit while reconciliation is still probing: admission must wait.
    let decided = false;
    const pending = recovering
      .submit(request({ commandName: "typecheck" }))
      .then((outcome) => {
        decided = true;
        return outcome;
      });
    await flush();
    expect(decided).toBe(false);
    expect(runner.spawns).toHaveLength(0);
    expect(repo.findById("stale-1")?.status).toBe("running");

    releaseIdentity();
    await flush();
    expect(repo.findById("stale-1")?.status).toBe("running");
    expect(
      captured.entries.filter(
        (entry) =>
          entry.message === "validation.run_completed" &&
          entry.fields.runId === "stale-1",
      ),
    ).toHaveLength(0);

    releaseKill();
    const submission = await pending;
    expect(decided).toBe(true);
    expect(submission.kind).toBe("accepted");
    expect(identityKills).toEqual([4242]);

    // Durable verdicts, reloaded through a fresh repository over the same DB.
    const reloaded = createValidationRunsRepo(fixture.db);
    const staleRow = reloaded.findById("stale-1");
    expect(staleRow?.status).toBe("interrupted");
    expect(staleRow?.sessionName).toBe("s1");
    expect(staleRow?.conversationId).toBe("conv-recovery");
    expect(staleRow?.execMs).toBe(2_000);
    expect(reloaded.findById("run-1")?.status).toBe("running");
    expect(phases()).toContain("interrupted");
    expect(
      captured.entries.find(
        (entry) =>
          entry.message === "validation.run_completed" &&
          entry.fields.runId === "stale-1",
      ),
    ).toEqual({
      level: "info",
      message: "validation.run_completed",
      fields: {
        runId: "stale-1",
        name: "test",
        cost: 8,
        source: "agent_cli",
        project: "/projects/app",
        sessionName: "s1",
        conversation: "conv-recovery",
        outcome: "interrupted",
        exitCode: null,
        queueMs: 1_000,
        execMs: 2_000,
        timedOut: false,
        requestedScope: "changed",
        effectiveScope: "full",
        scopedPathCount: 0,
        limit: 8,
      },
    });
  });

  it("observes settled rows before a later unverifiable group fails recovery", async () => {
    repo.submit(staleRunning("stale-owned"));
    repo.admit("stale-owned");
    repo.markStarted("stale-owned", {
      startedAt: "2026-08-05T09:00:01.000Z",
      queueMs: 1_000,
      processGroupPid: 111,
    });
    repo.submit(staleRunning("stale-orphan"));
    repo.admit("stale-orphan");
    repo.markStarted("stale-orphan", {
      startedAt: "2026-08-05T09:00:01.000Z",
      queueMs: 1_000,
      processGroupPid: 555,
    });

    const captured = createCapturingLogger();
    const failedRecovery = buildService({
      now: () => new Date("2026-08-05T09:00:03.000Z"),
      logger: captured,
      identity: {
        classifyGroup: async (pgid) =>
          pgid === 111 ? "owned" : "unverifiable",
        killGroup: async (pgid) => {
          identityKills.push(pgid);
        },
      },
    });

    const submission = await failedRecovery.submit(
      request({ commandName: "typecheck" }),
    );
    expect(failedRecovery.isAvailable()).toBe(false);
    expect(submission).toMatchObject({
      kind: "invalid",
      reason: "service_unavailable",
    });
    expect(runner.spawns).toHaveLength(0);
    expect(identityKills).toEqual([111]);
    expect(repo.findById("stale-owned")?.status).toBe("interrupted");
    expect(repo.findById("stale-orphan")?.status).toBe("running");
    expect(
      captured.entries
        .filter((entry) => entry.message === "validation.run_completed")
        .map((entry) => entry.fields.runId),
    ).toEqual(["stale-owned"]);
  });

  it("never terminalizes retained failed-recovery rows via the lease sweep or shutdown", async () => {
    // A retained row whose lease expired long ago: without the ownership
    // guard the sweep would kill nothing (no local handle) yet mark it
    // interrupted, and the next restart would reopen admission over the
    // still-unverified live group.
    repo.submit(staleRunning("stale-orphan"));
    repo.admit("stale-orphan");
    repo.markStarted("stale-orphan", {
      startedAt: "2026-08-05T09:00:01.000Z",
      queueMs: 1_000,
      processGroupPid: 555,
    });

    const failedRecovery = buildService({
      identity: {
        classifyGroup: async () => "unverifiable",
        killGroup: async (pgid) => {
          identityKills.push(pgid);
        },
      },
    });
    await failedRecovery.whenReady();
    expect(failedRecovery.isAvailable()).toBe(false);

    vi.advanceTimersByTime(600_000);
    await failedRecovery.sweepExpiredLeases();
    expect(repo.findById("stale-orphan")?.status).toBe("running");

    await failedRecovery.shutdown();
    expect(repo.findById("stale-orphan")?.status).toBe("running");
    expect(identityKills).toEqual([]);
  });
});

describe("start barrier ordering", () => {
  it("persists the process-group pid to the ledger before releasing the workload", async () => {
    let pidAtConfirm: number | null | undefined;
    runner.onConfirmStart = (runId) => {
      pidAtConfirm = repo.findById(runId)?.processGroupPid;
    };

    const submission = await service.submit(
      request({ commandName: "typecheck" }),
    );
    expect(submission.kind).toBe("accepted");
    if (submission.kind !== "accepted") return;

    // The barrier was released exactly once, and only after the pid was
    // durable — a crash before that point leaves the workload unstarted.
    const run = runner.runs.get(submission.runId);
    expect(run?.startConfirmed).toBe(true);
    expect(pidAtConfirm).toBe(1000);
    expect(repo.findById(submission.runId)?.processGroupPid).toBe(1000);

    run?.complete({ kind: "exited", exitCode: 0, output: "ok" });
    await flush();
    expect(repo.findById(submission.runId)?.status).toBe("passed");
  });
});

describe("cancellation racing an in-flight spawn", () => {
  it("kills the spawned group before releasing capacity on cancel", async () => {
    const releaseSpawn = runner.holdSpawns();
    const submitP = service.submit(
      request({ source: "smart_merge", commandName: "typecheck" }),
    );
    await flush();
    // Admitted: capacity reserved, spawn still in flight.
    expect(repo.findById("run-1")?.status).toBe("running");
    expect(runner.spawns).toHaveLength(0);

    const cancelP = service.cancelSystemOwned("run-1");
    await flush();
    // Cancellation must not settle the run while its spawn is in flight —
    // that would release capacity a live process is about to consume.
    expect(repo.findById("run-1")?.status).toBe("running");
    expect(service.poll("run-1").result).toBeNull();

    releaseSpawn();
    expect(await cancelP).toBe(true);
    await submitP;
    await flush();

    expect(runner.runs.get("run-1")?.cancelRequested).toBe(true);
    expect(repo.findById("run-1")?.status).toBe("cancelled");
    expect(service.poll("run-1").result?.kind).toBe("cancelled");
  });

  it("interrupts an in-flight spawn on shutdown only after its group dies", async () => {
    const releaseSpawn = runner.holdSpawns();
    const submitP = service.submit(request({ commandName: "typecheck" }));
    await flush();
    expect(repo.findById("run-1")?.status).toBe("running");

    const shutdownP = service.shutdown();
    await flush();
    expect(repo.findById("run-1")?.status).toBe("running");

    releaseSpawn();
    await shutdownP;
    await submitP;
    await flush();

    expect(runner.runs.get("run-1")?.cancelRequested).toBe(true);
    expect(repo.findById("run-1")?.status).toBe("interrupted");
    expect(repo.findStaleActive()).toHaveLength(0);
  });
});

describe("graceful shutdown", () => {
  it("rejects agent and system submissions started after shutdown begins", async () => {
    const releaseSpawn = runner.holdSpawns();
    const existingSubmission = service.submit(request({ commandName: "test" }));
    await flush();
    expect(repo.findById("run-1")?.status).toBe("running");

    const shutdown = service.shutdown();
    await flush();
    const [agentSubmission, systemSubmission] = await Promise.all([
      service.submit(request({ commandName: "format", wait: true })),
      service.submitSystem(
        systemRequest({
          command: { kind: "registered", name: "format" },
        }),
      ),
    ]);

    releaseSpawn();
    await Promise.all([existingSubmission, shutdown]);
    await flush();

    expect(agentSubmission).toMatchObject({
      kind: "invalid",
      reason: "service_unavailable",
    });
    expect(systemSubmission).toMatchObject({
      kind: "invalid",
      reason: "service_unavailable",
    });
    expect(repo.findById("run-2")).toBeNull();
    expect(repo.findById("run-3")).toBeNull();
    expect(runner.spawns.map((spawn) => spawn.runId)).toEqual(["run-1"]);
    expect(repo.findById("run-1")?.status).toBe("interrupted");
  });

  it("fences an agent submission when shutdown races its final config read", async () => {
    let releaseConfig!: () => void;
    const configBlocked = new Promise<void>((resolve) => {
      releaseConfig = resolve;
    });
    let configReadStarted = false;
    service = buildService({
      async readGlobal() {
        configReadStarted = true;
        await configBlocked;
        return { concurrencyLimit: 8, defaultTimeoutMs: 600_000 };
      },
    });

    const submissionPromise = service.submit(
      request({ commandName: "format", wait: true }),
    );
    await flush();
    expect(configReadStarted).toBe(true);

    await service.shutdown();
    releaseConfig();
    const submission = await submissionPromise;
    if (submission.kind === "accepted" && submission.lease) {
      await service.cancel(submission.runId, submission.lease.token);
    }

    expect(submission).toMatchObject({
      kind: "invalid",
      reason: "service_unavailable",
    });
    expect(repo.findById("run-1")).toBeNull();
    expect(repo.nextQueueOrder()).toBe(0);
    expect(runner.spawns).toHaveLength(0);
    expect(phases()).toEqual(["requested", "rejected"]);
  });

  it("fences a system submission when shutdown races its final registry read", async () => {
    let releaseConfig!: () => void;
    const configBlocked = new Promise<void>((resolve) => {
      releaseConfig = resolve;
    });
    let configReadStarted = false;
    service = buildService({
      async readRepoValidation() {
        configReadStarted = true;
        await configBlocked;
        return REPO_VALIDATION;
      },
    });

    const submissionPromise = service.submitSystem(
      systemRequest({
        command: { kind: "registered", name: "format" },
      }),
    );
    await flush();
    expect(configReadStarted).toBe(true);

    await service.shutdown();
    releaseConfig();
    const submission = await submissionPromise;
    if (submission.kind === "accepted") {
      await service.cancelSystemOwned(submission.runId);
    }

    expect(submission).toMatchObject({
      kind: "invalid",
      reason: "service_unavailable",
    });
    expect(repo.findById("run-1")).toBeNull();
    expect(repo.nextQueueOrder()).toBe(0);
    expect(runner.spawns).toHaveLength(0);
    expect(phases()).toEqual(["requested", "rejected"]);
  });

  it("does not pump queued work when shutdown races the pump config read", async () => {
    let releasePumpConfig!: () => void;
    const pumpConfigBlocked = new Promise<void>((resolve) => {
      releasePumpConfig = resolve;
    });
    let globalReadCount = 0;
    let pumpConfigReadStarted = false;
    let pumpCalls = 0;
    service = buildService({
      async readGlobal() {
        globalReadCount += 1;
        if (globalReadCount === 3) {
          pumpConfigReadStarted = true;
          await pumpConfigBlocked;
        }
        return { concurrencyLimit: 8, defaultTimeoutMs: 600_000 };
      },
      wrapScheduler(scheduler) {
        return {
          ...scheduler,
          pump(options) {
            pumpCalls += 1;
            return scheduler.pump(options);
          },
        };
      },
    });

    const running = await service.submit(request({ commandName: "test" }));
    expect(running.kind).toBe("accepted");
    if (running.kind !== "accepted") return;
    const queued = await service.submit(
      request({ commandName: "format", wait: true }),
    );
    expect(queued).toMatchObject({ kind: "accepted", status: "queued" });

    runner.runs
      .get(running.runId)
      ?.complete({ kind: "exited", exitCode: 0, output: "ok" });
    await flush();
    expect(pumpConfigReadStarted).toBe(true);

    await service.shutdown();
    releasePumpConfig();
    await flush();

    expect(pumpCalls).toBe(0);
    expect(
      repo.findById(queued.kind === "accepted" ? queued.runId : "")?.status,
    ).toBe("interrupted");
    expect(runner.spawns.map((spawn) => spawn.runId)).toEqual([running.runId]);
  });

  it("group-kills tracked runs before releasing their reservations", async () => {
    const running = await service.submit(request({ commandName: "test" }));
    if (running.kind !== "accepted") return;
    const queued = await service.submit(
      request({ commandName: "typecheck", wait: true }),
    );
    if (queued.kind !== "accepted") return;

    await service.shutdown();
    await flush();

    expect(repo.findById(running.runId)?.status).toBe("interrupted");
    expect(repo.findById(queued.runId)?.status).toBe("interrupted");
    expect(repo.findStaleActive()).toHaveLength(0);
    expect(service.poll(running.runId).result?.kind).toBe("interrupted");
  });
});
