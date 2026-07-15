/**
 * Section 7.3 — Verify concurrency and recovery behavior under multi-lane load.
 *
 * Section 6.x tests pin per-feature parity, and Section 7.2 cross-checks the
 * shared status bus + artifact registry under interleaved publish. This suite
 * is the concurrency / recovery guard. It exercises multi-lane scheduling
 * under realistic parallel workflows, restart-time recovery via the
 * `WorkflowEnvelopeStore` + `WorkflowEnvelopeRepository`, and artifact
 * discoverability when several workflows write into one registry.
 *
 * Coverage:
 *  1. **Multi-lane scheduling under realistic parallel workflows.** Two
 *     write-capable workflows on the same session worktree interleave through
 *     the `LaneScheduler` so the worktree never observes overlapping writes.
 *     Read-only executions (workflows that have proven they don't mutate the
 *     worktree) run alongside write-capable executions on the same session.
 *     Different sessions remain independent.
 *  2. **Pause and resume recovery across simulated restart.** A `mid_turn`
 *     ask-user pause and a `post_turn` human-approval pause are persisted into
 *     a `WorkflowEnvelopeStore` by one repository instance and recovered by a
 *     fresh repository instance reading the same store — preserving the
 *     `pauseKind` / `gateKind` distinction so the resumer routes to the right
 *     state.
 *  3. **Artifact discoverability under parallel workflows.** Multiple
 *     workflows registering reference and shared documents through one shared
 *     `ArtifactRegistry` produce records whose `source.workflowId` /
 *     `source.laneId` round-trip without contamination, and mixed required +
 *     optional writes stay isolated when one fails.
 *  4. **Worktree safety preservation invariant.** The shared layer never
 *     silently relaxes write-capable safety: an unspecified `writeCapability`
 *     is treated as `write_capable` so single-flight semantics are preserved
 *     by default, even after read-only calls have run on the same session.
 *
 * Requirements: 5.2, 6.5, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { createLaneScheduler } from "./lane-scheduler";
import {
  createArtifactRegistry,
  type ArtifactRegistration,
  type ArtifactRecord,
} from "./artifact-registry";
import { createInMemoryWorkflowEnvelopeStore } from "./workflow-envelope-store";
import { createWorkflowEnvelopeRepository } from "./workflow-envelope-repository";
import type {
  WorkflowEnvelope,
  WorkflowEnvelopePause,
} from "./workflow-envelope-vocabulary";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Drains pending microtasks several times so we can assert that scheduled
 * work has had a chance to start without waiting on real time.
 */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

