import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createGraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import { applyFixtureMutation } from "./testing/execution-mutation-fixture";
import { createTestGraphExecutionContract } from "@/lib/workflow-graph/testing/execution-contract";
import {
  createGraphWorkflowExecutionToolContext,
  type GraphWorkflowExecutionToolContextDeps,
} from "./execution-tool-context";
import { createGraphWorkflowRuntimeEditService } from "./runtime-edits";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createGraphWorkflowSharedDocumentRegistryService } from "./shared-documents";
import { createSharedDocumentStore } from "./shared-document-store";
import { createWorkflowDocumentMaterializer } from "./document-materialization";
import { createWorkflowExecution } from "./test-fixtures";
import {
  publishWorkflowDocuments,
  withArtifactPublication,
} from "./artifact-publication";
import {
  assertLoopFence,
  runWithLoopFence,
  StaleLoopFenceError,
} from "./loop-fence";

let fixture: PersistenceFixture | null = null;
let directory: string | null = null;
afterEach(async () => {
  fixture?.close();
  fixture = null;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

describe("shared document publication", () => {
  it("delivers registrations current at queue admission and returns exactly the delivered snapshot", async () => {
    fixture = createPersistenceFixture();
    fixture.seedProject("/repo");
    fixture.seedSession("/repo", "session-1");
    const db = fixture.db;
    directory = await mkdtemp(path.join(tmpdir(), "cc-queued-documents-"));
    const root = directory;
    const store = createSharedDocumentStore({ resolveConfigDir: () => root });
    const initial = createWorkflowExecution({ status: "running" });
    const relativePath = ".cc/graph-workflow-docs/contract.md";
    const first = await store.captureContent({
      executionId: initial.id,
      contents: "First contract",
    });
    const second = await store.captureContent({
      executionId: initial.id,
      contents: "Second contract",
    });
    const third = await store.captureContent({
      executionId: initial.id,
      contents: "Third contract",
    });
    initial.sharedDocuments = [
      {
        id: "contract",
        createdAt: "2026-09-15T00:00:00.000Z",
        updatedAt: "2026-09-15T00:00:00.000Z",
        relativePath,
        kind: "shared",
        description: "First contract",
        readWhen: "Before work",
        lastUpdatedByConversationId: "producer",
        ...first,
      },
    ];
    const writeExecution = (execution: typeof initial) =>
      createGraphWorkflowExecutionsRepo(db).setActive(
        "/repo",
        "session-1",
        execution,
        "2026-09-15",
      );
    const readExecution = () =>
      createGraphWorkflowExecutionsRepo(db).getActive("/repo", "session-1")!;
    writeExecution(initial);
    const hold = Promise.withResolvers<void>();
    const admitted = Promise.withResolvers<void>();
    const blocker = withArtifactPublication("/repo", "session-1", async () => {
      admitted.resolve();
      await hold.promise;
    });
    await admitted.promise;
    const materializer = createWorkflowDocumentMaterializer({
      store,
      writeFile: async (absolutePath, contents) => {
        await writeFile(absolutePath, contents);
        const later = readExecution();
        later.sharedDocuments[0] = {
          ...later.sharedDocuments[0]!,
          ...third,
          description: "Third contract",
        };
        writeExecution(later);
      },
    });
    const delivery = publishWorkflowDocuments(
      {
        projectPath: "/repo",
        sessionName: "session-1",
        execution: initial,
        worktreePath: path.join(root, "consumer"),
      },
      {
        getActive: async () => readExecution(),
        materialize: materializer.materialize,
      },
    );
    const registered = readExecution();
    registered.sharedDocuments[0] = {
      ...registered.sharedDocuments[0]!,
      ...second,
      description: "Second contract",
    };
    writeExecution(registered);
    hold.resolve();
    await blocker;
    const delivered = await delivery;
    expect(
      await readFile(path.join(root, "consumer", relativePath), "utf8"),
    ).toBe("Second contract");
    expect(delivered.sharedDocuments[0]?.description).toBe("Second contract");
    expect(delivered.sharedDocuments[0]?.contentHash).toBe(second.contentHash);
    expect(readExecution().sharedDocuments[0]?.contentHash).toBe(
      third.contentHash,
    );
  });

  it("refuses dispatch when the generation retires during document I/O", async () => {
    const initial = createWorkflowExecution({ status: "running" });
    let current = initial;
    await expect(
      publishWorkflowDocuments(
        {
          projectPath: "/repo",
          sessionName: "session-1",
          execution: initial,
          worktreePath: "/unused",
        },
        {
          getActive: async () => current,
          materialize: async () => {
            current = {
              ...initial,
              status: "paused",
              loopEpoch: initial.loopEpoch + 1,
            };
          },
        },
      ),
    ).rejects.toBeInstanceOf(StaleLoopFenceError);
  });

  it.each(["loop", "route"])(
    "a refused %s finalize preserves published metadata and bytes after a durable reload",
    async (caller) => {
      fixture = createPersistenceFixture();
      fixture.seedProject("/repo");
      fixture.seedSession("/repo", "session-1");
      const db = fixture.db;
      directory = await mkdtemp(
        path.join(tmpdir(), "cc-document-publication-"),
      );
      const root = directory;
      const worktreePath = path.join(root, "producer");
      const relativePath = ".cc/graph-workflow-docs/plan.md";
      const source = path.join(worktreePath, relativePath);
      await mkdir(path.dirname(source), { recursive: true });
      await writeFile(source, "Published contract");
      const initial = createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
      });
      initial.contextStates["context-plan"]!.status = "running";
      fixture.graphWorkflowExecutions.setActive(
        "/repo",
        "session-1",
        initial,
        "2026-09-15",
      );
      const readExecution = () =>
        createGraphWorkflowExecutionsRepo(db).getActive("/repo", "session-1")!;
      const store = createSharedDocumentStore({ resolveConfigDir: () => root });
      let supersedeDuringCapture = false;
      const registry = createGraphWorkflowSharedDocumentRegistryService({
        captureDocumentContent: async (input) => {
          const reference = await store.captureFromWorktree(input);
          if (supersedeDuringCapture) {
            const current = readExecution();
            current.loopEpoch += 1;
            createGraphWorkflowExecutionsRepo(db).setActive(
              "/repo",
              "session-1",
              current,
              "2026-09-15",
            );
          }
          return reference;
        },
      });
      const mutateActive: GraphWorkflowExecutionToolContextDeps["executionRepository"]["mutateActive"] =
        async (projectPath, sessionName, change) => {
          const current = readExecution();
          assertLoopFence(projectPath, sessionName, current);
          return applyFixtureMutation(current, change, (next) => {
            createGraphWorkflowExecutionsRepo(db).setActive(
              projectPath,
              sessionName,
              next,
              "2026-09-15",
            );
          });
        };
      const tool = createGraphWorkflowExecutionToolContext({
        executionRepository: { mutateActive },
        executionContract: createTestGraphExecutionContract(),
        sharedDocumentRegistry: registry,
        runtimeEditService: createGraphWorkflowRuntimeEditService(),
        publishLiveEditApplied:
          createGraphWorkflowExecutionEventPublisher().publishLiveEditApplied,
        readLiveOccupancy: () => null,
      }).create({
        projectPath: "/repo",
        sessionName: "session-1",
        executionId: initial.id,
        contextId: "context-plan",
        conversationId: "producer",
        executionContextTitle: "Plan",
        executionTarget: {
          worktreePath,
          branchName: "producer",
          isolation: "session",
          laneId: null,
        },
        allowAgentTaskAdd: false,
        allowAgentCollaboration: false,
      });
      const request = {
        relativePath,
        description: "Published contract",
        readWhen: "Before work",
      };
      await tool.upsertSharedDocument(request);
      const published = readExecution().sharedDocuments;
      expect(published[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
      await writeFile(source, "Unpublished replacement");
      supersedeDuringCapture = true;
      const publishReplacement = () =>
        tool.upsertSharedDocument({
          ...request,
          description: "Refused replacement",
        });
      const replacement =
        caller === "loop"
          ? runWithLoopFence(
              {
                projectPath: "/repo",
                sessionName: "session-1",
                executionId: initial.id,
                loopEpoch: initial.loopEpoch,
              },
              publishReplacement,
            )
          : publishReplacement();
      await expect(replacement).rejects.toBeInstanceOf(StaleLoopFenceError);

      const reloaded = readExecution();
      expect(reloaded.sharedDocuments).toEqual(published);
      const target = path.join(root, "consumer");
      await createWorkflowDocumentMaterializer({
        store: createSharedDocumentStore({ resolveConfigDir: () => root }),
      }).materialize({ execution: reloaded, worktreePath: target });
      expect(await readFile(path.join(target, relativePath), "utf8")).toBe(
        "Published contract",
      );
    },
  );
});
