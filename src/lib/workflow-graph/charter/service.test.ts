import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import {
  computeCharterHash,
  renderCharterMarkdown,
} from "@/lib/workflow-graph/charter/render";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { createWorkflowCharterService } from "./service";

interface CapturedWrite {
  absolutePath: string;
  contents: string;
}

function setup(
  overrides: {
    writeFile?: (absolutePath: string, contents: string) => Promise<void>;
  } = {},
) {
  const writes: CapturedWrite[] = [];
  const ensuredDirs: string[] = [];

  const writeFile =
    overrides.writeFile ??
    (async (absolutePath: string, contents: string | Uint8Array) => {
      writes.push({ absolutePath, contents: String(contents) });
    });

  const publishCharterRegistered = vi.fn(
    (input: {
      execution: GraphWorkflowExecution;
      definitionId: string;
      definitionRevision: number;
      charterHash: string;
    }): GraphWorkflowExecutionEvent[] => [
      {
        occurredAt: "2026-04-01T00:00:00.000Z",
        preReset: false,
        event: {
          type: "graph-workflow-charter-registered",
          projectName: "p",
          sessionName: "s",
          executionId: input.execution.id,
          definitionId: input.definitionId,
          definitionRevision: input.definitionRevision,
          charterHash: input.charterHash,
        },
      },
    ],
  );

  const service = createWorkflowCharterService({
    writeFile: writeFile as (
      absolutePath: string,
      contents: string | Uint8Array,
    ) => Promise<void>,
    ensureDir: async (absolutePath: string) => {
      ensuredDirs.push(absolutePath);
    },
    publishCharterRegistered,
  });

  return { service, writes, ensuredDirs, publishCharterRegistered };
}

