import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createControlPermits,
  type ControlPermits,
} from "@/lib/control/permits";
import type { OwnerRef, PendingIntent } from "@/lib/intents/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createControlPermitsRepo } from "@/lib/state-store/control-permits-repo";
import { createWorkspaceRepo } from "@/lib/state-store/workspace-repo";
import { createWorkspaceAdmission } from "./admission";
import type { WorkspaceEvidence } from "./evidence";
import {
  createWorkspaceExecutor,
  type CheckRunResult,
  type WorkspaceExecutor,
} from "./executor";
import type { WorkspaceBindingRequest } from "./schemas";

const now = "2026-10-03T10:00:00.000Z";
const worktree = "/repo/.worktrees/session";

function binding(
  scope: WorkspaceBindingRequest["scope"],
): WorkspaceBindingRequest {
  return {
    kind: "session",
    projectPath: "/repo",
    sessionName: "session",
    worktreePath: worktree,
    scope,
  };
}

let fixture: PersistenceFixture;
let permits: ControlPermits;
let touched: OwnerRef[];
let content: string;
let changed: string[];
let checkResult: CheckRunResult;
let checkWrites: string | null;
let checkHangs: boolean;

const evidence: WorkspaceEvidence = {
  async capture() {
    return content;
  },
  sameContent: (a, b) => a === b,
  async changedPaths(_wt, _scope, from, to) {
    return from === to ? [] : changed;
  },
};

