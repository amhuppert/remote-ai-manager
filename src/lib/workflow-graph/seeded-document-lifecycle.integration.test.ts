import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { GlobalConfig } from "@/lib/config/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { createGraphWorkflowArchivedExecutionsRepo } from "@/lib/state-store/graph-workflow-archived-executions-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import { pinnedSpecDocumentPath } from "@/lib/specs/delivery-plan";
import { buildSpecExecutionClaimsDocument } from "@/lib/specs/execution-claims-document";

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
  definition: WorkflowSemanticDefinition = createWorkflowDefinition(),
  transactionAttachment?: (context: { executionId: string }) => void,
): Promise<GraphWorkflowExecution> {
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
    transactionAttachment,
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
    let attachmentCalled = false;

    await expect(
      launch(
        repo,
        [seededDocument({ relativePath: "../outside/spec.md" })],
        createWorkflowDefinition(),
        () => {
          attachmentCalled = true;
        },
      ),
    ).rejects.toThrow();

    // Path confinement is checked during REGISTRATION, which runs before the
    // lease reservation — so this launch never reached the CAS. Nothing was
    // persisted: no execution whose plan could cite the document.
    expect(
      sessions.get(`${PROJECT_PATH}:${SESSION_NAME}`)?.graphWorkflowExecution,
    ).toBeNull();
    expect(attachmentCalled).toBe(false);
  });

  it("rejects colliding seeded paths before writing or persisting the run", async () => {
    const { repo, sessions, sessionWorktree } = setup();

    await expect(
      launch(repo, [
        seededDocument(),
        { ...seededDocument(), contents: "# Conflicting ownership\n" },
      ]),
    ).rejects.toThrow(/collision/i);

    expect(
      sessions.get(`${PROJECT_PATH}:${SESSION_NAME}`)?.graphWorkflowExecution,
    ).toBeNull();
    await expect(
      readFile(path.join(sessionWorktree, SPEC_DOC_PATH), "utf-8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("materializes byte-identical pinned spec and claims files across lanes and archived execution reads", async () => {
    const { repo, store, sessions } = setup();
    const candidateId = "candidate-loop-expanded";
    const documents = [
      {
        relativePath: pinnedSpecDocumentPath("spec-bindings"),
        contents: "# Pinned spec-bindings spec\n\nImmutable revision bytes.\n",
        description: "The pinned spec revision this run implements.",
        readWhen: "Read before implementing or validating the spec.",
      },
      buildSpecExecutionClaimsDocument({
        candidateId,
        heading: "Spec ownership",
        body: [
          `- Candidate: \`${candidateId}\``,
          "- Pinned revision: `revision-loop-expanded`",
          "",
          "| Criterion id | Claimant context ids |",
          "| --- | --- |",
          "| `criterion-dynamic` | `context-spawner` |",
        ].join("\n"),
      }),
    ];
    const dynamicDefinition = createWorkflowDefinition();
    dynamicDefinition.executionContexts[0]!.id = "context-spawner";
    dynamicDefinition.executionContexts[0]!.mutability = {
      allowAgentTaskAdd: true,
      allowAgentContextAdd: true,
    };
    for (const task of dynamicDefinition.tasks) {
      if (task.contextId === "context-plan") {
        task.contextId = "context-spawner";
      }
    }
    for (const edge of dynamicDefinition.edges) {
      if (edge.sourceContextId === "context-plan") {
        edge.sourceContextId = "context-spawner";
      }
    }
    dynamicDefinition.executionContexts[2]!.outputSchema = {
      type: "object",
      properties: { approved: { type: "boolean" } },
      required: ["approved"],
    };
    dynamicDefinition.loopGroups = [
      {
        id: "verify-loop",
        title: "Verify expanded work",
        bodyContextIds: ["context-implement", "context-verify"],
        entryContextId: "context-implement",
        exitContextId: "context-verify",
        until: {
          schema: {
            type: "object",
            properties: { approved: { const: true } },
            required: ["approved"],
          },
        },
        maxPasses: 2,
      },
    ];
    expect(dynamicDefinition.loopGroups.length).toBeGreaterThan(0);
    expect(
      dynamicDefinition.executionContexts.some(
        (context) => context.id === "context-spawner",
      ),
    ).toBe(true);
    expect(
      dynamicDefinition.executionContexts.find(
        (context) => context.id === "context-spawner",
      )?.mutability?.allowAgentContextAdd,
    ).toBe(true);

    const execution = await launch(repo, documents, dynamicDefinition);
    expect(execution.sharedDocuments).toEqual(
      expect.arrayContaining(
        documents.map((document) =>
          expect.objectContaining({
            relativePath: document.relativePath,
            kind: "seeded",
          }),
        ),
      ),
    );
    expect(documents[0]!.relativePath).not.toBe(documents[1]!.relativePath);

    const materializer = createWorkflowDocumentMaterializer({ store });
    for (const lane of ["implementer", "validator"]) {
      const laneWorktree = newTempDir(`cc-seed-${lane}-`);
      await materializer.materialize({ execution, worktreePath: laneWorktree });
      for (const document of documents) {
        await expect(
          readFile(path.join(laneWorktree, document.relativePath), "utf-8"),
        ).resolves.toBe(document.contents);
      }
    }

    const archiveDb = _createTestDb({ inMemory: true });
    try {
      archiveDb
        .prepare("INSERT INTO projects (root_path) VALUES (?)")
        .run(PROJECT_PATH);
      archiveDb
        .prepare(
          `INSERT INTO sessions (
             project_path, session_name, worktree_path, branch_name,
             created_at, last_activity_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          PROJECT_PATH,
          SESSION_NAME,
          "/tmp/archived-session",
          "cc/archived-session",
          "2026-08-15T00:00:00.000Z",
          "2026-08-15T00:00:00.000Z",
        );
      const archives = createGraphWorkflowArchivedExecutionsRepo(archiveDb);
      archives.insert({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        executionId: execution.id,
        archivedAt: "2026-08-15T01:00:00.000Z",
        status: execution.status,
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
        execution,
      });
      sessions.get(`${PROJECT_PATH}:${SESSION_NAME}`)!.graphWorkflowExecution =
        null;
      const archived = archives.findByExecutionId(execution.id);
      expect(archived).not.toBeNull();
      const archivedLane = newTempDir("cc-seed-archived-lane-");
      await materializer.materialize({
        execution: archived!,
        worktreePath: archivedLane,
      });
      for (const document of documents) {
        await expect(
          readFile(path.join(archivedLane, document.relativePath), "utf-8"),
        ).resolves.toBe(document.contents);
      }
    } finally {
      archiveDb.close();
    }
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
