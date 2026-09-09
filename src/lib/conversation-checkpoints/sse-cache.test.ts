import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  CONVERSATION_CHECKPOINT_UPDATED_EVENT,
  type ConversationCheckpointUpdatedEvent,
} from "./events";
import { checkpointKeys, type CheckpointTarget } from "./query-keys";
import type { CheckpointListPage } from "./queries";
import { checkpointReceiptFixture } from "./testing/receipt-fixture";
import {
  applyConversationCheckpointUpdatedEvent,
  publishCheckpointReceipt,
} from "./sse-cache";

const sessionTarget: CheckpointTarget = {
  scope: "session",
  projectName: "proj",
  sessionName: "sess",
  conversationId: "conv-1",
};

const projectTarget: CheckpointTarget = {
  scope: "project",
  projectName: "proj",
  conversationId: "conv-1",
};

function sessionEvent(
  receipt = checkpointReceiptFixture(),
): ConversationCheckpointUpdatedEvent {
  return {
    type: CONVERSATION_CHECKPOINT_UPDATED_EVENT,
    scope: "session",
    projectName: "proj",
    sessionName: "sess",
    conversationId: "conv-1",
    receipt,
  };
}

function page(
  receipts: CheckpointListPage["receipts"],
  nextBefore: number | null = null,
): CheckpointListPage {
  return { receipts, nextBefore };
}

describe("applyConversationCheckpointUpdatedEvent", () => {
  it("publishes the receipt as the operation's detail cache", () => {
    const client = new QueryClient();
    const receipt = checkpointReceiptFixture({
      operationId: "op-7",
      phase: "retiring",
    });

    applyConversationCheckpointUpdatedEvent(client, sessionEvent(receipt));

    expect(
      client.getQueryData(checkpointKeys.detail(sessionTarget, "op-7")),
    ).toEqual({ receipt });
  });

  it("replaces the matching receipt in a cached page and is idempotent", () => {
    const client = new QueryClient();
    const listKey = checkpointKeys.list(sessionTarget, { limit: 20 });
    client.setQueryData(
      listKey,
      page([
        checkpointReceiptFixture({
          operationId: "op-2",
          ordinal: 2,
          phase: "building",
        }),
        checkpointReceiptFixture({ operationId: "op-1", ordinal: 1 }),
      ]),
    );

    const advanced = checkpointReceiptFixture({
      operationId: "op-2",
      ordinal: 2,
      phase: "ready",
    });
    applyConversationCheckpointUpdatedEvent(client, sessionEvent(advanced));
    applyConversationCheckpointUpdatedEvent(client, sessionEvent(advanced));

    const stored = client.getQueryData<CheckpointListPage>(listKey);
    expect(stored?.receipts.map((r) => [r.operationId, r.phase])).toEqual([
      ["op-2", "ready"],
      ["op-1", "ready"],
    ]);
  });

  it("prepends a newer operation onto an uncursored page and keeps its size", () => {
    const client = new QueryClient();
    const listKey = checkpointKeys.list(sessionTarget, { limit: 1 });
    client.setQueryData(
      listKey,
      page([checkpointReceiptFixture({ operationId: "op-1", ordinal: 1 })], 1),
    );

    applyConversationCheckpointUpdatedEvent(
      client,
      sessionEvent(
        checkpointReceiptFixture({
          operationId: "op-2",
          ordinal: 2,
          phase: "building",
        }),
      ),
    );

    const stored = client.getQueryData<CheckpointListPage>(listKey);
    expect(stored?.receipts.map((r) => r.operationId)).toEqual(["op-2"]);
  });

  it("leaves a cursored page alone — it describes older ordinals", () => {
    const client = new QueryClient();
    const cursoredKey = checkpointKeys.list(sessionTarget, {
      before: 3,
      limit: 20,
    });
    const older = page([
      checkpointReceiptFixture({ operationId: "op-1", ordinal: 1 }),
    ]);
    client.setQueryData(cursoredKey, older);

    applyConversationCheckpointUpdatedEvent(
      client,
      sessionEvent(
        checkpointReceiptFixture({ operationId: "op-9", ordinal: 9 }),
      ),
    );

    expect(
      client
        .getQueryData<CheckpointListPage>(cursoredKey)
        ?.receipts.map((r) => r.operationId),
    ).toEqual(["op-1"]);
  });

  it("does not patch the other scope's caches for the same conversation id", () => {
    const client = new QueryClient();
    const projectListKey = checkpointKeys.list(projectTarget, { limit: 20 });
    client.setQueryData(
      projectListKey,
      page([
        checkpointReceiptFixture({
          operationId: "op-2",
          ordinal: 2,
          scope: "project",
          phase: "building",
        }),
      ]),
    );

    applyConversationCheckpointUpdatedEvent(
      client,
      sessionEvent(
        checkpointReceiptFixture({
          operationId: "op-2",
          ordinal: 2,
          phase: "ready",
        }),
      ),
    );

    expect(
      client
        .getQueryData<CheckpointListPage>(projectListKey)
        ?.receipts.map((r) => r.phase),
    ).toEqual(["building"]);
    expect(
      client.getQueryData(checkpointKeys.detail(projectTarget, "op-2")),
    ).toBeUndefined();
  });

  it("marks the addressed conversation's eligibility stale", () => {
    const client = new QueryClient();
    client.setQueryData(checkpointKeys.eligibility(sessionTarget), {
      eligible: true,
      refusals: [],
      active: null,
      hosted: false,
    });

    applyConversationCheckpointUpdatedEvent(client, sessionEvent());

    const state = client
      .getQueryCache()
      .find({ queryKey: checkpointKeys.eligibility(sessionTarget) });
    expect(state?.state.isInvalidated).toBe(true);
  });
});