function newExecutor(): WorkspaceExecutor {
  return createWorkspaceExecutor({
    transaction: (fn) => fixture.db.transaction(fn)(),
    repo: createWorkspaceRepo(fixture.db),
    permits,
    admission: createWorkspaceAdmission(),
    evidence,
    async runCheck({ signal }) {
      if (checkHangs) {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { status: "unavailable", detail: "cancelled" };
      }
      if (checkWrites !== null) content = checkWrites;
      return checkResult;
    },
    touchRequester: (owner) => touched.push(owner),
    now: () => now,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

let sequence = 0;
function intent(
  contextId: string,
  request: Record<string, unknown>,
): PendingIntent {
  sequence += 1;
  return {
    id: `intent-${sequence}`,
    requester: { kind: "context", id: contextId },
    executor: "workspace",
    cause: `${contextId}:${String(request.kind)}:${sequence}`,
    permit: permits.current(`context:${contextId}`),
    request,
    recordedAt: now,
  };
}

beforeEach(() => {
  fixture = createPersistenceFixture();
  permits = createControlPermits(createControlPermitsRepo(fixture.db));
  for (const id of ["ctx-a", "ctx-b"])
    permits.issue({ controllerId: `context:${id}`, parent: null, now });
  touched = [];
  content = "git:t1:t1";
  changed = [];
  checkResult = { status: "passed" };
  checkWrites = null;
  checkHangs = false;
});
afterEach(async () => {
  // Let a release's deferred drain finish before the database closes.
  await new Promise((resolve) => setImmediate(resolve));
  fixture.close();
});

async function run(
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

describe("workspace executor", () => {
  it("binds a context and makes an overlapping supervised binding wait for its release", async () => {
    const executor = newExecutor();
    const first = intent("ctx-a", {
      kind: "bind",
      bindingId: "ctx-a",
      binding: binding({ mode: "full" }),
    });
    expect(await run(executor, first)).toEqual({ kind: "bound" });

    const second = intent("ctx-b", {
      kind: "bind",
      bindingId: "ctx-b",
      binding: binding({ mode: "owned", paths: ["src/ui"] }),
    });
    await executor.submit(second);
    await executor.drain();
    expect(executor.outcome(second.cause)).toEqual({ kind: "queued" });

    executor.releaseBinding("ctx-a");
    await executor.drain();
    expect(executor.outcome(second.cause)).toEqual({
      kind: "settled",
      outcome: { kind: "bound" },
    });
    expect(touched).toEqual(
      expect.arrayContaining([{ kind: "context", id: "ctx-b" }]),
    );
  });

  it("starts a waiting binding only after the release's enclosing transaction commits", async () => {
    const executor = newExecutor();
    await run(
      executor,
      intent("ctx-a", {
        kind: "bind",
        bindingId: "ctx-a",
        binding: binding({ mode: "full" }),
      }),
    );
    const second = intent("ctx-b", {
      kind: "bind",
      bindingId: "ctx-b",
      binding: binding({ mode: "full" }),
    });
    await executor.submit(second);
    await executor.drain();

    expect(() =>
      fixture.db.transaction(() => {
        executor.releaseBinding("ctx-a");
        throw new Error("the caller's transaction failed");
      })(),
    ).toThrow("the caller's transaction failed");
    await executor.drain();
    expect(executor.outcome(second.cause)).toEqual({ kind: "queued" });
  });

  it("lets disjoint owned bindings coexist", async () => {
    const executor = newExecutor();
    await run(
      executor,
      intent("ctx-a", {
        kind: "bind",
        bindingId: "ctx-a",
        binding: binding({ mode: "owned", paths: ["src/api"] }),
      }),
    );
    expect(
      await run(
        executor,
        intent("ctx-b", {
          kind: "bind",
          bindingId: "ctx-b",
          binding: binding({ mode: "owned", paths: ["src/ui"] }),
        }),
      ),
    ).toEqual({ kind: "bound" });
  });

  it("freezes the current content and accepts it only while it is unchanged", async () => {
    const executor = newExecutor();
    await run(
      executor,
      intent("ctx-a", {
        kind: "bind",
        bindingId: "ctx-a",
        binding: binding({ mode: "full" }),
      }),
    );
    content = "git:t2:t2";
    expect(
      await run(
        executor,
        intent("ctx-a", { kind: "freeze", bindingId: "ctx-a" }),
      ),
    ).toEqual({
      kind: "frozen",
      evidence: "git:t2:t2",
    });
    expect(
      await run(
        executor,
        intent("ctx-a", {
          kind: "accept",
          bindingId: "ctx-a",
          evidence: "git:t2:t2",
        }),
      ),
    ).toEqual({
      kind: "accepted",
      receipt: "snapshot:git:t2:t2",
    });
    content = "git:t3:t3";
    expect(
      await run(
        executor,
        intent("ctx-a", {
          kind: "accept",
          bindingId: "ctx-a",
          evidence: "git:t2:t2",
        }),
      ),
    ).toEqual({
      kind: "candidate_changed",
    });
  });

  it("reports the reviewed files an acceptance check wrote", async () => {
    const executor = newExecutor();
    await run(
      executor,
      intent("ctx-a", {
        kind: "bind",
        bindingId: "ctx-a",
        binding: binding({ mode: "full" }),
      }),
    );
    checkWrites = "git:t9:t9";
    changed = ["src/__snapshots__/notice.snap"];

    expect(
      await run(
        executor,
        intent("ctx-a", {
          kind: "check",
          bindingId: "ctx-a",
          command: "test",
          evidence: content,
        }),
      ),
    ).toEqual({
      kind: "checked",
      status: "passed",
      wroteReviewedScope: ["src/__snapshots__/notice.snap"],
    });
  });

  it("interrupts a running acceptance check so a cancelled context is not held by it", async () => {
    const executor = newExecutor();
    await run(
      executor,
      intent("ctx-a", {
        kind: "bind",
        bindingId: "ctx-a",
        binding: binding({ mode: "full" }),
      }),
    );
    checkHangs = true;
    const check = intent("ctx-a", {
      kind: "check",
      bindingId: "ctx-a",
      command: "test",
      evidence: content,
    });
    await executor.submit(check);
    await new Promise((resolve) => setImmediate(resolve));
    expect(executor.outcome(check.cause)).toEqual({ kind: "running" });

    executor.interrupt?.(check.cause);
    await executor.drain();
    await new Promise((resolve) => setImmediate(resolve));
    expect(executor.outcome(check.cause)).toMatchObject({
      kind: "settled",
      outcome: { status: "unavailable" },
    });
  });

  it("reports a check that could not run as unavailable", async () => {
    const executor = newExecutor();
    await run(
      executor,
      intent("ctx-a", {
        kind: "bind",
        bindingId: "ctx-a",
        binding: binding({ mode: "full" }),
      }),
    );
    checkResult = { status: "unavailable", detail: "command not registered" };

    expect(
      await run(
        executor,
        intent("ctx-a", {
          kind: "check",
          bindingId: "ctx-a",
          command: "lint",
          evidence: content,
        }),
      ),
    ).toEqual({
      kind: "checked",
      status: "unavailable",
      detail: "command not registered",
      wroteReviewedScope: [],
    });
  });

  it("does not admit an operation while its permit is closed, and admits it after resubmission under a new generation", async () => {
    const executor = newExecutor();
    await run(
      executor,
      intent("ctx-a", {
        kind: "bind",
        bindingId: "ctx-a",
        binding: binding({ mode: "full" }),
      }),
    );
    const freeze = intent("ctx-a", { kind: "freeze", bindingId: "ctx-a" });
    permits.close("context:ctx-a", now);
    await executor.submit(freeze);
    await executor.drain();
    expect(executor.outcome(freeze.cause)).toEqual({ kind: "queued" });

    const permit = permits.reopen("context:ctx-a", now);
    await executor.drain();
    expect(executor.outcome(freeze.cause)).toEqual({ kind: "queued" });
    await executor.submit({ ...freeze, permit });
    await executor.drain();
    expect(executor.outcome(freeze.cause)).toMatchObject({ kind: "settled" });
  });

  it("returns queued work to the queue after a restart and runs it again", async () => {
    const executor = newExecutor();
    await run(
      executor,
      intent("ctx-a", {
        kind: "bind",
        bindingId: "ctx-a",
        binding: binding({ mode: "full" }),
      }),
    );
    const freeze = intent("ctx-a", { kind: "freeze", bindingId: "ctx-a" });
    await executor.submit(freeze);
    createWorkspaceRepo(fixture.db).updateOperation(freeze.cause, {
      state: "running",
      updatedAt: now,
    });

    const restarted = newExecutor();
    restarted.recover();
    expect(restarted.outcome(freeze.cause)).toEqual({ kind: "queued" });
    await restarted.drain();
    expect(restarted.outcome(freeze.cause)).toMatchObject({ kind: "settled" });
  });

  it("withdraws an operation its permit has not admitted", async () => {
    const executor = newExecutor();
    permits.close("context:ctx-a", now);
    const bind = intent("ctx-a", {
      kind: "bind",
      bindingId: "ctx-a",
      binding: binding({ mode: "full" }),
    });
    await executor.submit(bind);
    await executor.drain();
    await executor.withdraw(bind.cause);
    expect(executor.outcome(bind.cause)).toEqual({ kind: "unknown" });
  });
});
