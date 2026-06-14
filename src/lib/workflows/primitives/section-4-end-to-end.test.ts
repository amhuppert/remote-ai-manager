/**
 * End-to-end verification for section 4 (shared status + artifact handling).
 *
 * These tests compose the actual primitive surface — `publishSessionStatus`
 * via `default-session-status-bus`, plus `createDefaultSessionArtifactRegistry`
 * — to prove that:
 *
 *  - Migrated publishers still deliver the on-the-wire SSE payload shapes
 *    that current consumers expect (conversation-status, graph-workflow-*,
 *    job-status, debug-*).
 *  - Feature-owned status payloads survive intact (no global payload schema).
 *  - Status delivery failures stay isolated (the wire throwing does not
 *    corrupt the calling workflow).
 *  - Path traversal is rejected at the artifact registry boundary even when
 *    the caller passes seemingly valid worktree-relative input.
 *  - Required artifact failures throw `ArtifactRequiredFailure` with the
 *    correct stage so owning workflows can halt deliberately.
 *  - Optional artifact failures degrade to a `skipped_warning` outcome and
 *    leave the workflow free to continue.
 *  - Registered focus_memory artifacts remain discoverable through the
 *    project-state reference-document store after a shared write.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import {
  publishSessionStatus,
  setDefaultSessionStatusBusBroadcastForTesting,
  _resetDefaultSessionStatusBusForTesting,
} from "./default-session-status-bus";
import { createDefaultSessionArtifactRegistry } from "./default-session-artifact-registry";
import { ArtifactRequiredFailure } from "./artifact-registry";
import type { SSEEvent } from "@/lib/api/sse-events";
interface DocStoreEntry {
  projectPath: string;
  sessionName: string;
  filePath: string;
  description: string;
}

function makeFakeReferenceDocStore() {
  const docs: DocStoreEntry[] = [];
  return {
    docs,
    register: async (input: DocStoreEntry) => {
      const existing = docs.find(
        (d) =>
          d.projectPath === input.projectPath &&
          d.sessionName === input.sessionName &&
          d.filePath === input.filePath,
      );
      if (existing) {
        existing.description = input.description;
        return;
      }
      docs.push({ ...input });
    },
    list: (projectPath: string, sessionName: string) =>
      docs.filter(
        (d) => d.projectPath === projectPath && d.sessionName === sessionName,
      ),
  };
}

describe("section 4 — shared status + artifact handling (end to end)", () => {
  let workingDir: string;

  beforeEach(async () => {
    _resetDefaultSessionStatusBusForTesting();
    workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "section4-e2e-"));
  });

  afterEach(async () => {
    _resetDefaultSessionStatusBusForTesting();
    await fs.rm(workingDir, { recursive: true, force: true });
  });

  it("preserves the on-the-wire payload shape for every migrated publisher (conversation, graph workflow, job, debug)", () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setDefaultSessionStatusBusBroadcastForTesting(wire);

    const events: SSEEvent[] = [
      {
        type: "conversation-status",
        scope: "session",
        projectName: "p",
        sessionName: "s",
        conversationId: "conv-1",
        status: "running",
      },
      {
        type: "ask-question",
        scope: "session",
        projectName: "p",
        sessionName: "s",
        conversationId: "conv-1",
        questionId: "q-1",
        questions: [
          {
            question: "ok?",
            multiSelect: false,
            options: [],
            required: true,
            allowNote: true,
          },
        ],
      },
      {
        type: "debug-mode-status",
        projectName: "p",
        sessionName: "s",
        conversationId: "conv-1",
        active: true,
        recording: false,
      },
      {
        type: "graph-workflow-status",
        projectName: "p",
        sessionName: "s",
        executionId: "exec-1",
        workflowStatus: "running",
        activeContextIds: [],
        activeBatchIds: [],
        activeJoinIds: [],
        haltReason: null,
        pendingHaltReason: null,
        secondaryHaltReasons: [],
      },
      {
        type: "graph-workflow-task-status",
        projectName: "p",
        sessionName: "s",
        executionId: "exec-1",
        taskId: "t-1",
        contextId: "c-1",
        status: "running",
        source: "user",
        order: 1,
      },
      {
        type: "job-status",
        jobType: "merge",
        status: "running",
        projectName: "p",
        sessionName: "s",
        jobId: "job-1",
        branchName: "csm/x",
      },
    ];

    for (const e of events) {
      const outcome = publishSessionStatus(e);
      expect(outcome.delivered).toBe(true);
    }

    expect(wire.mock.calls.map((c) => c[0])).toEqual(events);
  });

  it("conversation-status payloads survive the shared bus unchanged across the conversation lifecycle the UI consumes (Task 6.1 parity)", () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setDefaultSessionStatusBusBroadcastForTesting(wire);

    const baseFields = {
      scope: "session",
      projectName: "p",
      sessionName: "s",
      conversationId: "conv-1",
    } as const;

    // The session UI's running / paused / completed / failed presentation maps
    // onto these four conversation-status payload variants — running, the two
    // pause variants (post-turn awaiting and mid-turn waiting_for_input), and
    // an error-bearing payload for failed turns. All four must survive the
    // shared bus unchanged so the UI sees the same wire shape as before.
    const transitions: SSEEvent[] = [
      { type: "conversation-status", ...baseFields, status: "running" },
      { type: "conversation-status", ...baseFields, status: "awaiting" },
      {
        type: "conversation-status",
        ...baseFields,
        status: "waiting_for_input",
      },
      {
        type: "conversation-status",
        ...baseFields,
        status: "awaiting",
        error: "boom",
      },
    ];

    for (const event of transitions) {
      const outcome = publishSessionStatus(event);
      expect(outcome.delivered).toBe(true);
    }

    expect(wire.mock.calls.map((c) => c[0])).toEqual(transitions);
  });

  it("isolates status-delivery failures so the calling workflow is unaffected", () => {
    const wire = vi.fn<(event: SSEEvent) => void>(() => {
      throw new Error("transport down");
    });
    setDefaultSessionStatusBusBroadcastForTesting(wire);

    const event: SSEEvent = {
      type: "graph-workflow-status",
      projectName: "p",
      sessionName: "s",
      executionId: "exec-1",
      workflowStatus: "running",
      activeContextIds: [],
      activeBatchIds: [],
      activeJoinIds: [],
      haltReason: null,
      pendingHaltReason: null,
      secondaryHaltReasons: [],
    };
    const outcome = publishSessionStatus(event);
    expect(outcome.delivered).toBe(false);
    expect(outcome.error).toBeInstanceOf(Error);
  });

  it("rejects path traversal at the artifact registry boundary even when the caller says required:false", async () => {
    const docStore = makeFakeReferenceDocStore();
    const registry = createDefaultSessionArtifactRegistry({
      projectPath: "/proj/p",
      sessionName: "s",
      registerReferenceDocument: docStore.register,
    });

    const optionalOutcome = await registry.writeOptional({
      kind: "validation_log",
      worktreePath: workingDir,
      relativePath: "../escape.log",
      contents: "x",
      audience: "internal_log",
      source: {},
    });
    expect(optionalOutcome.status).toBe("skipped_warning");

    await expect(
      registry.write({
        kind: "validation_log",
        worktreePath: workingDir,
        relativePath: "../escape.log",
        contents: "x",
        audience: "internal_log",
        required: true,
        source: {},
      }),
    ).rejects.toBeInstanceOf(ArtifactRequiredFailure);
  });

  it("required artifact failures expose the failure stage so owning workflows can halt deliberately", async () => {
    const failingRegistrar = async () => {
      throw new Error("state lock contention");
    };
    const registry = createDefaultSessionArtifactRegistry({
      projectPath: "/proj/p",
      sessionName: "s",
      registerReferenceDocument: failingRegistrar,
    });

    let captured: ArtifactRequiredFailure | undefined;
    try {
      await registry.write({
        kind: "focus_memory",
        worktreePath: workingDir,
        relativePath: "memory-bank/focus.md",
        contents: "x",
        audience: "user_facing",
        required: true,
        source: { workflowId: "wf-1" },
        description: "f",
      });
    } catch (err) {
      captured = err as ArtifactRequiredFailure;
    }

    expect(captured).toBeInstanceOf(ArtifactRequiredFailure);
    expect(captured!.stage).toBe("registration");
    expect(captured!.kind).toBe("focus_memory");
    expect(captured!.relativePath).toBe("memory-bank/focus.md");
  });

  it("optional artifact failures degrade to skipped_warning so workflows can continue", async () => {
    const failingRegistrar = async () => {
      throw new Error("state lock contention");
    };
    const registry = createDefaultSessionArtifactRegistry({
      projectPath: "/proj/p",
      sessionName: "s",
      registerReferenceDocument: failingRegistrar,
    });

    const outcome = await registry.writeOptional({
      kind: "focus_memory",
      worktreePath: workingDir,
      relativePath: "memory-bank/focus.md",
      contents: "x",
      audience: "user_facing",
      source: {},
      description: "f",
    });

    expect(outcome.status).toBe("skipped_warning");
    if (outcome.status === "skipped_warning") {
      expect(outcome.warning.length).toBeGreaterThan(0);
    }
  });

  it("registered focus_memory artifacts remain discoverable through the reference-document store after a shared write", async () => {
    const docStore = makeFakeReferenceDocStore();
    const registry = createDefaultSessionArtifactRegistry({
      projectPath: "/proj/p",
      sessionName: "s",
      registerReferenceDocument: docStore.register,
    });

    await registry.write({
      kind: "focus_memory",
      worktreePath: workingDir,
      relativePath: "memory-bank/focus.md",
      contents: "# Focus\nE2E\n",
      audience: "user_facing",
      required: true,
      source: { workflowId: "wf-1" },
      description: "Current focus",
    });

    const written = await fs.readFile(
      path.join(workingDir, "memory-bank/focus.md"),
      "utf-8",
    );
    expect(written).toBe("# Focus\nE2E\n");

    const docs = docStore.list("/proj/p", "s");
    expect(docs).toEqual([
      {
        projectPath: "/proj/p",
        sessionName: "s",
        filePath: "memory-bank/focus.md",
        description: "Current focus",
      },
    ]);
  });

  it("repeated focus_memory writes update the existing reference-document description rather than duplicating", async () => {
    const docStore = makeFakeReferenceDocStore();
    const registry = createDefaultSessionArtifactRegistry({
      projectPath: "/proj/p",
      sessionName: "s",
      registerReferenceDocument: docStore.register,
    });

    await registry.write({
      kind: "focus_memory",
      worktreePath: workingDir,
      relativePath: "memory-bank/focus.md",
      contents: "v1",
      audience: "user_facing",
      required: true,
      source: { workflowId: "wf-1" },
      description: "first",
    });

    await registry.write({
      kind: "focus_memory",
      worktreePath: workingDir,
      relativePath: "memory-bank/focus.md",
      contents: "v2",
      audience: "user_facing",
      required: true,
      source: { workflowId: "wf-1" },
      description: "second",
    });

    const docs = docStore.list("/proj/p", "s");
    expect(docs).toHaveLength(1);
    expect(docs[0]).toEqual({
      projectPath: "/proj/p",
      sessionName: "s",
      filePath: "memory-bank/focus.md",
      description: "second",
    });
  });
});