describe("section 7.3 — concurrency and recovery under multi-lane load (Task 7.3)", () => {
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "section7-3-concurrency-"),
    );
  });

  afterEach(async () => {
    await fs.rm(workingDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------
  // 1. Multi-lane scheduling under realistic parallel workflows
  // -----------------------------------------------------------------
  describe("multi-lane scheduling preserves worktree-safe concurrency", () => {
    it("two write-capable workflows on the same session worktree serialize through the shared LaneScheduler so the worktree never sees overlapping writes", async () => {
      const scheduler = createLaneScheduler();
      const trace: string[] = [];

      // Workflow A — collaboration slice, has two write-capable lanes that
      // each go through scheduler.schedule().
      const aGate = deferred<void>();
      const collaborationA = scheduler.schedule(
        {
          sessionKey: "acme/session-1",
          workflowId: "wf-collab-a",
          laneId: "lane-claude",
          writeCapability: "write_capable",
        },
        async () => {
          trace.push("collab-a:claude:start");
          await aGate.promise;
          trace.push("collab-a:claude:end");
          return "a-claude-done";
        },
      );

      // Workflow B — graph workflow on the same session worktree. It must
      // wait until the collaboration lane finishes its write-capable run.
      const bGate = deferred<void>();
      const graphB = scheduler.schedule(
        {
          sessionKey: "acme/session-1",
          workflowId: "wf-graph-b",
          laneId: "lane-implementer",
          writeCapability: "write_capable",
        },
        async () => {
          trace.push("graph-b:implementer:start");
          await bGate.promise;
          trace.push("graph-b:implementer:end");
          return "b-graph-done";
        },
      );

      await drainMicrotasks();
      // Only the first write-capable execution has been allowed to start —
      // the second is queued behind the same session-key chain.
      expect(trace).toEqual(["collab-a:claude:start"]);

      aGate.resolve();
      bGate.resolve();
      await Promise.all([collaborationA, graphB]);

      // The two workflows interleave in serial order on the same session key,
      // never overlap.
      expect(trace).toEqual([
        "collab-a:claude:start",
        "collab-a:claude:end",
        "graph-b:implementer:start",
        "graph-b:implementer:end",
      ]);
    });

    it("read-only executions on the same session run concurrently with each other and never delay write-capable executions in the queue", async () => {
      const scheduler = createLaneScheduler();
      const trace: string[] = [];

      // Read-only lane (e.g., a graph context that reads but does not write
      // worktree files). Should not acquire the write lock.
      const readGate1 = deferred<void>();
      const readRun1 = scheduler.schedule(
        {
          sessionKey: "acme/session-1",
          workflowId: "wf-graph",
          laneId: "lane-readonly-1",
          writeCapability: "read_only",
        },
        async () => {
          trace.push("read-1:start");
          await readGate1.promise;
          trace.push("read-1:end");
          return "read-1-done";
        },
      );

      const readGate2 = deferred<void>();
      const readRun2 = scheduler.schedule(
        {
          sessionKey: "acme/session-1",
          workflowId: "wf-graph",
          laneId: "lane-readonly-2",
          writeCapability: "read_only",
        },
        async () => {
          trace.push("read-2:start");
          await readGate2.promise;
          trace.push("read-2:end");
          return "read-2-done";
        },
      );

      // Write-capable execution comes in while both reads are still pending.
      const writeGate = deferred<void>();
      const writeRun = scheduler.schedule(
        {
          sessionKey: "acme/session-1",
          workflowId: "wf-collab",
          laneId: "lane-claude",
          writeCapability: "write_capable",
        },
        async () => {
          trace.push("write:start");
          await writeGate.promise;
          trace.push("write:end");
          return "write-done";
        },
      );

      await drainMicrotasks();
      // Both reads and the write begin on the next tick — read-only executions
      // never queue behind a write.
      expect(trace.sort()).toEqual([
        "read-1:start",
        "read-2:start",
        "write:start",
      ]);

      readGate1.resolve();
      readGate2.resolve();
      writeGate.resolve();

      await Promise.all([readRun1, readRun2, writeRun]);

      // All three completed; no execution starved.
      expect(trace).toContain("read-1:end");
      expect(trace).toContain("read-2:end");
      expect(trace).toContain("write:end");
    });

    it("write-capable executions on different session worktrees do not block each other", async () => {
      const scheduler = createLaneScheduler();
      const trace: string[] = [];

      const aGate = deferred<void>();
      const xRun = scheduler.schedule(
        {
          sessionKey: "acme/session-1",
          workflowId: "wf-x",
          writeCapability: "write_capable",
        },
        async () => {
          trace.push("session-1:start");
          await aGate.promise;
          trace.push("session-1:end");
          return "x";
        },
      );

      const bGate = deferred<void>();
      const yRun = scheduler.schedule(
        {
          sessionKey: "acme/session-2",
          workflowId: "wf-y",
          writeCapability: "write_capable",
        },
        async () => {
          trace.push("session-2:start");
          await bGate.promise;
          trace.push("session-2:end");
          return "y";
        },
      );

      await drainMicrotasks();
      // Both sessions started in parallel — no shared lock.
      expect(trace.sort()).toEqual(["session-1:start", "session-2:start"]);

      aGate.resolve();
      bGate.resolve();
      await Promise.all([xRun, yRun]);
      expect(trace).toContain("session-1:end");
      expect(trace).toContain("session-2:end");
    });

    it("a failing write-capable execution does not strand the session lock — the next queued write proceeds", async () => {
      const scheduler = createLaneScheduler();
      const trace: string[] = [];

      const failing = scheduler.schedule(
        {
          sessionKey: "acme/session-1",
          workflowId: "wf-failing",
          writeCapability: "write_capable",
        },
        async () => {
          trace.push("failing:start");
          throw new Error("backend exploded");
        },
      );

      const successor = scheduler.schedule(
        {
          sessionKey: "acme/session-1",
          workflowId: "wf-successor",
          writeCapability: "write_capable",
        },
        async () => {
          trace.push("successor:start");
          return "ok";
        },
      );

      await expect(failing).rejects.toThrow("backend exploded");
      expect(await successor).toBe("ok");
      expect(trace).toEqual(["failing:start", "successor:start"]);
    });
  });

  // -----------------------------------------------------------------
  // 2. Pause and resume recovery across simulated restart
  // -----------------------------------------------------------------
  describe("pause and resume recovery preserves pauseKind/gateKind across simulated server restart", () => {
    function buildEnvelope(
      overrides: Partial<WorkflowEnvelope> = {},
    ): WorkflowEnvelope {
      return {
        workflowId: "wf-rec-1",
        workflowType: "collaboration",
        status: "running",
        phase: "round-1",
        createdAt: "2026-04-28T10:00:00.000Z",
        updatedAt: "2026-04-28T10:00:00.000Z",
        featureSnapshot: { round: 1 },
        ...overrides,
      };
    }

    it("a mid-turn ask-user pause stored by one repository is recovered by a fresh repository as pauseKind=mid_turn / gateKind=ask_user", async () => {
      const store = createInMemoryWorkflowEnvelopeStore();
      const repoA = createWorkflowEnvelopeRepository({ store });

      await repoA.create(
        buildEnvelope({
          workflowId: "wf-mid-turn",
          workflowType: "conversation",
          phase: "executing",
        }),
      );

      const midTurnPause: WorkflowEnvelopePause = {
        pauseKind: "mid_turn",
        gateKind: "ask_user",
        resumeToken: "resume-mid-1",
        details: { questionCount: 2 },
      };
      await repoA.markPaused("wf-mid-turn", midTurnPause);

      // Simulate a server restart: drop the repository instance, keep only
      // the durable store. A fresh repository must surface the pause.
      const repoB = createWorkflowEnvelopeRepository({ store });
      const recovered = await repoB.get("wf-mid-turn");
      expect(recovered?.status).toBe("paused");
      expect(recovered?.pause).toEqual(midTurnPause);
      expect(recovered?.pause?.pauseKind).toBe("mid_turn");
      expect(recovered?.pause?.gateKind).toBe("ask_user");
    });

    it("a post-turn human-approval pause stored by one repository is recovered by a fresh repository as pauseKind=post_turn / gateKind=human_approval", async () => {
      const store = createInMemoryWorkflowEnvelopeStore();
      const repoA = createWorkflowEnvelopeRepository({ store });

      await repoA.create(
        buildEnvelope({
          workflowId: "wf-post-turn",
          workflowType: "graph_workflow",
          phase: "awaiting-approval",
        }),
      );

      const postTurnPause: WorkflowEnvelopePause = {
        pauseKind: "post_turn",
        gateKind: "human_approval",
        resumeToken: "resume-post-1",
      };
      await repoA.markPaused("wf-post-turn", postTurnPause);

      const repoB = createWorkflowEnvelopeRepository({ store });
      const recovered = await repoB.get("wf-post-turn");
      expect(recovered?.status).toBe("paused");
      expect(recovered?.pause?.pauseKind).toBe("post_turn");
      expect(recovered?.pause?.gateKind).toBe("human_approval");
      expect(recovered?.pause?.resumeToken).toBe("resume-post-1");
    });

    it("listByStatus(paused) on a fresh repository discovers every paused workflow regardless of which workflow type produced the pause", async () => {
      const store = createInMemoryWorkflowEnvelopeStore();
      const repoA = createWorkflowEnvelopeRepository({ store });

      // 4 workflows: 2 paused (mid-turn + post-turn), 1 running, 1 completed.
      await repoA.create(
        buildEnvelope({
          workflowId: "wf-paused-mid",
          workflowType: "conversation",
        }),
      );
      await repoA.markPaused("wf-paused-mid", {
        pauseKind: "mid_turn",
        gateKind: "ask_user",
        resumeToken: "rt-1",
      });

      await repoA.create(
        buildEnvelope({
          workflowId: "wf-paused-post",
          workflowType: "graph_workflow",
        }),
      );
      await repoA.markPaused("wf-paused-post", {
        pauseKind: "post_turn",
        gateKind: "human_approval",
        resumeToken: "rt-2",
      });

      await repoA.create(
        buildEnvelope({
          workflowId: "wf-running",
          workflowType: "merge_job",
        }),
      );

      await repoA.create(
        buildEnvelope({
          workflowId: "wf-completed",
          workflowType: "collaboration",
        }),
      );
      await repoA.markCompleted("wf-completed");

      // Restart: build a fresh repository over the same store.
      const repoB = createWorkflowEnvelopeRepository({ store });
      const paused = await repoB.listByStatus("paused");
      expect(paused.map((e) => e.workflowId).sort()).toEqual([
        "wf-paused-mid",
        "wf-paused-post",
      ]);

      // Active = running + paused, but not completed/failed.
      const active = await repoB.listActive();
      expect(active.map((e) => e.workflowId).sort()).toEqual([
        "wf-paused-mid",
        "wf-paused-post",
        "wf-running",
      ]);

      // Pause projections are independently recoverable per workflow.
      const mid = paused.find((e) => e.workflowId === "wf-paused-mid");
      const post = paused.find((e) => e.workflowId === "wf-paused-post");
      expect(mid?.pause?.pauseKind).toBe("mid_turn");
      expect(post?.pause?.pauseKind).toBe("post_turn");
    });

    it("resuming a paused envelope clears the pause projection so a subsequent restart sees the running state without stale pause metadata", async () => {
      const store = createInMemoryWorkflowEnvelopeStore();
      const repoA = createWorkflowEnvelopeRepository({ store });

      await repoA.create(
        buildEnvelope({
          workflowId: "wf-resume-1",
          workflowType: "graph_workflow",
        }),
      );
      await repoA.markPaused("wf-resume-1", {
        pauseKind: "post_turn",
        gateKind: "human_approval",
        resumeToken: "resume-it",
      });
      await repoA.markRunning("wf-resume-1");

      const repoB = createWorkflowEnvelopeRepository({ store });
      const recovered = await repoB.get("wf-resume-1");
      expect(recovered?.status).toBe("running");
      expect(recovered?.pause).toBeUndefined();
    });

    it("parent-child workflow linkage is restart-discoverable so a restart can walk a partially-running workflow tree", async () => {
      const store = createInMemoryWorkflowEnvelopeStore();
      const repoA = createWorkflowEnvelopeRepository({ store });

      await repoA.create(
        buildEnvelope({
          workflowId: "wf-parent",
          workflowType: "collaboration",
        }),
      );
      await repoA.create(
        buildEnvelope({
          workflowId: "wf-child-1",
          workflowType: "conversation",
          parentWorkflowId: "wf-parent",
        }),
      );
      await repoA.create(
        buildEnvelope({
          workflowId: "wf-child-2",
          workflowType: "conversation",
          parentWorkflowId: "wf-parent",
        }),
      );
      await repoA.create(
        buildEnvelope({
          workflowId: "wf-unrelated",
          workflowType: "graph_workflow",
        }),
      );

      const repoB = createWorkflowEnvelopeRepository({ store });
      const children = await repoB.listChildren("wf-parent");
      expect(children.map((c) => c.workflowId).sort()).toEqual([
        "wf-child-1",
        "wf-child-2",
      ]);
    });
  });

  // -----------------------------------------------------------------
  // 3. Artifact discoverability under parallel workflows
  // -----------------------------------------------------------------
  describe("artifact discoverability remains intact when multiple workflows write through the same registry", () => {
    it("concurrent writes from N parallel lanes preserve source identity (workflowId, laneId, round) and canonical paths in their records and registration callbacks", async () => {
      const referenceCalls: Array<{
        relativePath: string;
        sourceWorkflowId?: string;
        sourceLaneId?: string;
        sourceRound?: number;
      }> = [];
      const sharedDocCalls: Array<{
        relativePath: string;
        sourceWorkflowId?: string;
      }> = [];
      const registration: ArtifactRegistration = {
        registerReferenceDocument: async (input) => {
          referenceCalls.push({
            relativePath: input.relativePath,
            sourceWorkflowId: input.source.workflowId,
            sourceLaneId: input.source.laneId,
            sourceRound: input.source.round,
          });
        },
        registerSharedDocument: async (input) => {
          sharedDocCalls.push({
            relativePath: input.relativePath,
            sourceWorkflowId: input.source.workflowId,
          });
        },
      };
      const registry = createArtifactRegistry({
        writeFile: (absolutePath, contents) =>
          fs.writeFile(absolutePath, contents),
        ensureDir: (absolutePath) =>
          fs.mkdir(absolutePath, { recursive: true }).then(() => undefined),
        registration,
      });

      // 4 different workflows writing concurrently. Each carries a distinct
      // (workflowId, laneId, round) tuple that must round-trip into the
      // record + registration callback without contamination.
      const writes: Array<Promise<ArtifactRecord>> = [
        registry.write({
          kind: "reference_document",
          worktreePath: workingDir,
          relativePath: "memory-bank/collaboration/wf-A/merged-design.md",
          contents: "design A",
          audience: "user_facing",
          description: "merged design A",
          source: { workflowId: "wf-A", laneId: "lane-claude", round: 3 },
        }),
        registry.write({
          kind: "graph_shared_document",
          worktreePath: workingDir,
          relativePath: ".cc/graph-workflow-docs/graph-B-plan.md",
          contents: "plan B",
          audience: "user_facing",
          description: "graph plan B",
          readWhen: "before implementing",
          source: { workflowId: "wf-B", laneId: "lane-planner", round: 1 },
        }),
        registry.write({
          kind: "validation_log",
          worktreePath: workingDir,
          relativePath: ".cc/workflow/wf-C/validation.log",
          contents: "log C",
          audience: "internal_log",
          source: { workflowId: "wf-C", laneId: "lane-validator", round: 2 },
        }),
        registry.write({
          kind: "codex_output",
          worktreePath: workingDir,
          relativePath: "memory-bank/codex/wf-D/output.md",
          contents: "codex out D",
          audience: "user_facing",
          source: { workflowId: "wf-D", laneId: "lane-codex", round: 1 },
        }),
      ];
      const records = await Promise.all(writes);

      // Each record carries its own source identity — no cross-workflow leak.
      const byWorkflow = new Map<string, ArtifactRecord>();
      for (const record of records) {
        byWorkflow.set(record.source.workflowId!, record);
      }
      expect(byWorkflow.get("wf-A")?.kind).toBe("reference_document");
      expect(byWorkflow.get("wf-A")?.source.laneId).toBe("lane-claude");
      expect(byWorkflow.get("wf-A")?.source.round).toBe(3);
      expect(byWorkflow.get("wf-B")?.kind).toBe("graph_shared_document");
      expect(byWorkflow.get("wf-B")?.source.laneId).toBe("lane-planner");
      expect(byWorkflow.get("wf-C")?.kind).toBe("validation_log");
      expect(byWorkflow.get("wf-C")?.source.laneId).toBe("lane-validator");
      expect(byWorkflow.get("wf-D")?.kind).toBe("codex_output");
      expect(byWorkflow.get("wf-D")?.source.laneId).toBe("lane-codex");

      // Registration callbacks observed only the kinds that route through
      // them (reference_document for wf-A, graph_shared_document for wf-B).
      const refByWf = new Map(
        referenceCalls.map((c) => [c.sourceWorkflowId, c]),
      );
      expect(refByWf.get("wf-A")?.relativePath).toBe(
        "memory-bank/collaboration/wf-A/merged-design.md",
      );
      expect(refByWf.get("wf-A")?.sourceLaneId).toBe("lane-claude");
      expect(refByWf.get("wf-A")?.sourceRound).toBe(3);
      // No reference call from validation_log (filesystem-only) or codex_output.
      expect(refByWf.has("wf-C")).toBe(false);
      expect(refByWf.has("wf-D")).toBe(false);

      const sharedByWf = new Map(
        sharedDocCalls.map((c) => [c.sourceWorkflowId, c]),
      );
      expect(sharedByWf.get("wf-B")?.relativePath).toBe(
        ".cc/graph-workflow-docs/graph-B-plan.md",
      );
      expect(sharedByWf.has("wf-A")).toBe(false);

      // Files exist on disk for every kind.
      for (const record of records) {
        const stat = await fs.stat(path.join(workingDir, record.relativePath));
        expect(stat.isFile()).toBe(true);
      }
    });

    it("a parallel workflow that fails its required write does not contaminate sibling workflows' successful records", async () => {
      const registry = createArtifactRegistry({
        writeFile: (absolutePath, contents) =>
          fs.writeFile(absolutePath, contents),
        ensureDir: (absolutePath) =>
          fs.mkdir(absolutePath, { recursive: true }).then(() => undefined),
      });

      // Required write that violates the canonical-path rule for focus_memory.
      const failing = registry.write({
        kind: "focus_memory",
        worktreePath: workingDir,
        relativePath: "memory-bank/wrong-path.md",
        contents: "x",
        audience: "user_facing",
        source: { workflowId: "wf-failing" },
      });

      // Sibling write that is well-formed and should succeed in parallel.
      const succeeding = registry.write({
        kind: "validation_log",
        worktreePath: workingDir,
        relativePath: ".cc/workflow/wf-ok/validation.log",
        contents: "ok",
        audience: "internal_log",
        source: { workflowId: "wf-ok" },
      });

      const settled = await Promise.allSettled([failing, succeeding]);
      expect(settled[0]?.status).toBe("rejected");
      expect(settled[1]?.status).toBe("fulfilled");
      if (settled[1]?.status === "fulfilled") {
        expect(settled[1].value.source.workflowId).toBe("wf-ok");
        expect(settled[1].value.relativePath).toBe(
          ".cc/workflow/wf-ok/validation.log",
        );
      }

      // The failing kind never produced its file.
      await expect(
        fs.stat(path.join(workingDir, "memory-bank/wrong-path.md")),
      ).rejects.toThrow();
      // The successful sibling's file exists.
      const stat = await fs.stat(
        path.join(workingDir, ".cc/workflow/wf-ok/validation.log"),
      );
      expect(stat.isFile()).toBe(true);
    });

    it("an optional write that fails one workflow degrades to skipped_warning while sibling workflows' optional and required writes continue normally", async () => {
      const warnLogs: Record<string, unknown>[] = [];
      const registry = createArtifactRegistry({
        writeFile: (absolutePath, contents) =>
          fs.writeFile(absolutePath, contents),
        ensureDir: (absolutePath) =>
          fs.mkdir(absolutePath, { recursive: true }).then(() => undefined),
        logger: {
          warn: (_event, fields) => warnLogs.push(fields),
        },
      });

      const optionalFailing = registry.writeOptional({
        kind: "focus_memory",
        worktreePath: workingDir,
        relativePath: "memory-bank/not-canonical.md",
        contents: "x",
        audience: "user_facing",
        source: { workflowId: "wf-opt-fail" },
      });

      const optionalOk = registry.writeOptional({
        kind: "validation_log",
        worktreePath: workingDir,
        relativePath: ".cc/workflow/wf-opt-ok/log.txt",
        contents: "log",
        audience: "internal_log",
        source: { workflowId: "wf-opt-ok" },
      });

      const requiredOk = registry.write({
        kind: "validation_log",
        worktreePath: workingDir,
        relativePath: ".cc/workflow/wf-req-ok/log.txt",
        contents: "log",
        audience: "internal_log",
        source: { workflowId: "wf-req-ok" },
      });

      const [optFail, optOk, reqOk] = await Promise.all([
        optionalFailing,
        optionalOk,
        requiredOk,
      ]);
      expect(optFail.status).toBe("skipped_warning");
      if (optFail.status === "skipped_warning") {
        expect(optFail.warning).toMatch(/canonical path/);
      }
      expect(optOk.status).toBe("registered");
      if (optOk.status === "registered") {
        expect(optOk.record.source.workflowId).toBe("wf-opt-ok");
      }
      expect(reqOk.source.workflowId).toBe("wf-req-ok");

      expect(warnLogs.length).toBeGreaterThan(0);
      expect(
        warnLogs.find((f) => f.workflowId === "wf-opt-fail"),
      ).toBeDefined();
    });
  });

  // -----------------------------------------------------------------
  // 4. Worktree safety preservation invariant
  // -----------------------------------------------------------------
  describe("default writeCapability preserves single-flight safety", () => {
    it("a workflow that omits writeCapability is treated as write_capable so it serializes against another write on the same session — preserves the current safety model", async () => {
      const scheduler = createLaneScheduler();
      const trace: string[] = [];

      const firstGate = deferred<void>();
      const first = scheduler.schedule(
        { sessionKey: "acme/session-1", workflowId: "wf-1" },
        async () => {
          trace.push("first:start");
          await firstGate.promise;
          trace.push("first:end");
          return "first";
        },
      );

      const second = scheduler.schedule(
        { sessionKey: "acme/session-1", workflowId: "wf-2" },
        async () => {
          trace.push("second:start");
          return "second";
        },
      );

      await drainMicrotasks();
      expect(trace).toEqual(["first:start"]);

      firstGate.resolve();
      await Promise.all([first, second]);
      expect(trace).toEqual(["first:start", "first:end", "second:start"]);
    });

    it("the safety default holds even after read-only calls have already run on the same session — read-only does not weaken subsequent default-write semantics", async () => {
      const scheduler = createLaneScheduler();
      const trace: string[] = [];

      // Run a read-only call first (this should not change anything about
      // future write-default semantics).
      await scheduler.schedule(
        {
          sessionKey: "acme/session-1",
          workflowId: "wf-read",
          writeCapability: "read_only",
        },
        async () => {
          trace.push("read");
        },
      );

      // Now two unspecified-writeCapability calls — must serialize.
      const writeAGate = deferred<void>();
      const writeA = scheduler.schedule(
        { sessionKey: "acme/session-1", workflowId: "wf-write-a" },
        async () => {
          trace.push("write-a:start");
          await writeAGate.promise;
          trace.push("write-a:end");
        },
      );

      const writeB = scheduler.schedule(
        { sessionKey: "acme/session-1", workflowId: "wf-write-b" },
        async () => {
          trace.push("write-b:start");
        },
      );

      await drainMicrotasks();
      expect(trace).toEqual(["read", "write-a:start"]);

      writeAGate.resolve();
      await Promise.all([writeA, writeB]);
      expect(trace).toEqual([
        "read",
        "write-a:start",
        "write-a:end",
        "write-b:start",
      ]);
    });
  });
});
