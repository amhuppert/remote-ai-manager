import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createConfigReader } from "../config/loader";
import { createStateStore } from ".";
import { getStateDb } from "./store";
import {
  _createTestDb,
  _installTestDb,
  _resetForTesting as _resetStateDb,
} from "./state-db";
import {
  seedWholeState,
  readWholeStateForTest,
} from "@/lib/shared/testing/whole-state-fixture";
import type { ManagerState } from "../projects/schemas";

const TEST_DIR = path.join("/tmp", "cc-refdoc-test-" + Date.now());

function createTestStateManager() {
  const configReader = createConfigReader(TEST_DIR);
  return createStateStore({
    readConfig: () => configReader.readConfig(),
  });
}

const PROJECT_PATH = "/test/project";
const SESSION_NAME = "test-session";

function stateWithSession(): ManagerState {
  return {
    projects: {
      [PROJECT_PATH]: {
        rootPath: PROJECT_PATH,
        sessions: {
          [SESSION_NAME]: {
            sessionName: SESSION_NAME,
            worktreePath: "/tmp/wt",
            branchName: "csm/test",
            createdAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            archived: false,
            finished: false,
            conversations: [],
            source: "cc",
            creationMode: "normal",
            tddEnabled: true,
            targetBranch: "main",
            parentSessionName: null,
            graphWorkflowExecution: null,
            referenceDocuments: [],
          },
        },
      },
    },
    archivedProjects: [],
    pinnedProjects: [],
  };
}

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  _installTestDb(_createTestDb({ inMemory: true }));
});

afterEach(async () => {
  _resetStateDb();
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ===========================================================================
// createReferenceDocument
// ===========================================================================

describe("createReferenceDocument", () => {
  it("creates a new reference document", async () => {
    const { createReferenceDocument } = createTestStateManager();
    seedWholeState(getStateDb(), stateWithSession());

    const doc = await createReferenceDocument(
      PROJECT_PATH,
      SESSION_NAME,
      ".cc/references/design.md",
      "Architecture design notes",
    );

    expect(doc.filePath).toBe(".cc/references/design.md");
    expect(doc.description).toBe("Architecture design notes");
    expect(doc.id).toBeTruthy();
    expect(doc.createdAt).toBeTruthy();

    const state = readWholeStateForTest(getStateDb());
    const session = state.projects[PROJECT_PATH]!.sessions[SESSION_NAME]!;
    expect(session.referenceDocuments).toHaveLength(1);
    expect(session.referenceDocuments[0]!.filePath).toBe(
      ".cc/references/design.md",
    );
  });

  it("updates description when filePath already exists (idempotent)", async () => {
    const { createReferenceDocument } = createTestStateManager();
    seedWholeState(getStateDb(), stateWithSession());

    const first = await createReferenceDocument(
      PROJECT_PATH,
      SESSION_NAME,
      "memory-bank/focus.md",
      "Original description",
    );

    const second = await createReferenceDocument(
      PROJECT_PATH,
      SESSION_NAME,
      "memory-bank/focus.md",
      "Updated description",
    );

    expect(second.id).toBe(first.id);
    expect(second.description).toBe("Updated description");

    const state = readWholeStateForTest(getStateDb());
    const session = state.projects[PROJECT_PATH]!.sessions[SESSION_NAME]!;
    expect(session.referenceDocuments).toHaveLength(1);
  });

  it("throws when session does not exist", async () => {
    const { createReferenceDocument } = createTestStateManager();
    seedWholeState(getStateDb(), {
      projects: {
        [PROJECT_PATH]: {
          rootPath: PROJECT_PATH,
          sessions: {},
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    await expect(
      createReferenceDocument(PROJECT_PATH, "nonexistent", "file.md", "desc"),
    ).rejects.toThrow(/not found/);
  });
});

// ===========================================================================
// deleteReferenceDocument
// ===========================================================================

describe("deleteReferenceDocument", () => {
  it("removes a document and returns it", async () => {
    const { createReferenceDocument, deleteReferenceDocument } =
      createTestStateManager();
    seedWholeState(getStateDb(), stateWithSession());

    const doc = await createReferenceDocument(
      PROJECT_PATH,
      SESSION_NAME,
      "file.md",
      "desc",
    );

    const removed = await deleteReferenceDocument(
      PROJECT_PATH,
      SESSION_NAME,
      doc.id,
    );

    expect(removed).not.toBeNull();
    expect(removed!.id).toBe(doc.id);

    const state = readWholeStateForTest(getStateDb());
    const session = state.projects[PROJECT_PATH]!.sessions[SESSION_NAME]!;
    expect(session.referenceDocuments).toHaveLength(0);
  });

  it("returns null when document not found", async () => {
    const { deleteReferenceDocument } = createTestStateManager();
    seedWholeState(getStateDb(), stateWithSession());

    const removed = await deleteReferenceDocument(
      PROJECT_PATH,
      SESSION_NAME,
      "nonexistent-id",
    );

    expect(removed).toBeNull();
  });
});

// ===========================================================================
// getReferenceDocuments
// ===========================================================================

describe("getReferenceDocuments", () => {
  it("returns documents for a session", async () => {
    const { createReferenceDocument, getReferenceDocuments } =
      createTestStateManager();
    seedWholeState(getStateDb(), stateWithSession());

    await createReferenceDocument(PROJECT_PATH, SESSION_NAME, "a.md", "Doc A");
    await createReferenceDocument(PROJECT_PATH, SESSION_NAME, "b.md", "Doc B");

    const docs = await getReferenceDocuments(PROJECT_PATH, SESSION_NAME);
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.filePath).sort()).toEqual(["a.md", "b.md"]);
  });

  it("returns empty array for session with no documents", async () => {
    const { getReferenceDocuments } = createTestStateManager();
    seedWholeState(getStateDb(), stateWithSession());

    const docs = await getReferenceDocuments(PROJECT_PATH, SESSION_NAME);
    expect(docs).toEqual([]);
  });
});
