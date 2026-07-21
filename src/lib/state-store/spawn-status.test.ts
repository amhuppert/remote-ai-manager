import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import { createStateStore } from "./store";
import { seedWholeState } from "@/lib/shared/testing/whole-state-fixture";
import { sessionStateSchema, type SessionState } from "@/lib/sessions/schemas";
import {
  conversationStateSchema,
  type ConversationState,
} from "@/lib/conversations/schemas";

type Db = InstanceType<typeof Database>;

const PROJECT = "/repo";
const PLC_ID = "plc-1";

function makeSessionConversation(id: string): ConversationState {
  return conversationStateSchema.parse({
    id,
    scope: "session",
    transcriptPath: null,
    status: "running",
    promptCount: 1,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
  });
}

function makeSession(name: string): SessionState {
  return sessionStateSchema.parse({
    sessionName: name,
    worktreePath: `/wt/${name}`,
    branchName: `csm/${name}`,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    conversations: [makeSessionConversation(`${name}-conv`)],
  });
}

function makePlc(): ConversationState {
  return conversationStateSchema.parse({
    id: PLC_ID,
    scope: "project",
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    open: true,
  });
}

describe("spawned-session status read + back-link setters", () => {
  let db: Db;
  let store: ReturnType<typeof createStateStore>;

  beforeEach(async () => {
    db = _createTestDb({ inMemory: true });
    store = createStateStore({ db });
    seedWholeState(db, {
      projects: {
        [PROJECT]: {
          rootPath: PROJECT,
          sessions: {
            alpha: makeSession("alpha"),
            beta: makeSession("beta"),
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });
    await store.createProjectConversation(PROJECT, makePlc());
  });

  afterEach(() => {
    db.close();
  });

  it("setSessionSpawnedFrom persists the from-chat origin tag", async () => {
    await store.setSessionSpawnedFrom(PROJECT, "alpha", {
      source: "chat",
      projectName: "repo",
      conversationId: PLC_ID,
    });
    const session = await store.getSession(PROJECT, "alpha");
    expect(session?.spawnedFrom).toEqual({
      source: "chat",
      projectName: "repo",
      conversationId: PLC_ID,
    });
  });

  it("addPlcSpawnedSessionIds appends to the PLC back-link, de-duped", async () => {
    await store.addPlcSpawnedSessionIds(PROJECT, PLC_ID, ["alpha", "beta"]);
    await store.addPlcSpawnedSessionIds(PROJECT, PLC_ID, ["beta", "gamma"]);
    const plc = await store.getProjectConversation(PROJECT, PLC_ID);
    expect(plc?.spawnedSessionIds).toEqual(["alpha", "beta", "gamma"]);
  });

  it("getSpawnedSessionStatuses returns the linked sessions' slim status", async () => {
    await store.addPlcSpawnedSessionIds(PROJECT, PLC_ID, ["alpha", "beta"]);
    const statuses = await store.getSpawnedSessionStatuses(PROJECT, PLC_ID);
    expect(statuses.map((s) => s.sessionName).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    expect(statuses.every((s) => s.derivedStatus === "running")).toBe(true);
  });

  it("excludes a since-deleted session name from the status read", async () => {
    await store.addPlcSpawnedSessionIds(PROJECT, PLC_ID, ["alpha", "beta"]);
    await store.deleteSessionRow(PROJECT, "beta", "test-remove");
    const statuses = await store.getSpawnedSessionStatuses(PROJECT, PLC_ID);
    expect(statuses.map((s) => s.sessionName)).toEqual(["alpha"]);
  });

  it("returns an empty list when the PLC has no spawned sessions", async () => {
    const statuses = await store.getSpawnedSessionStatuses(PROJECT, PLC_ID);
    expect(statuses).toEqual([]);
  });
});
