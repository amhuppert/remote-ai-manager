import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgentProfileLibraryService } from "@/lib/agent-profiles/library-service";
import { createAgentProfileStorage } from "@/lib/agent-profiles/storage";
import { resolveConversationProfileSnapshot } from "@/lib/conversations/profile-resolution";
import { agentLaunchRequestSchema } from "./launch";
import { createNewOwnerPreparer, createRunSeatResolver } from "./routes";

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "cc-run-routes-seats-"));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

describe("the run routes' seat resolver", () => {
  it("refuses a launch whose profile the library cannot resolve, before admitting its backend", async () => {
    const resolveSeats = createRunSeatResolver(
      createAgentProfileLibraryService({
        storage: createAgentProfileStorage({
          resolveConfigDir: () => configDir,
        }),
      }),
    );

    const resolved = await resolveSeats({
      projectPath: "/repo/app",
      request: agentLaunchRequestSchema.parse({
        brief: "Build it",
        profile: { tier: "project", id: "deleted-writer" },
      }),
    });

    expect(resolved).toMatchObject({
      ok: false,
      status: 400,
      code: "agent_profile_not_resolvable",
      error: expect.stringContaining("project:deleted-writer"),
    });
  });
});

describe("a new owner a person's launch creates", () => {
  it("takes the configured default backend, not the built-in one, and the default profile", async () => {
    const library = createAgentProfileLibraryService({
      storage: createAgentProfileStorage({ resolveConfigDir: () => configDir }),
    });
    const prepare = createNewOwnerPreparer({
      readConfig: async () => ({ defaultAgentBackend: "codex" }),
      resolveProfileSnapshot: (projectPath) =>
        resolveConversationProfileSnapshot(projectPath, null, {
          resolveProfile: (p, ref) => library.resolve(p, ref),
        }),
    });

    const prepared = await prepare("/repo/app");

    expect(prepared).toMatchObject({
      ok: true,
      owner: {
        agentBackend: "codex",
        profileSnapshot: { tier: "builtin", id: "standard-agent" },
      },
    });
  });
});
