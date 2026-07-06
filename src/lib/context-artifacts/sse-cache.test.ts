import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import { CONTEXT_ARTIFACT_SCHEMA_VERSION } from "./schemas";
import type { ContextArtifactStatusEvent } from "./schemas";
import { contextArtifactKeys, type ContextArtifactTarget } from "./query-keys";
import type { ContextArtifactDetail, ContextArtifactListItem } from "./queries";
import {
  applyContextArtifactStatusEvent,
  createTurnEndArtifactInvalidator,
} from "./sse-cache";

const sessionTarget: ContextArtifactTarget = {
  scope: "session",
  projectName: "proj",
  sessionName: "sess",
  conversationId: "conv-1",
};

const projectTarget: ContextArtifactTarget = {
  scope: "project",
  projectName: "proj",
  conversationId: "conv-1",
};

function makeListItem(
  overrides: Partial<ContextArtifactListItem> & { id: string },
): ContextArtifactListItem {
  return {
    kind: "conversation_compaction",
    scope: "session",
    projectPath: "/p/proj",
    sessionName: "sess",
    conversationId: "conv-1",
    messageId: null,
    messageIndex: null,
    coveredStartSeq: 0,
    coveredEndSeq: 42,
    sourceHash: "hash",
    status: "complete",
    error: null,
    modelProvider: "claude",
    model: "claude-sonnet-4-5",
    effort: null,
    schemaVersion: CONTEXT_ARTIFACT_SCHEMA_VERSION,
    promptVersion: "v1",
    normalizerVersion: "v1",
    createdBy: "user",
    createdByConversationId: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    stale: false,
    staleBehindMessages: 0,
    outdated: false,
    ...overrides,
  };
}

function sessionEvent(
  overrides: Partial<
    Extract<ContextArtifactStatusEvent, { scope: "session" }>
  > = {},
): ContextArtifactStatusEvent {
  return {
    type: "context_artifact_status",
    scope: "session",
    projectName: "proj",
    sessionName: "sess",
    conversationId: "conv-1",
    artifactId: "a-1",
    kind: "conversation_compaction",
    status: "pending",
    ...overrides,
  };
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

describe("applyContextArtifactStatusEvent", () => {
  it("renames a matching optimistic row to the server artifact id on pending without refetching the list", () => {
    const client = makeClient();
    const listKey = contextArtifactKeys.list(sessionTarget);
    client.setQueryData(listKey, [
      makeListItem({ id: "optimistic-123", status: "pending" }),
    ]);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    applyContextArtifactStatusEvent(client, sessionEvent());

    const cached = client.getQueryData<ContextArtifactListItem[]>(listKey);
    expect(cached?.map((row) => row.id)).toEqual(["a-1"]);
    expect(cached?.[0]?.status).toBe("pending");
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("matches optimistic message-compaction rows by messageIndex", () => {
    const client = makeClient();
    const listKey = contextArtifactKeys.list(sessionTarget);
    client.setQueryData(listKey, [
      makeListItem({
        id: "optimistic-a",
        kind: "message_compaction",
        messageIndex: 3,
        status: "pending",
      }),
      makeListItem({
        id: "optimistic-b",
        kind: "message_compaction",
        messageIndex: 7,
        status: "pending",
      }),
    ]);

    applyContextArtifactStatusEvent(
      client,
      sessionEvent({
        artifactId: "a-7",
        kind: "message_compaction",
        messageIndex: 7,
      }),
    );

    const cached = client.getQueryData<ContextArtifactListItem[]>(listKey);
    expect(cached?.map((row) => row.id)).toEqual(["optimistic-a", "a-7"]);
  });

  it("invalidates the list when a pending event matches no cached row", () => {
    const client = makeClient();
    const listKey = contextArtifactKeys.list(sessionTarget);
    client.setQueryData(listKey, [makeListItem({ id: "other" })]);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    applyContextArtifactStatusEvent(client, sessionEvent());

    expect(invalidate).toHaveBeenCalledWith({ queryKey: listKey });
  });

  it("patches the row status and refetches list + detail on complete", () => {
    const client = makeClient();
    const listKey = contextArtifactKeys.list(sessionTarget);
    const detailKey = contextArtifactKeys.detail(sessionTarget, "a-1");
    client.setQueryData(listKey, [
      makeListItem({ id: "a-1", status: "pending" }),
    ]);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    applyContextArtifactStatusEvent(
      client,
      sessionEvent({ status: "complete" }),
    );

    const cached = client.getQueryData<ContextArtifactListItem[]>(listKey);
    expect(cached?.[0]?.status).toBe("complete");
    expect(cached?.[0]?.error).toBeNull();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: listKey });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: detailKey });
  });

  it("records the failure message on the row and cached detail on failed", () => {
    const client = makeClient();
    const listKey = contextArtifactKeys.list(sessionTarget);
    const detailKey = contextArtifactKeys.detail(sessionTarget, "a-1");
    client.setQueryData(listKey, [
      makeListItem({ id: "a-1", status: "pending" }),
    ]);
    client.setQueryData(detailKey, {
      ...makeListItem({ id: "a-1", status: "pending" }),
      payload: null,
    } satisfies ContextArtifactDetail);

    applyContextArtifactStatusEvent(
      client,
      sessionEvent({ status: "failed", error: "model timed out" }),
    );

    const list = client.getQueryData<ContextArtifactListItem[]>(listKey);
    expect(list?.[0]?.status).toBe("failed");
    expect(list?.[0]?.error).toBe("model timed out");
    const detail = client.getQueryData<ContextArtifactDetail>(detailKey);
    expect(detail?.status).toBe("failed");
    expect(detail?.error).toBe("model timed out");
  });

  it("routes project-scope events to project keys, leaving session caches untouched", () => {
    const client = makeClient();
    const sessionListKey = contextArtifactKeys.list(sessionTarget);
    const projectListKey = contextArtifactKeys.list(projectTarget);
    client.setQueryData(sessionListKey, [
      makeListItem({ id: "a-1", status: "pending" }),
    ]);
    client.setQueryData(projectListKey, [
      makeListItem({
        id: "a-1",
        scope: "project",
        sessionName: null,
        status: "pending",
      }),
    ]);

    applyContextArtifactStatusEvent(client, {
      type: "context_artifact_status",
      scope: "project",
      projectName: "proj",
      conversationId: "conv-1",
      artifactId: "a-1",
      kind: "conversation_compaction",
      status: "complete",
    });

    const project =
      client.getQueryData<ContextArtifactListItem[]>(projectListKey);
    const session =
      client.getQueryData<ContextArtifactListItem[]>(sessionListKey);
    expect(project?.[0]?.status).toBe("complete");
    expect(session?.[0]?.status).toBe("pending");
  });

  it("does nothing to an unfetched list on pending beyond a no-op invalidation", () => {
    const client = makeClient();
    const listKey = contextArtifactKeys.list(sessionTarget);

    applyContextArtifactStatusEvent(client, sessionEvent());

    expect(client.getQueryData(listKey)).toBeUndefined();
  });
});

