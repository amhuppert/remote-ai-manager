import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkProfileResolves,
  createAgentProfileLibraryService,
} from "@/lib/agent-profiles/library-service";
import { createAgentProfileStorage } from "@/lib/agent-profiles/storage";
import { agentLaunchRequestSchema } from "./launch";
import { createSeatResolver } from "./seats";

const PROJECT = "/repo/app";
const claude = {
  backend: "claude" as const,
  modelSelection: { modelId: "sonnet", parameters: {} },
};

let configDir: string;
let resolveSeats: ReturnType<typeof createSeatResolver>;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "cc-run-seats-"));
  const library = createAgentProfileLibraryService({
    storage: createAgentProfileStorage({ resolveConfigDir: () => configDir }),
  });
  await library.create({
    projectPath: PROJECT,
    tier: "project",
    id: "api-writer",
    name: "API writer",
    description: "Writes APIs",
    instructions: "Write the API.",
  });
  resolveSeats = createSeatResolver({
    admitSeat: async () => ({ ok: true, seat: claude }),
    checkProfile: (projectPath, ref) =>
      checkProfileResolves(library, projectPath, ref),
  });
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

const resolve = (raw: Record<string, unknown>) =>
  resolveSeats({
    projectPath: PROJECT,
    request: agentLaunchRequestSchema.parse({ brief: "Build it", ...raw }),
  });

describe("launch seat resolution", () => {
  it("resolves every seat whose profile resolves, defaults included", async () => {
    expect(
      await resolve({
        profile: { tier: "project", id: "api-writer" },
        reviewers: [{ authority: "blocking" }],
      }),
    ).toEqual({
      ok: true,
      seats: { implementer: claude, reviewers: [claude] },
    });
  });

  it("refuses an implementer profile that does not resolve, before anything is recorded", async () => {
    const resolved = await resolve({
      profile: { tier: "project", id: "deleted-writer" },
    });

    expect(resolved).toMatchObject({
      ok: false,
      status: 400,
      code: "agent_profile_not_resolvable",
      error: expect.stringMatching(
        /^The implementer's profile: .*project:deleted-writer/,
      ),
    });
  });

  it("refuses a reviewer's profile that does not resolve, naming the reviewer", async () => {
    const resolved = await resolve({
      reviewers: [
        { authority: "blocking" },
        { authority: "advisory", profile: { tier: "global", id: "gone" } },
      ],
    });

    expect(resolved).toMatchObject({
      ok: false,
      status: 400,
      code: "agent_profile_not_resolvable",
      error: expect.stringMatching(/^Reviewer 2's profile: .*global:gone/),
    });
  });
});
