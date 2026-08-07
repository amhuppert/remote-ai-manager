import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";

/**
 * Pins the process-wide identity of the default state store.
 *
 * Next.js dev/HMR re-evaluates server modules, producing fresh module
 * generations. If each generation builds its own store, the per-instance
 * parsed-row caches lose coherence: a write through one generation's repos
 * never invalidates another generation's cached `findAll`, so list reads keep
 * returning a stale snapshot (observed live as the project-conversations list
 * API returning `[]` while the rows exist in SQLite). The default store must
 * therefore live on `globalThis`, like the underlying DB connection already
 * does.
 */

function makeProjectConversation(id: string): ConversationState {
  return makeConversationState({
    id,
    scope: "project",
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: "2025-01-01T00:00:00.000Z",
    lastActivityAt: "2025-01-01T00:00:00.000Z",
    open: true,
  });
}

async function resetGlobals(): Promise<void> {
  vi.resetModules();
  const stateDb = await import("./state-db");
  stateDb._resetForTesting();
  const { deleteGlobalValue } = await import("@/lib/shared/global-singleton");
  deleteGlobalValue("__cc_state_store");
  vi.resetModules();
}

describe("state-store default store (HMR-safe singleton)", () => {
  let configDir: string;
  let prevConfigDir: string | undefined;

  beforeEach(async () => {
    configDir = mkdtempSync(path.join(tmpdir(), "cc-store-singleton-"));
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

  it("a write through a later module generation is visible to an earlier generation's cached reads", async () => {
    const projectPath = "/singleton-test-project";

    const gen1 = await import("./index");
    // Prime generation 1's parsed-row cache with the empty list.
    expect(await gen1.getProjectConversations(projectPath)).toEqual([]);

    // Simulate an HMR reload: a fresh module generation over the same process.
    vi.resetModules();
    const gen2 = await import("./index");
    await gen2.createProjectConversationRecord(
      projectPath,
      makeProjectConversation("conv-singleton-1"),
    );

    const seenByGen1 = await gen1.getProjectConversations(projectPath);
    expect(seenByGen1.map((c) => c.id)).toEqual(["conv-singleton-1"]);
  });
});
