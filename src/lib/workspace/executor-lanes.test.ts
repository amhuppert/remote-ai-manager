import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createControlPermits,
  type ControlPermits,
} from "@/lib/control/permits";
import type { PendingIntent } from "@/lib/intents/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createControlPermitsRepo } from "@/lib/state-store/control-permits-repo";
import { createWorkspaceRepo } from "@/lib/state-store/workspace-repo";
import { createWorkspaceAdmission, type WorkspaceAdmission } from "./admission";
import type { WorkspaceEvidence } from "./evidence";
import {
  createWorkspaceExecutor,
  type WorkspaceExecutor,
  type WorkspaceExecutorDeps,
} from "./executor";
import { createDirectLaneIntegrator } from "./testing/direct-lane-integrator";
import { createFakeLaneGit } from "./testing/fake-lane-git";
import {
  laneProvisionReportSchema,
  type LaneTarget,
  type WorkspaceBindingRequest,
} from "./schemas";

const now = "2026-10-04T10:00:00.000Z";
const session = "/repo/.worktrees/session";
const laneWorktree = "/repo/.worktrees/session.1-api";

const lane: LaneTarget = {
  projectPath: "/repo",
  sessionName: "session",
  laneId: "1-api",
  worktreePath: laneWorktree,
  branch: "csm/session-1-api",
  sessionWorktreePath: session,
  sessionBranch: "csm/session",
};

function fakeGit() {
  const fake = createFakeLaneGit({
    "csm/session": "h0",
    "csm/session-1-api": "h0",
  });
  fake.adopt(laneWorktree, "csm/session-1-api");
  return fake;
}

let fixture: PersistenceFixture;
let permits: ControlPermits;
let content: string;
let checks: Array<{ command: string; worktreePath: string }>;
let failingCheck: string | null;
/** Holds every lane check until released, to land a pause while one runs. */
let checkGate: Promise<void> | null;
let fake: ReturnType<typeof fakeGit>;

const evidence: WorkspaceEvidence = {
  async capture() {
    return content;
  },
  sameContent: (a, b) => a === b,
  async changedPaths() {
    return [];
  },
};

