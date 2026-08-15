import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { GlobalConfig } from "@/lib/config/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";

import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createWorkflowDocumentMaterializer } from "./document-materialization";
import { createSharedDocumentStore } from "./shared-document-store";
import {
  createGraphWorkflowSharedDocumentRegistryService,
  createWorkflowSeededDocumentService,
} from "./shared-documents";
import {
  createInMemoryLeaseReservation,
  createWorkflowDefinition,
  makeLaunchDocument,
} from "./test-fixtures";

/**
 * Engine-seeded shared documents, end to end through the REAL execution
 * repository, a REAL shared-document store rooted at a temp config dir, and the
 * REAL materializer — the only chain that proves a document seeded at launch
 * reaches a lane worktree forked afterwards.
 */

const PROJECT_PATH = "/repo/example";
const SESSION_NAME = "session-1";
const SPEC_DOC_PATH = ".cc/graph-workflow-docs/spec/pinned-spec.md";
const PINNED_CONTENTS = "# Pinned spec\n\n- Revision: 4\n\nCriterion text.\n";

const tempDirs: string[] = [];

function newTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function seededDocument(overrides: Partial<{ relativePath: string }> = {}) {
  return {
    relativePath: overrides.relativePath ?? SPEC_DOC_PATH,
    contents: PINNED_CONTENTS,
    description: "The pinned spec revision this run implements.",
    readWhen: "Read before judging whether work satisfies the spec.",
  };
}

function setup(
  overrides: {
    writeFile?: (absolutePath: string, contents: string) => Promise<void>;
  } = {},
) {
  const sessionWorktree = newTempDir("cc-seed-session-");
  const configDir = newTempDir("cc-seed-config-");
  const sessions = new Map<string, SessionState>();

  const session = {
    worktreePath: sessionWorktree,
    graphWorkflowExecution: null,
  } as unknown as SessionState;
  sessions.set(`${PROJECT_PATH}:${SESSION_NAME}`, session);

  const store = createSharedDocumentStore({
    resolveConfigDir: () => configDir,
  });
  const eventPublisher = createGraphWorkflowExecutionEventPublisher({
    broadcast() {},
  });

  const repo = createGraphWorkflowExecutionRepository({
    // No git worktree in this harness; the real exclusion would shell out.
    ensureCcArtifactsExcluded: async () => {},
    async getSession(projectPath, sessionName) {
      return sessions.get(`${projectPath}:${sessionName}`) ?? null;
    },
    async getActiveGraphWorkflowExecution(projectPath, sessionName) {
      return (
        sessions.get(`${projectPath}:${sessionName}`)?.graphWorkflowExecution ??
        null
      );
    },
    async mutateActiveGraphWorkflowExecution(
      projectPath,
      sessionName,
      _label,
      mutate,
    ) {
      const key = `${projectPath}:${sessionName}`;
      const current = sessions.get(key);
      if (current === undefined) throw new Error(`No session ${key}`);
      const { execution, events, pushes } = await mutate(
        current.graphWorkflowExecution,
      );
      current.graphWorkflowExecution = execution;
      return { execution, delivery: { events, pushes: pushes ?? [] } };
    },
    reserveActiveGraphWorkflowExecution: createInMemoryLeaseReservation({
      readActive: (projectPath, sessionName) =>
        sessions.get(`${projectPath}:${sessionName}`)?.graphWorkflowExecution ??
        null,
      installActive: (projectPath, sessionName, execution) => {
        const key = `${projectPath}:${sessionName}`;
        const current = sessions.get(key);
        if (current === undefined) throw new Error(`No session ${key}`);
        current.graphWorkflowExecution = execution;
      },
    }),
    async archiveActiveGraphWorkflowExecution() {
      return { archived: false as const, reason: "no_active" as const };
    },
    async markGraphWorkflowContextEventsPreReset() {
      return 0;
    },
    eventPublisher,
    seededDocumentService: createWorkflowSeededDocumentService({
      store,
      ...(overrides.writeFile ? { writeFile: overrides.writeFile } : {}),
    }),
    readConfig: async () => ({}) as GlobalConfig,
    readRepoConfig: async () => null,
  });

  return { repo, sessions, store, sessionWorktree, configDir };
}

async function launch(
  repo: ReturnType<typeof createGraphWorkflowExecutionRepository>,
  documents: ReturnType<typeof seededDocument>[],
): Promise<GraphWorkflowExecution> {
  const definition: WorkflowSemanticDefinition = createWorkflowDefinition();
  return repo.create(PROJECT_PATH, SESSION_NAME, {
    definition,
    source: {
      kind: "template",
      definitionId: "wf-1",
      definitionRevision: 1,
      tier: "project",
    },
    launchDocument: makeLaunchDocument(definition),
    executionId: "exec-seeded-1",
    startedAt: "2026-08-11T00:00:00.000Z",
    inputs: {},
    ownerConversationId: null,
    seededDocuments: documents,
  });
}