// A mutation response and the SSE frame it caused race. The response can be
// the OLDER truth — a `building` admission reply delayed past the `ready`
// event — so the fold orders competing writes by the receipt's own stamp
// rather than by arrival, which is the only thing durable progress can trust.
describe("competing writes for the same operation", () => {
  const older = checkpointReceiptFixture({
    operationId: "op-1",
    phase: "building",
    updatedAt: "2026-09-01T00:01:00.000Z",
  });
  const newer = checkpointReceiptFixture({
    operationId: "op-1",
    phase: "ready",
    updatedAt: "2026-09-01T00:02:00.000Z",
  });

  it("keeps the newer phase when a stale response lands after it", () => {
    const client = new QueryClient();
    const listKey = checkpointKeys.list(sessionTarget, { limit: 5 });
    client.setQueryData(listKey, page([older]));

    publishCheckpointReceipt(client, sessionTarget, newer);
    publishCheckpointReceipt(client, sessionTarget, older);

    expect(
      client.getQueryData<CheckpointListPage>(listKey)?.receipts[0]?.phase,
    ).toBe("ready");
    expect(
      client.getQueryData<{ receipt: typeof newer }>(
        checkpointKeys.detail(sessionTarget, "op-1"),
      )?.receipt.phase,
    ).toBe("ready");
  });

  it("still applies a newer phase arriving after an older one", () => {
    const client = new QueryClient();
    const listKey = checkpointKeys.list(sessionTarget, { limit: 5 });
    client.setQueryData(listKey, page([older]));

    publishCheckpointReceipt(client, sessionTarget, older);
    publishCheckpointReceipt(client, sessionTarget, newer);

    expect(
      client.getQueryData<CheckpointListPage>(listKey)?.receipts[0]?.phase,
    ).toBe("ready");
    expect(
      client.getQueryData<{ receipt: typeof newer }>(
        checkpointKeys.detail(sessionTarget, "op-1"),
      )?.receipt.phase,
    ).toBe("ready");
  });

  it("accepts a re-published identical receipt", () => {
    const client = new QueryClient();
    const listKey = checkpointKeys.list(sessionTarget, { limit: 5 });
    client.setQueryData(listKey, page([newer]));

    publishCheckpointReceipt(client, sessionTarget, newer);

    expect(client.getQueryData<CheckpointListPage>(listKey)?.receipts).toEqual([
      newer,
    ]);
  });
});

describe("a full head page keeps its dropped tail reachable", () => {
  // A new operation arriving at the head pushes the oldest row out so the page
  // keeps the size its limit asked for. That row is still a saved operation,
  // so the page has to start advertising a cursor for it — otherwise the only
  // route to it disappears at the moment it is dropped.
  it("advertises a cursor for the row a prepend evicted", () => {
    const client = new QueryClient();
    const key = checkpointKeys.list(sessionTarget, { limit: 5 });
    const loaded = page(
      [5, 4, 3, 2, 1].map((ordinal) =>
        checkpointReceiptFixture({
          operationId: `op-${ordinal}`,
          ordinal,
          phase: "applied",
        }),
      ),
      // Nothing older than ordinal 1 exists, so the server reported no cursor.
      null,
    );
    client.setQueryData(key, loaded);

    applyConversationCheckpointUpdatedEvent(
      client,
      sessionEvent(
        checkpointReceiptFixture({
          operationId: "op-6",
          ordinal: 6,
          phase: "building",
        }),
      ),
    );

    const after = client.getQueryData<CheckpointListPage>(key);
    expect(after?.receipts.map((r) => r.ordinal)).toEqual([6, 5, 4, 3, 2]);
    // Ordinal 1 fell off the page; the cursor is what gets it back.
    expect(after?.nextBefore).toBe(2);
  });

  it("leaves an unfilled page's cursor alone when nothing is evicted", () => {
    const client = new QueryClient();
    const key = checkpointKeys.list(sessionTarget, { limit: 5 });
    client.setQueryData(
      key,
      page(
        [3, 2].map((ordinal) =>
          checkpointReceiptFixture({
            operationId: `op-${ordinal}`,
            ordinal,
            phase: "applied",
          }),
        ),
        2,
      ),
    );

    applyConversationCheckpointUpdatedEvent(
      client,
      sessionEvent(
        checkpointReceiptFixture({
          operationId: "op-4",
          ordinal: 4,
          phase: "building",
        }),
      ),
    );

    const after = client.getQueryData<CheckpointListPage>(key);
    expect(after?.receipts.map((r) => r.ordinal)).toEqual([4, 3, 2]);
    expect(after?.nextBefore).toBe(2);
  });
});
