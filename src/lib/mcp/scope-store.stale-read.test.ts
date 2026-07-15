import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ManagerState } from "@/lib/projects/schemas";

/**
 * Pins the one-store-instance invariant for `defaultScopeOverrideStore`.
 *
 * The state-store repos hold parsed-row caches invalidated by a per-instance
 * version counter. A module that writes through its own store instance over
 * the same DB bumps only that instance's counters, so the process-wide
 * singleton keeps serving its cached `findAll` snapshot and the write never
 * becomes visible to singleton reads. The default scope store must therefore
 * share the singleton store — this test writes an MCP override through
 * `defaultScopeOverrideStore` and asserts the singleton's `readState` sees it.
 */

const PROJECT_PATH = "/stale-read-repro-project";
const SESSION_NAME = "stale-read-repro-session";

function seedState(): ManagerState {
  return {
    projects: {
      [PROJECT_PATH]: {
        rootPath: PROJECT_PATH,
        sessions: {
          [SESSION_NAME]: {
            sessionName: SESSION_NAME,
            worktreePath: "/tmp/stale-read-wt",
            branchName: "csm/stale-read",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastActivityAt: "2026-01-01T00:00:00.000Z",
            archived: false,
            finished: false,
            conversations: [],
            source: "cc",
            creationMode: "normal",
            tddEnabled: false,
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

async function resetGlobals(): Promise<void> {
  vi.resetModules();
  const stateDb = await import("@/lib/state-store/state-db");
  stateDb._resetForTesting();
  const { deleteGlobalValue } = await import("@/lib/shared/global-singleton");
  deleteGlobalValue("__cc_state_store");
  vi.resetModules();
}

describe("mcp scope-store singleton coherence", () => {
  let configDir: string;
  let prevConfigDir: string | undefined;

  beforeEach(async () => {
    configDir = mkdtempSync(path.join(tmpdir(), "cc-mcp-stale-read-"));
    prevConfigDir = process.env.CC_CONFIG_DIR;
    process.env.CC_CONFIG_DIR = configDir;
    await resetGlobals();
  });

  afterEach(async () => {
    await resetGlobals();
    if (prevConfigDir === undefined) delete process.env.CC_CONFIG_DIR;
    else process.env.CC_CONFIG_DIR = prevConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("a session override patch through the default scope store is visible to singleton cached reads", async () => {
    const store = await import("@/lib/state-store");
    await store.mutateState("stale-read-repro.seed", (state) => {
      state.projects[PROJECT_PATH] = seedState().projects[PROJECT_PATH]!;
    });

    // Prime the singleton's parsed-row caches with the pre-patch snapshot.
    const before = await store.readState();
    expect(
      before.projects[PROJECT_PATH]?.sessions[SESSION_NAME]?.mcpOverrides,
    ).toBeUndefined();

    const { defaultScopeOverrideStore } = await import("./scope-store");
    await defaultScopeOverrideStore.patchSession(PROJECT_PATH, SESSION_NAME, [
      { type: "set-server-enabled", serverKey: "kagi", enabled: false },
    ]);

    const after = await store.readState();
    expect(
      after.projects[PROJECT_PATH]?.sessions[SESSION_NAME]?.mcpOverrides
        ?.servers.kagi?.enabled,
    ).toBe(false);
  });
});
