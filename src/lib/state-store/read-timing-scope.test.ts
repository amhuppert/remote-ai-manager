/**
 * `state.read.timing` is a diagnostic identity surface (R1.3).
 *
 * `getConversation` is the one accessor that serves BOTH scopes through a single
 * session-keyed signature: it dispatches a sentinel-addressed read to the
 * project-conversation repository, which is correct, but it also reported the
 * raw store key as `sessionName` on every read that crossed the timing
 * threshold. These tests drive the real accessor through the real store with an
 * injected logger, and make the read slow enough to time by wrapping the
 * repository read — the production threshold is never crossed by an in-memory
 * lookup, which is exactly why the leak went unobserved.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import { createProjectsRepo } from "./projects-repo";
import { createSessionsRepo } from "./sessions-repo";
import { createConversationsRepo } from "./conversations-repo";
import { createProjectConversationsRepo } from "./project-conversations-repo";
import type { ProjectConversationsRepo } from "./project-conversations-repo";
import type { ConversationsRepo } from "./conversations-repo";
import { createStateStore } from "./store";
import { createWriteQueue } from "./write-queue";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import {
  createCapturingLogger,
  type CapturingLogger,
} from "@/lib/shared/testing/capturing-logger";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repo";
const SESSION_NAME = "feat";
const PROJECT_CONV_ID = "conv-project";
const SESSION_CONV_ID = "conv-session";

/** Burn wall-clock synchronously so the read crosses the 5ms timing threshold. */
function stall(): void {
  const until = performance.now() + 12;
  while (performance.now() < until) {
    /* spin */
  }
}

let db: Db;

function makeStore(log: CapturingLogger) {
  const projectConversations = createProjectConversationsRepo(db);
  const conversations = createConversationsRepo(db);
  const slowProjectConversations: ProjectConversationsRepo = {
    ...projectConversations,
    findByKey: (projectPath, conversationId) => {
      stall();
      return projectConversations.findByKey(projectPath, conversationId);
    },
  };
  const slowConversations: ConversationsRepo = {
    ...conversations,
    findByKey: (projectPath, sessionName, conversationId) => {
      stall();
      return conversations.findByKey(projectPath, sessionName, conversationId);
    },
  };
  return createStateStore({
    db,
    writeQueue: createWriteQueue(),
    logger: log,
    repos: {
      projectConversations: slowProjectConversations,
      conversations: slowConversations,
    },
  });
}

beforeEach(() => {
  db = _createTestDb();
  const projects = createProjectsRepo(db);
  const sessions = createSessionsRepo(db);
  const conversations = createConversationsRepo(db);
  const projectConversations = createProjectConversationsRepo(db);

  projects.upsert({ rootPath: PROJECT_PATH });
  sessions.upsert(
    PROJECT_PATH,
    sessionStateSchema.parse({
      sessionName: SESSION_NAME,
      worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
      branchName: `csm/${SESSION_NAME}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  conversations.upsert(
    PROJECT_PATH,
    SESSION_NAME,
    conversationStateSchema.parse({
      id: SESSION_CONV_ID,
      scope: "session",
      transcriptPath: null,
      status: "idle",
      promptCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  projectConversations.upsert(
    PROJECT_PATH,
    conversationStateSchema.parse({
      id: PROJECT_CONV_ID,
      scope: "project",
      transcriptPath: null,
      status: "idle",
      promptCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    }),
  );
});

afterEach(() => {
  db.close();
});

describe("state.read.timing conversation scope", () => {
  it("reports scope:project for a sentinel-addressed conversation read", async () => {
    const log = createCapturingLogger();
    const store = makeStore(log);

    const conversation = await store.getConversation(
      PROJECT_PATH,
      PROJECT_CONVERSATION_SESSION_SENTINEL,
      PROJECT_CONV_ID,
    );

    // The read really resolved through the project repository — otherwise
    // "no sentinel logged" would be vacuous.
    expect(conversation?.id).toBe(PROJECT_CONV_ID);

    const timing = log.entries.find(
      (e) =>
        e.message === "state.read.timing" &&
        e.fields.accessor === "getConversation",
    );
    expect(timing).toBeDefined();
    expect(timing?.fields).toMatchObject({
      scope: "project",
      conversationId: PROJECT_CONV_ID,
    });
    expect(timing?.fields).not.toHaveProperty("sessionName");
    expect(log.allFieldValues()).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
  });

  it("still reports the real session name for a session-addressed read", async () => {
    const log = createCapturingLogger();
    const store = makeStore(log);

    const conversation = await store.getConversation(
      PROJECT_PATH,
      SESSION_NAME,
      SESSION_CONV_ID,
    );

    expect(conversation?.id).toBe(SESSION_CONV_ID);
    const timing = log.entries.find(
      (e) =>
        e.message === "state.read.timing" &&
        e.fields.accessor === "getConversation",
    );
    expect(timing?.fields).toMatchObject({
      scope: "session",
      sessionName: SESSION_NAME,
      conversationId: SESSION_CONV_ID,
    });
  });
});