describe("createWorkflowCharterService.seedCharter", () => {
  it("writes the rendered charter markdown to a worktree-confined charter.md", async () => {
    const { service, writes } = setup();
    const charter = makeTestCharter();
    const execution = createWorkflowExecution();
    const worktreePath = "/repo/.worktrees/session-1";

    await service.seedCharter({
      charter,
      worktreePath,
      execution,
      projectPath: "/repo",
      sessionName: "session-1",
    });

    expect(writes).toHaveLength(1);
    const write = writes[0]!;
    const expectedPath = path.join(
      worktreePath,
      ".cc",
      "graph-workflow-docs",
      "charter.md",
    );
    expect(write.absolutePath).toBe(expectedPath);
    expect(write.contents).toBe(renderCharterMarkdown(charter));
  });

  it("registers a kind:'charter' shared-document entry on the cloned execution", async () => {
    const { service } = setup();
    const charter = makeTestCharter();
    const execution = createWorkflowExecution();

    const { nextExecution } = await service.seedCharter({
      charter,
      worktreePath: "/repo/wt",
      execution,
      projectPath: "/repo",
      sessionName: "session-1",
    });

    const charterEntries = nextExecution.sharedDocuments.filter(
      (entry) => entry.kind === "charter",
    );
    expect(charterEntries).toHaveLength(1);
    expect(charterEntries[0]!.relativePath).toBe(
      ".cc/graph-workflow-docs/charter.md",
    );
    expect(charterEntries[0]!.description.length).toBeGreaterThan(0);
    expect(charterEntries[0]!.readWhen.length).toBeGreaterThan(0);
  });

  it("sets the execution charter snapshot and returns the matching hash", async () => {
    const { service } = setup();
    const charter = makeTestCharter();
    const execution = createWorkflowExecution();

    const { nextExecution, charterHash } = await service.seedCharter({
      charter,
      worktreePath: "/repo/wt",
      execution,
      projectPath: "/repo",
      sessionName: "session-1",
    });

    expect(nextExecution.charter).toEqual(charter);
    expect(charterHash).toBe(computeCharterHash(charter));
  });

  it("does not mutate the input execution", async () => {
    const { service } = setup();
    const charter = makeTestCharter();
    const execution = createWorkflowExecution();
    const originalSharedDocs = execution.sharedDocuments.length;

    await service.seedCharter({
      charter,
      worktreePath: "/repo/wt",
      execution,
      projectPath: "/repo",
      sessionName: "session-1",
    });

    expect(execution.sharedDocuments).toHaveLength(originalSharedDocs);
  });

  it("invokes publishCharterRegistered with the charter hash and definition revision", async () => {
    const { service, publishCharterRegistered } = setup();
    const charter = makeTestCharter();
    const execution = createWorkflowExecution({
      seedDefinitionId: "wf-7",
      seedDefinitionRevision: 3,
    });

    await service.seedCharter({
      charter,
      worktreePath: "/repo/wt",
      execution,
      projectPath: "/repo",
      sessionName: "session-1",
    });

    expect(publishCharterRegistered).toHaveBeenCalledTimes(1);
    expect(publishCharterRegistered).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/repo",
        sessionName: "session-1",
        definitionId: "wf-7",
        definitionRevision: 3,
        charterHash: computeCharterHash(charter),
      }),
    );
  });

  it("returns the charter-registered events produced by publishCharterRegistered", async () => {
    const writes: CapturedWrite[] = [];
    const taggedEvents: GraphWorkflowExecutionEvent[] = [
      {
        occurredAt: "2026-04-01T00:00:00.000Z",
        preReset: false,
        event: {
          type: "graph-workflow-charter-registered",
          projectName: "p",
          sessionName: "s",
          executionId: "exec-tagged",
          definitionId: "wf",
          definitionRevision: 1,
          charterHash: "sha256:tagged",
        },
      },
    ];
    const service = createWorkflowCharterService({
      writeFile: async (
        absolutePath: string,
        contents: string | Uint8Array,
      ) => {
        writes.push({ absolutePath, contents: String(contents) });
      },
      ensureDir: async () => {},
      publishCharterRegistered: () => taggedEvents,
    });

    const { events } = await service.seedCharter({
      charter: makeTestCharter(),
      worktreePath: "/repo/wt",
      execution: createWorkflowExecution(),
      projectPath: "/repo",
      sessionName: "session-1",
    });

    expect(events).toEqual(taggedEvents);
  });

  it("never writes any path other than charter.md, even for an external-readonly source", async () => {
    const { service, writes } = setup();
    const charter = makeTestCharter({
      sourcesOfTruth: [
        {
          rank: 1,
          id: "external-policy",
          label: "Company engineering policy",
          type: "document",
          locator: "/Users/alex/external/policy.md",
          description: "Lives outside the worktree; read-only reference",
          accessPolicy: "external-readonly",
        },
        {
          rank: 2,
          id: "acceptance-criteria",
          label: "Per-context acceptance criteria",
          type: "spec",
          locator: "context.acceptanceCriteria",
          description: "Context-level criteria",
          accessPolicy: "worktree-relative",
        },
      ],
    });
    const execution = createWorkflowExecution();

    await service.seedCharter({
      charter,
      worktreePath: "/repo/wt",
      execution,
      projectPath: "/repo",
      sessionName: "session-1",
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]!.absolutePath).toBe(
      path.join("/repo/wt", ".cc", "graph-workflow-docs", "charter.md"),
    );
    // No source locator was ever written or read.
    expect(
      writes.some((write) =>
        write.absolutePath.includes("/Users/alex/external/policy.md"),
      ),
    ).toBe(false);
  });

  it("propagates a write failure so seed halts before the first iteration", async () => {
    const { service } = setup({
      writeFile: async () => {
        throw new Error("disk full");
      },
    });

    await expect(
      service.seedCharter({
        charter: makeTestCharter(),
        worktreePath: "/repo/wt",
        execution: createWorkflowExecution(),
        projectPath: "/repo",
        sessionName: "session-1",
      }),
    ).rejects.toThrow(/disk full/);
  });
});
