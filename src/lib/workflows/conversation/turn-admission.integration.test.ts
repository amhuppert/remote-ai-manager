import { expect, it, vi } from "vitest";
import { createLifecycleFixture } from "./testing/lifecycle-fixture";

import {
  getConversationRuntime,
  conversationRuntimeKey,
} from "./runtime-state";
import type { AgentTaskResult } from "@/lib/agent-backends/task";
import { AgentProfileNotResolvableError } from "@/lib/agent-profiles/library-service";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

it("returns a typed profile refusal and releases admission for the next request", async () => {
  const refusal = new AgentProfileNotResolvableError({
    tier: "project",
    id: "missing-profile",
  });
  let failAdmission = true;
  const fixture = await createLifecycleFixture({
    beforeProfileAdmission: async () => {
      if (failAdmission) throw refusal;
    },
  });
  const submission = {
    binding: fixture.binding,
    turn: {
      kind: "task_run" as const,
      executionClass: "nongoverned-task" as const,
      promptText: "profile admission",
    },
  };
  try {
    expect(
      await fixture.manager.submitConversationTurn(submission),
    ).toMatchObject({
      kind: "refused",
      code: "profile_refused",
      error: refusal,
    });
    failAdmission = false;
    const next = await fixture.manager.submitConversationTurn(submission);
    if (next.kind !== "accepted") throw new Error(next.message);
    expect((await next.turn.completed).outcome.kind).toBe("call_result");
  } finally {
    await fixture.close();
  }
});

it("reserves async profile admission and only installs the accepted emitter and settings", async () => {
  const admissionGate = deferred<void>();
  const resultGate = deferred<AgentTaskResult>();
  let admitting = false;
  let profileAdmissions = 0;
  const fixture = await createLifecycleFixture({
    beforeProfileAdmission: () => {
      admitting = true;
      profileAdmissions++;
      return admissionGate.promise;
    },
    actorDeps: {
      getTaskRunner: () => ({
        backend: "claude",
        run: () => resultGate.promise,
      }),
    },
  });
  const acceptedEmit = vi.fn();
  const rejectedEmit = vi.fn();
  try {
    const first = fixture.manager.submitConversationTurn({
      binding: fixture.binding,
      turn: {
        kind: "task_run",
        executionClass: "nongoverned-task",
        promptText: "accepted",
      },
      transport: { streamId: "accepted", emit: acceptedEmit },
      executionContext: {
        workflowContext: { executionId: "e", contextId: "accepted settings" },
      },
    });
    await vi.waitFor(() => expect(admitting).toBe(true));
    const runtime = getConversationRuntime(
      conversationRuntimeKey(
        fixture.identity.projectPath,
        fixture.identity.sessionName,
        fixture.identity.conversationId,
      ),
    )!;
    expect(runtime.streamEmit).toBeUndefined();
    const second = await fixture.manager.submitConversationTurn({
      binding: fixture.binding,
      turn: {
        kind: "task_run",
        executionClass: "nongoverned-task",
        promptText: "rejected",
      },
      transport: { streamId: "rejected", emit: rejectedEmit },
      executionContext: {
        workflowContext: { executionId: "e", contextId: "rejected settings" },
      },
    });
    expect(second).toMatchObject({ kind: "refused", code: "busy" });
    admissionGate.resolve();
    const admitted = await first;
    if (admitted.kind !== "accepted") throw new Error(admitted.message);
    expect(profileAdmissions).toBe(1);
    expect(runtime.streamEmit).toBe(acceptedEmit);
    expect(runtime.workflowContext).toEqual({
      executionId: "e",
      contextId: "accepted settings",
    });
    resultGate.resolve({
      text: "accepted result",
      usage: null,
      error: null,
      timedOut: false,
      failure: null,
      continuationDisposition: "retain",
    });
    expect((await admitted.turn.completed).outcome).toMatchObject({
      kind: "call_result",
      result: { outcome: { text: "accepted result" } },
    });
    expect(rejectedEmit).not.toHaveBeenCalled();
  } finally {
    admissionGate.resolve();
    resultGate.resolve({
      text: "cleanup",
      usage: null,
      error: null,
      timedOut: false,
      failure: null,
      continuationDisposition: "retain",
    });
    await fixture.close();
  }
});

it("cancels a waiting caller without replacing the incumbent context or result", async () => {
  const resultGate = deferred<AgentTaskResult>();
  const fixture = await createLifecycleFixture({
    actorDeps: {
      getTaskRunner: () => ({
        backend: "claude",
        run: () => resultGate.promise,
      }),
    },
  });
  const emit = vi.fn();
  try {
    const first = await fixture.manager.submitConversationTurn({
      binding: fixture.binding,
      turn: {
        kind: "task_run",
        executionClass: "nongoverned-task",
        promptText: "incumbent",
      },
      transport: { streamId: "incumbent", emit },
      executionContext: {
        workflowContext: { executionId: "e", contextId: "incumbent" },
      },
    });
    if (first.kind !== "accepted") throw new Error(first.message);
    const controller = new AbortController();
    const waiting = fixture.manager.submitConversationTurn({
      binding: fixture.binding,
      turn: {
        kind: "task_run",
        executionClass: "nongoverned-task",
        promptText: "waiting",
      },
      executionContext: {
        workflowContext: { executionId: "e", contextId: "waiting" },
      },
      signal: controller.signal,
      waitUntilReady: true,
    });
    controller.abort();
    expect(await waiting).toMatchObject({ kind: "refused", code: "cancelled" });
    const runtime = getConversationRuntime(
      conversationRuntimeKey(
        fixture.identity.projectPath,
        fixture.identity.sessionName,
        fixture.identity.conversationId,
      ),
    )!;
    expect(runtime.streamEmit).toBe(emit);
    expect(runtime.workflowContext).toEqual({
      executionId: "e",
      contextId: "incumbent",
    });
    expect(runtime.attempt?.controller.signal.aborted).toBe(false);
    resultGate.resolve({
      text: "incumbent result",
      usage: null,
      error: null,
      timedOut: false,
      failure: null,
      continuationDisposition: "retain",
    });
    expect((await first.turn.completed).outcome).toMatchObject({
      kind: "call_result",
      result: { outcome: { text: "incumbent result" } },
    });
  } finally {
    resultGate.resolve({
      text: "cleanup",
      usage: null,
      error: null,
      timedOut: false,
      failure: null,
      continuationDisposition: "retain",
    });
    await fixture.close();
  }
});