describe("engine-seeded shared documents", () => {
  it("materializes a document seeded at launch into a lane worktree forked afterwards", async () => {
    const { repo, store } = setup();
    const execution = await launch(repo, [seededDocument()]);

    // The lane worktree is created AFTER launch, as a real fork is: nothing
    // the seed wrote into the session worktree is present here.
    const laneWorktree = newTempDir("cc-seed-lane-");
    const materializer = createWorkflowDocumentMaterializer({ store });
    const result = await materializer.materialize({
      execution,
      worktreePath: laneWorktree,
    });

    expect(result.missing).toEqual([]);
    const laneContents = await readFile(
      path.join(laneWorktree, SPEC_DOC_PATH),
      "utf-8",
    );
    expect(laneContents).toBe(PINNED_CONTENTS);
  });

  it("registers the reserved path as an engine-seeded shared document", async () => {
    const { repo, sessionWorktree } = setup();
    const execution = await launch(repo, [seededDocument()]);

    const entry = execution.sharedDocuments.find(
      (doc) => doc.relativePath === SPEC_DOC_PATH,
    );
    expect(entry).toMatchObject({
      relativePath: SPEC_DOC_PATH,
      kind: "seeded",
      description: "The pinned spec revision this run implements.",
      readWhen: "Read before judging whether work satisfies the spec.",
    });

    // The session worktree also carries the copy, so a session-lane context
    // (which never materializes) reads the same bytes.
    await expect(
      readFile(path.join(sessionWorktree, SPEC_DOC_PATH), "utf-8"),
    ).resolves.toBe(PINNED_CONTENTS);
  });

  it("keeps materialized content pinned when the seeded file changes mid-run", async () => {
    const { repo, store, sessionWorktree } = setup();
    const execution = await launch(repo, [seededDocument()]);

    // Something edits the session worktree copy mid-run (an amendment applied
    // to the live spec would look exactly like this on disk).
    const sessionCopy = path.join(sessionWorktree, SPEC_DOC_PATH);
    await mkdir(path.dirname(sessionCopy), { recursive: true });
    await writeFile(sessionCopy, "# Amended spec\n", "utf-8");

    const laneWorktree = newTempDir("cc-seed-lane-");
    await createWorkflowDocumentMaterializer({ store }).materialize({
      execution,
      worktreePath: laneWorktree,
    });

    await expect(
      readFile(path.join(laneWorktree, SPEC_DOC_PATH), "utf-8"),
    ).resolves.toBe(PINNED_CONTENTS);
  });

  it("refuses a lane agent's attempt to re-register an engine-seeded document", async () => {
    const { repo } = setup();
    const execution = await launch(repo, [seededDocument()]);
    const registry = createGraphWorkflowSharedDocumentRegistryService();

    expect(() =>
      registry.applyUpsert(execution, {
        relativePath: SPEC_DOC_PATH,
        description: "mine now",
        readWhen: "whenever",
        conversationId: "conv-lane",
      }),
    ).toThrow(/engine/i);
  });

  it("fails the launch when a seeded document path escapes the worktree", async () => {
    const { repo, sessions } = setup();

    await expect(
      launch(repo, [seededDocument({ relativePath: "../outside/spec.md" })]),
    ).rejects.toThrow();

    // Path confinement is checked during REGISTRATION, which runs before the
    // lease reservation — so this launch never reached the CAS. Nothing was
    // persisted: no execution whose plan could cite the document.
    expect(
      sessions.get(`${PROJECT_PATH}:${SESSION_NAME}`)?.graphWorkflowExecution,
    ).toBeNull();
  });

  it("halts the reserved run when a seeded document cannot be written", async () => {
    const { repo, sessions } = setup({
      writeFile: async () => {
        throw new Error("disk full");
      },
    });

    await expect(launch(repo, [seededDocument()])).rejects.toThrow(/disk full/);

    // A write failure is different in kind from a bad path: the reservation has
    // already committed, so the run is the session's Current. It is halted
    // where it stands — located, reviewable, and retryable — rather than
    // vanishing into a launch nobody can account for.
    const active = sessions.get(
      `${PROJECT_PATH}:${SESSION_NAME}`,
    )?.graphWorkflowExecution;
    expect(active?.id).toBe("exec-seeded-1");
    expect(active?.status).toBe("halted");
    expect(active?.haltReason).toMatchObject({
      type: "execution_loop_failed",
      cause: "io",
    });
  });
});