describe("createTurnEndArtifactInvalidator", () => {
  function makeInvalidatorClient() {
    const client = makeClient();
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");
    return { client, invalidateQueries };
  }

  it("invalidates the conversation's artifact queries when its status leaves running", () => {
    const { client, invalidateQueries } = makeInvalidatorClient();
    const onStatus = createTurnEndArtifactInvalidator();

    onStatus(client, {
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      status: "running",
    });
    expect(invalidateQueries).not.toHaveBeenCalled();

    onStatus(client, {
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      status: "awaiting",
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: contextArtifactKeys.conversation(sessionTarget),
    });
  });

  it("covers both the list and detail keys via the conversation prefix", () => {
    expect(contextArtifactKeys.list(sessionTarget)).toEqual([
      ...contextArtifactKeys.conversation(sessionTarget),
      "list",
    ]);
    expect(contextArtifactKeys.detail(sessionTarget, "a-1")).toEqual([
      ...contextArtifactKeys.conversation(sessionTarget),
      "detail",
      "a-1",
    ]);
  });

  it("does not invalidate on running → running", () => {
    const { client, invalidateQueries } = makeInvalidatorClient();
    const onStatus = createTurnEndArtifactInvalidator();

    onStatus(client, {
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      status: "running",
    });
    onStatus(client, {
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      status: "running",
    });
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("does not invalidate when a status event was never preceded by running", () => {
    const { client, invalidateQueries } = makeInvalidatorClient();
    const onStatus = createTurnEndArtifactInvalidator();

    onStatus(client, {
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      status: "awaiting",
    });
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("does not invalidate an unrelated conversation's keys when another conversation stops running", () => {
    const { client, invalidateQueries } = makeInvalidatorClient();
    const onStatus = createTurnEndArtifactInvalidator();

    onStatus(client, {
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      status: "running",
    });
    onStatus(client, {
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-2",
      status: "awaiting",
    });
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("tracks statuses per conversation, including running → waiting_for_input", () => {
    const { client, invalidateQueries } = makeInvalidatorClient();
    const onStatus = createTurnEndArtifactInvalidator();

    onStatus(client, {
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      status: "running",
    });
    onStatus(client, {
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-2",
      status: "running",
    });
    onStatus(client, {
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-2",
      status: "waiting_for_input",
    });

    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: contextArtifactKeys.conversation({
        scope: "session",
        projectName: "proj",
        sessionName: "sess",
        conversationId: "conv-2",
      }),
    });
  });

  it("routes project-scope status events to the project conversation key", () => {
    const { client, invalidateQueries } = makeInvalidatorClient();
    const onStatus = createTurnEndArtifactInvalidator();

    onStatus(client, {
      scope: "project",
      projectName: "proj",
      conversationId: "conv-1",
      status: "running",
    });
    onStatus(client, {
      scope: "project",
      projectName: "proj",
      conversationId: "conv-1",
      status: "awaiting",
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: contextArtifactKeys.conversation(projectTarget),
    });
  });
});