function newExecutor(
  admission: WorkspaceAdmission = createWorkspaceAdmission(),
  touchRequester: WorkspaceExecutorDeps["touchRequester"] = () => {},
): WorkspaceExecutor {
  const runCheck: WorkspaceExecutorDeps["runCheck"] = async ({
    binding,
    command,
  }) => {
    checks.push({ command, worktreePath: binding.worktreePath });
    if (checkGate !== null) await checkGate;
    return command === failingCheck
      ? { status: "failed", detail: "2 type errors" }
      : { status: "passed" };
  };
  return createWorkspaceExecutor({
    transaction: (fn) => fixture.db.transaction(fn)(),
    repo: createWorkspaceRepo(fixture.db),
    permits,
    admission,
    evidence,
    lanes: fake.git,
    integrator: createDirectLaneIntegrator({ lanes: fake.git, runCheck }),
    runCheck,
    touchRequester,
    now: () => now,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

let sequence = 0;
function intent(
  requester: { kind: "context" | "run"; id: string },
  request: Record<string, unknown>,
): PendingIntent {
  sequence += 1;
  return {
    id: `intent-${sequence}`,
    requester,
    executor: "workspace",
    cause: `${requester.id}:${String(request.kind)}:${sequence}`,
    permit: permits.current(`${requester.kind}:${requester.id}`),
    request,
    recordedAt: now,
  };
}
const run = { kind: "run" as const, id: "run-1" };
const ctx = { kind: "context" as const, id: "ctx-a" };

async function settled(
  executor: WorkspaceExecutor,
  request: PendingIntent,
): Promise<unknown> {
  await executor.submit(request);
  await executor.drain();
  const state = executor.outcome(request.cause);
  if (state.kind !== "settled")
    throw new Error(`Expected settled, got ${state.kind}`);
  return state.outcome;
}

const laneBinding = (
  scope: WorkspaceBindingRequest["scope"],
): WorkspaceBindingRequest => ({
  kind: "lane",
  projectPath: "/repo",
  sessionName: "session",
  worktreePath: laneWorktree,
  branch: lane.branch,
  scope,
});

const publish = (checksToRun: string[] = []) =>
  intent(run, {
    kind: "publish",
    bindingId: `lane:${laneWorktree}`,
    lane,
    checks: checksToRun,
  });

beforeEach(() => {
  fixture = createPersistenceFixture();
  permits = createControlPermits(createControlPermitsRepo(fixture.db));
  permits.issue({ controllerId: "run:run-1", parent: null, now });
  permits.issue({ controllerId: "context:ctx-a", parent: null, now });
  content = "git:t1:t1";
  checks = [];
  failingCheck = null;
  checkGate = null;
  fake = fakeGit();
});
afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  fixture.close();
});

describe("lane provisioning", () => {
  it("starts a lane from the session branch's current head", async () => {
    fake.state.heads.set("csm/session", "h7");
    expect(
      await settled(
        newExecutor(),
        intent(run, {
          kind: "provision",
          bindingId: `lane:${laneWorktree}`,
          lane,
        }),
      ),
    ).toEqual({
      kind: "provisioned",
      baseline: "h7",
    });
    expect(fake.state.provisioned).toEqual([
      { worktreePath: laneWorktree, base: "h7" },
    ]);
  });

  it("refuses with the reason when the worktree cannot be made", async () => {
    fake.state.provisionFails = "The init script failed";
    expect(
      await settled(
        newExecutor(),
        intent(run, {
          kind: "provision",
          bindingId: `lane:${laneWorktree}`,
          lane,
        }),
      ),
    ).toEqual({
      kind: "refused",
      detail: "The init script failed",
    });
  });
});

describe("lane landing", () => {
  async function bound(
    executor: WorkspaceExecutor,
    scope: WorkspaceBindingRequest["scope"],
  ) {
    await settled(
      executor,
      intent(ctx, {
        kind: "bind",
        bindingId: "ctx-a",
        binding: laneBinding(scope),
      }),
    );
  }

  it("commits an accepted candidate's scope to the lane branch, marked with the operation", async () => {
    const executor = newExecutor();
    await bound(executor, { mode: "owned", paths: ["src/api"] });
    fake.state.dirt.set(laneWorktree, ["src/api/route.ts"]);
    const accept = intent(ctx, {
      kind: "accept",
      bindingId: "ctx-a",
      evidence: "git:t1:t1",
    });
    expect(await settled(executor, accept)).toEqual({
      kind: "accepted",
      receipt: "commit:c1",
    });
    expect(fake.state.landed).toEqual([
      {
        worktreePath: laneWorktree,
        paths: ["src/api"],
        message: expect.stringContaining(`CC-Landing: ${accept.cause}`),
      },
    ]);
  });

  it("lands every path for a full scope, accepts unchanged work without a commit, and refuses a changed candidate", async () => {
    const executor = newExecutor();
    await bound(executor, { mode: "full" });
    expect(
      await settled(
        executor,
        intent(ctx, {
          kind: "accept",
          bindingId: "ctx-a",
          evidence: "git:t1:t1",
        }),
      ),
    ).toEqual({
      kind: "accepted",
      receipt: "unchanged:h0",
    });
    expect(fake.state.landed[0]?.paths).toBeNull();
    content = "git:t2:t2";
    expect(
      await settled(
        executor,
        intent(ctx, {
          kind: "accept",
          bindingId: "ctx-a",
          evidence: "git:t1:t1",
        }),
      ),
    ).toEqual({
      kind: "candidate_changed",
    });
  });

  it("after a restart, recognizes a landing its marker shows already happened instead of committing again", async () => {
    const repo = createWorkspaceRepo(fixture.db);
    const executor = newExecutor();
    await bound(executor, { mode: "full" });
    const accept = intent(ctx, {
      kind: "accept",
      bindingId: "ctx-a",
      evidence: "git:t1:t1",
    });
    // The last process moved the branch and stopped before storing the receipt.
    repo.insertOperationIfAbsent({
      cause: accept.cause,
      bindingId: "ctx-a",
      requester: ctx,
      request: accept.request,
      permit: accept.permit,
      state: "running",
      outcome: null,
      createdAt: now,
      updatedAt: now,
    });
    fake.state.heads.set(lane.branch, "c9");
    fake.state.messages.set(
      "c9",
      `Context ctx-a\n\nCC-Landing: ${accept.cause}`,
    );

    const restarted = newExecutor();
    await restarted.recover();
    expect(restarted.outcome(accept.cause)).toEqual({
      kind: "settled",
      outcome: { kind: "accepted", receipt: "commit:c9" },
    });
    expect(fake.state.landed).toEqual([]);
    // The interrupted landing may not have resynced the lane's index.
    expect(fake.state.resynced).toEqual([
      { worktreePath: laneWorktree, paths: null },
    ]);
  });
});

describe("lane publication", () => {
  it("merges the session head into the lane, checks it there, and publishes it as one marked commit", async () => {
    const executor = newExecutor();
    const request = publish(["typecheck"]);
    expect(await settled(executor, request)).toEqual({
      kind: "published",
      commit: "c2",
      incorporated: "h0",
    });
    expect(fake.state.merges).toEqual(["h0"]);
    expect(checks).toEqual([
      { command: "typecheck", worktreePath: laneWorktree },
    ]);
    expect(fake.state.messages.get("c2")).toContain(
      `CC-Publication: ${request.cause}`,
    );
    expect(fake.state.heads.get("csm/session")).toBe("c2");
    expect(fake.state.removed).toEqual([laneWorktree]);
  });

  it("fails without publishing when the merge conflicts or a publication check fails", async () => {
    fake.state.conflicts = ["src/shared.ts"];
    expect(await settled(newExecutor(), publish())).toEqual({
      kind: "publication_failed",
      detail: expect.stringContaining("src/shared.ts"),
    });
    fake.state.conflicts = [];
    failingCheck = "typecheck";
    expect(await settled(newExecutor(), publish(["typecheck"]))).toEqual({
      kind: "publication_failed",
      detail: expect.stringContaining(
        '"typecheck" failed on the lane merged with h0: 2 type errors',
      ),
    });
    expect(fake.state.heads.get("csm/session")).toBe("h0");
    expect(fake.state.removed).toEqual([]);
  });

  it("refuses to publish over session changes, and onto a session head it did not check", async () => {
    fake.state.dirt.set(session, ["notes.md"]);
    expect(await settled(newExecutor(), publish())).toEqual({
      kind: "publish_blocked",
      detail: expect.stringContaining("notes.md"),
    });
    fake.state.dirt.set(session, []);
    fake.state.beforePublish = () => fake.state.heads.set("csm/session", "h9");
    expect(await settled(newExecutor(), publish())).toEqual({
      kind: "publication_stale",
      head: "h9",
    });
  });

  it("publishes two lanes into one session one after the other, the second merging the first's result", async () => {
    const uiWorktree = "/repo/.worktrees/session.1-ui";
    const ui: LaneTarget = {
      ...lane,
      laneId: "1-ui",
      worktreePath: uiWorktree,
      branch: "csm/session-1-ui",
    };
    fake.state.heads.set(ui.branch, "h0");
    fake.adopt(uiWorktree, ui.branch);
    const executor = newExecutor();
    const first = publish();
    const second = intent(run, {
      kind: "publish",
      bindingId: `lane:${uiWorktree}`,
      lane: ui,
      checks: [],
    });
    await executor.submit(first);
    await executor.submit(second);
    await executor.drain();

    const firstOutcome = executor.outcome(first.cause);
    const secondOutcome = executor.outcome(second.cause);
    expect(firstOutcome).toMatchObject({
      kind: "settled",
      outcome: { kind: "published", incorporated: "h0" },
    });
    const firstCommit =
      firstOutcome.kind === "settled" &&
      typeof firstOutcome.outcome === "object" &&
      firstOutcome.outcome !== null &&
      "commit" in firstOutcome.outcome
        ? firstOutcome.outcome.commit
        : null;
    expect(secondOutcome).toMatchObject({
      kind: "settled",
      outcome: { kind: "published", incorporated: firstCommit },
    });
    expect(fake.state.merges).toEqual(["h0", firstCommit]);
  });

  it("starts a waiting publication once the one before it settles, without another drain", async () => {
    const uiWorktree = "/repo/.worktrees/session.1-ui";
    const ui: LaneTarget = {
      ...lane,
      laneId: "1-ui",
      worktreePath: uiWorktree,
      branch: "csm/session-1-ui",
    };
    fake.state.heads.set(ui.branch, "h0");
    fake.adopt(uiWorktree, ui.branch);
    let release: () => void = () => {};
    fake.state.mergeGate = new Promise((resolve) => (release = resolve));
    const executor = newExecutor();
    const repo = createWorkspaceRepo(fixture.db);
    const queue = (request: PendingIntent, bindingId: string) =>
      repo.insertOperationIfAbsent({
        cause: request.cause,
        bindingId,
        requester: request.requester,
        request: request.request,
        permit: request.permit,
        state: "queued",
        outcome: null,
        createdAt: now,
        updatedAt: now,
      });
    // One drain starts the first publication and something quick beside it; once the quick one
    // finishes, that drain's next look finds nothing to start while the publication still merges.
    queue(publish(), `lane:${laneWorktree}`);
    queue(
      intent(run, {
        kind: "provision",
        bindingId: "lane:/repo/.worktrees/session.1-docs",
        lane: {
          ...lane,
          laneId: "1-docs",
          worktreePath: "/repo/.worktrees/session.1-docs",
          branch: "csm/session-1-docs",
        },
      }),
      "lane:/repo/.worktrees/session.1-docs",
    );
    void executor.drain();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = intent(run, {
      kind: "publish",
      bindingId: `lane:${uiWorktree}`,
      lane: ui,
      checks: [],
    });
    await executor.submit(second);
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.state.mergeGate = null;
    release();
    for (
      let tries = 0;
      tries < 50 && executor.outcome(second.cause).kind !== "settled";
      tries++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(executor.outcome(second.cause)).toMatchObject({
      kind: "settled",
      outcome: { kind: "published" },
    });
  });

  it("leaves a merge in progress in the lane alone and asks the owner to finish or abort it", async () => {
    fake.state.midMerge.add(laneWorktree);
    expect(await settled(newExecutor(), publish())).toEqual({
      kind: "publication_failed",
      detail: expect.stringContaining("merge in progress"),
    });
    expect(fake.state.midMerge.has(laneWorktree)).toBe(true);
    expect(fake.state.merges).toEqual([]);
  });

  it("never holds the session while waiting for its Git lock, and publishes once the lock is free", async () => {
    fake.state.lockBusy = 2;
    const admission = createWorkspaceAdmission();
    const executor = newExecutor(admission);
    const request = publish();
    await executor.submit(request);
    // While the lock reads as taken, nothing is published and an interactive turn in the session is not kept waiting.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(executor.outcome(request.cause).kind).toBe("running");
    expect(fake.state.heads.get("csm/session")).toBe("h0");
    const turn = admission.tryAcquire({
      worktree: session,
      kind: "interactive_write",
      holder: "owner-turn",
    });
    expect(turn).not.toBeNull();
    if (turn !== null) admission.release(turn);
    for (
      let tries = 0;
      tries < 200 && executor.outcome(request.cause).kind !== "settled";
      tries++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executor.outcome(request.cause)).toMatchObject({
      kind: "settled",
      outcome: { kind: "published" },
    });
  });

  it("reports a publication whose branch moved but whose worktree could not be refreshed as uncertain", async () => {
    fake.state.publishOutcome = {
      kind: "refresh_failed",
      commit: "c9",
      detail: "unable to unlink src/a.ts",
    };
    expect(await settled(newExecutor(), publish())).toEqual({
      kind: "publication_uncertain",
      detail: expect.stringContaining("c9"),
    });
    expect(fake.state.removed).toEqual([]);
  });

  it("refuses publication into a session worktree that checks out another branch", async () => {
    fake.state.checkedOut.set(session, "experiment");
    expect(await settled(newExecutor(), publish())).toEqual({
      kind: "publish_blocked",
      detail: expect.stringContaining("experiment"),
    });
  });

  it("refuses with a reason even when the failure it met carried no message", async () => {
    fake.state.provisionFails = "";
    const outcome = await settled(
      newExecutor(),
      intent(run, {
        kind: "provision",
        bindingId: `lane:${laneWorktree}`,
        lane,
      }),
    );
    expect(laneProvisionReportSchema.parse(outcome)).toEqual({
      kind: "refused",
      detail: expect.stringMatching(/\S/),
    });
  });

  it("refuses a lane holding changes no member landed", async () => {
    fake.state.dirt.set(laneWorktree, ["stray.txt"]);
    expect(await settled(newExecutor(), publish())).toEqual({
      kind: "publication_failed",
      detail: expect.stringContaining("stray.txt"),
    });
    expect(fake.state.merges).toEqual([]);
  });

  it("waits for an interactive turn in the session worktree before touching the session branch", async () => {
    const admission = createWorkspaceAdmission();
    const turn = admission.tryAcquire({
      worktree: session,
      kind: "interactive_write",
      holder: "owner-turn",
    });
    if (turn === null) throw new Error("no grant");
    const executor = newExecutor(admission);
    const request = publish();
    await executor.submit(request);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executor.outcome(request.cause).kind).not.toBe("settled");
    expect(fake.state.merges).toEqual([]);
    admission.release(turn);
    await executor.drain();
    expect(executor.outcome(request.cause)).toEqual({
      kind: "settled",
      outcome: { kind: "published", commit: "c2", incorporated: "h0" },
    });
  });

  it("does not publish a lane whose run was paused while it integrated: the session stays as it was", async () => {
    let releaseChecks = () => {};
    checkGate = new Promise((resolve) => (releaseChecks = resolve));
    const executor = newExecutor();
    const request = publish(["typecheck"]);
    await executor.submit(request);
    const drained = executor.drain();
    while (checks.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 1));

    permits.close("run:run-1", now);
    releaseChecks();
    await drained;
    expect(executor.outcome(request.cause)).toEqual({ kind: "queued" });
    expect(fake.state.heads.get("csm/session")).toBe("h0");
  });

  it("tells its run when a pause sent it back to the queue, so a run resumed meanwhile submits it again", async () => {
    const admission = createWorkspaceAdmission();
    const turn = admission.tryAcquire({
      worktree: session,
      kind: "interactive_write",
      holder: "owner-turn",
    });
    if (turn === null) throw new Error("no grant");
    const request = publish();
    // As the Run does on a touch: submit its pending step again under its current permit.
    const executor: WorkspaceExecutor = newExecutor(admission, () => {
      void executor.submit({
        ...request,
        permit: permits.current("run:run-1"),
      });
    });
    await executor.submit(request);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Paused and resumed while it still waits for the session; the resubmission meets it running.
    permits.close("run:run-1", now);
    permits.reopen("run:run-1", now);
    await executor.submit({ ...request, permit: permits.current("run:run-1") });
    admission.release(turn);
    await executor.drain();
    await executor.drain();

    expect(executor.outcome(request.cause)).toEqual({
      kind: "settled",
      outcome: { kind: "published", commit: "c2", incorporated: "h0" },
    });
  });

  it("does not publish through a pause it spent waiting for the session: it goes back to the queue, and runs again once resumed", async () => {
    const admission = createWorkspaceAdmission();
    const turn = admission.tryAcquire({
      worktree: session,
      kind: "interactive_write",
      holder: "owner-turn",
    });
    if (turn === null) throw new Error("no grant");
    const executor = newExecutor(admission);
    const request = publish();
    await executor.submit(request);
    await new Promise((resolve) => setTimeout(resolve, 20));

    permits.close("run:run-1", now);
    admission.release(turn);
    await executor.drain();
    expect(executor.outcome(request.cause)).toEqual({ kind: "queued" });
    expect(fake.state.merges).toEqual([]);
    expect(fake.state.heads.get("csm/session")).toBe("h0");

    permits.reopen("run:run-1", now);
    await executor.submit({ ...request, permit: permits.current("run:run-1") });
    await executor.drain();
    expect(executor.outcome(request.cause)).toEqual({
      kind: "settled",
      outcome: { kind: "published", commit: "c2", incorporated: "h0" },
    });
  });

  it("stops without waiting for the session when cancelled while it inspects the lane", async () => {
    const admission = createWorkspaceAdmission();
    const turn = admission.tryAcquire({
      worktree: session,
      kind: "interactive_write",
      holder: "owner-turn",
    });
    if (turn === null) throw new Error("no grant");
    let inspected = () => {};
    fake.state.inspectGate = new Promise((resolve) => (inspected = resolve));
    const executor = newExecutor(admission);
    const request = publish();
    await executor.submit(request);
    const drained = executor.drain();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await executor.interrupt(request.cause);
    inspected();
    await drained;
    expect(executor.outcome(request.cause)).toEqual({
      kind: "settled",
      outcome: {
        kind: "publication_failed",
        detail: "Stopped before publishing",
      },
    });
    expect(fake.state.merges).toEqual([]);
    expect(admission.held().map((grant) => grant.holder)).toEqual([
      "owner-turn",
    ]);
  });

  it("after a restart, recognizes a publication by its marker, and otherwise runs the attempt again", async () => {
    const repo = createWorkspaceRepo(fixture.db);
    const interrupted = (request: PendingIntent, outcome: unknown) =>
      repo.insertOperationIfAbsent({
        cause: request.cause,
        bindingId: `lane:${laneWorktree}`,
        requester: run,
        request: request.request,
        permit: request.permit,
        state: "running",
        outcome,
        createdAt: now,
        updatedAt: now,
      });
    const done = publish();
    interrupted(done, { incorporated: "h0" });
    fake.state.heads.set("csm/session", "c5");
    fake.state.messages.set(
      "c5",
      `Publish lane api\n\nCC-Publication: ${done.cause}`,
    );
    const notYet = publish();
    interrupted(notYet, { incorporated: "h0" });

    const restarted = newExecutor();
    await restarted.recover();
    expect(restarted.outcome(done.cause)).toEqual({
      kind: "settled",
      outcome: { kind: "published", commit: "c5", incorporated: "h0" },
    });
    expect(fake.state.removed).toEqual([laneWorktree]);
    expect(restarted.outcome(notYet.cause).kind).toBe("queued");
  });

  it("after a restart, finishes a found publication only while it holds the session and its Git lock", async () => {
    const repo = createWorkspaceRepo(fixture.db);
    const request = publish();
    repo.insertOperationIfAbsent({
      cause: request.cause,
      bindingId: `lane:${laneWorktree}`,
      requester: run,
      request: request.request,
      permit: request.permit,
      state: "running",
      outcome: { incorporated: "h0" },
      createdAt: now,
      updatedAt: now,
    });
    fake.state.heads.set("csm/session", "c5");
    fake.state.messages.set(
      "c5",
      `Publish lane api\n\nCC-Publication: ${request.cause}`,
    );
    fake.state.refresh = "refreshed";
    const admission = createWorkspaceAdmission();
    const turn = admission.tryAcquire({
      worktree: session,
      kind: "interactive_write",
      holder: "owner-turn",
    });
    if (turn === null) throw new Error("no grant");

    const recovered = newExecutor(admission).recover();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fake.state.completed).toEqual([]);
    admission.release(turn);
    fake.state.lockBusy = 1;
    await recovered;
    expect(fake.state.completed).toEqual([session]);
    expect(fake.state.lockBusy).toBe(0);
  });

  it("after a restart, does not call a found publication done while the session worktree differs from it", async () => {
    const repo = createWorkspaceRepo(fixture.db);
    const request = publish();
    repo.insertOperationIfAbsent({
      cause: request.cause,
      bindingId: `lane:${laneWorktree}`,
      requester: run,
      request: request.request,
      permit: request.permit,
      state: "running",
      outcome: { incorporated: "h0" },
      createdAt: now,
      updatedAt: now,
    });
    fake.state.heads.set("csm/session", "c5");
    fake.state.messages.set(
      "c5",
      `Publish lane api\n\nCC-Publication: ${request.cause}`,
    );
    fake.state.refresh = "diverged";

    const restarted = newExecutor();
    await restarted.recover();
    expect(restarted.outcome(request.cause)).toEqual({
      kind: "settled",
      outcome: {
        kind: "publication_uncertain",
        detail: expect.stringContaining("c5"),
      },
    });
    expect(fake.state.removed).toEqual([]);
  });
});
