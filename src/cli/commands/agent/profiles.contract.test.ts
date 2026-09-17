import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgentProfileRouteHandlers } from "@/lib/agent-profiles/route-handlers";
import {
  createAgentProfileLibraryService,
  type AgentProfileLibraryService,
} from "@/lib/agent-profiles/library-service";
import { createAgentProfileStorage } from "@/lib/agent-profiles/storage";
import { STANDARD_AGENT_PROFILE_ID } from "@/lib/agent-profiles/builtins";

import { runCcWithHost } from "../../testing/domain-runtime";
import type { CliEnv, CliHost } from "../../transport";

/**
 * Contract layer per doc 01 §8 for `cctl agent list|get` (R11.1): the real CLI
 * core driving the real agent-profile route handlers in-process over a REAL
 * storage tree in a temp config dir. Nothing here can pass by agreeing with a
 * fake — the tier provenance, the qualified addressing, and the refusals are
 * the production ones.
 *
 * `CC_SESSION` is the neutralized `""` a project conversation receives, so
 * every assertion also proves these two verbs route at project scope (they are
 * the project-supported leaves of an otherwise session-only group).
 */

const PROJECT_NAME = "cc";
const PROJECT_PATH = "/repos/cc";
/** The id deliberately created in BOTH mutable tiers — siblings never shadow. */
const SHARED_ID = "contract-reviewer";

let configDir: string;
let library: AgentProfileLibraryService;

function makeHost(): CliHost & { paths: string[] } {
  const handlers = createAgentProfileRouteHandlers({
    async resolveProjectPath(name) {
      return name === PROJECT_NAME ? PROJECT_PATH : null;
    },
    library,
    publish: () => ({ delivered: true }),
  });
  const paths: string[] = [];

  return {
    paths,
    async fetch(url, init) {
      const parsed = new URL(url);
      paths.push(parsed.pathname);
      // /api/projects/<name>/agent-profiles[/<tier>/<id>]
      const segments = parsed.pathname.split("/").filter(Boolean);
      const name = decodeURIComponent(segments[2] ?? "");
      const request = new Request(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      });
      if (segments.length > 4) {
        return handlers.project.get(request, {
          params: Promise.resolve({
            name,
            tier: decodeURIComponent(segments[4] ?? ""),
            id: decodeURIComponent(segments[5] ?? ""),
          }),
        });
      }
      return handlers.project.list(request, {
        params: Promise.resolve({ name }),
      });
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: os.platform(),
    homedir: os.homedir(),
  };
}

function env(): CliEnv {
  return {
    CC_SERVER_URL: "http://127.0.0.1:4999",
    CC_API_TOKEN: "contract-token",
    CC_PROJECT: PROJECT_NAME,
    CC_CONVERSATION_SCOPE: "project",
    CC_SESSION: "",
  };
}

function envelope(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

beforeEach(async () => {
  configDir = await mkdtemp(path.join(os.tmpdir(), "cctl-agent-profiles-"));
  library = createAgentProfileLibraryService({
    storage: createAgentProfileStorage({ resolveConfigDir: () => configDir }),
  });

  await library.create({
    projectPath: PROJECT_PATH,
    tier: "global",
    id: SHARED_ID,
    name: "Global Contract Reviewer",
    description: "Reviews a change against its stated contract, everywhere.",
    instructions: "GLOBAL TIER INSTRUCTIONS — review the contract.",
    recommendedFor: ["workflow_validator"],
    tags: ["review", "global"],
  });
  await library.create({
    projectPath: PROJECT_PATH,
    tier: "project",
    id: SHARED_ID,
    name: "Project Contract Reviewer",
    description: "Reviews a change against this project's contract.",
    instructions: "PROJECT TIER INSTRUCTIONS — review the contract.",
    recommendedFor: ["workflow_validator", "conversation"],
    tags: ["review"],
  });
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

describe("cctl agent list against the real library routes", () => {
  it("lists every tier with provenance and the selection metadata R11 names", async () => {
    const host = makeHost();
    const result = await runCcWithHost(
      ["agent", "list", "--json"],
      env(),
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(host.paths).toEqual(["/api/projects/cc/agent-profiles"]);

    const body = envelope(result.stdout);
    const profiles = (body.payload as { data: { profiles: unknown } }).data
      .profiles as Record<string, unknown>[];

    // All three tiers are present as siblings, and the same id in two tiers
    // appears twice — nothing shadows.
    const refs = profiles.map((profile) => profile.ref);
    expect(refs).toContainEqual({
      tier: "builtin",
      id: STANDARD_AGENT_PROFILE_ID,
    });
    expect(refs).toContainEqual({ tier: "global", id: SHARED_ID });
    expect(refs).toContainEqual({ tier: "project", id: SHARED_ID });

    const project = profiles.find(
      (profile) =>
        (profile.ref as { tier: string }).tier === "project" &&
        (profile.ref as { id: string }).id === SHARED_ID,
    );
    expect(project).toEqual({
      ref: { tier: "project", id: SHARED_ID },
      name: "Project Contract Reviewer",
      description: "Reviews a change against this project's contract.",
      revision: 1,
      recommendedFor: ["workflow_validator", "conversation"],
      tags: ["review"],
      readOnly: false,
    });
    expect(
      (body.payload as { data: { diagnostics: unknown } }).data.diagnostics,
    ).toEqual([]);
  });

  it("never carries instruction text, in either output mode (R6.3)", async () => {
    for (const argv of [
      ["agent", "list"],
      ["agent", "list", "--json"],
    ]) {
      const result = await runCcWithHost(argv, env(), makeHost());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("TIER INSTRUCTIONS");
    }
  });

  it("renders the compact tier:id spelling `get` accepts back", async () => {
    const result = await runCcWithHost(["agent", "list"], env(), makeHost());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`project:${SHARED_ID}`);
    expect(result.stdout).toContain(`global:${SHARED_ID}`);
    expect(result.stdout).toContain(`builtin:${STANDARD_AGENT_PROFILE_ID}`);
  });

  it("reports a quarantined record as a diagnostic instead of failing the listing", async () => {
    const scopeDir = path.join(configDir, "agent-profiles", "global.shared");
    await mkdir(scopeDir, { recursive: true });
    await writeFile(path.join(scopeDir, "corrupt.json"), "{ not json");

    const result = await runCcWithHost(
      ["agent", "list", "--json"],
      env(),
      makeHost(),
    );

    expect(result.exitCode).toBe(0);
    const body = envelope(result.stdout);
    const diagnostics = (body.payload as { data: { diagnostics: unknown } })
      .data.diagnostics as Record<string, unknown>[];
    expect(diagnostics.map((d) => d.id)).toContain("corrupt");
    // The healthy siblings still list.
    expect(
      (body.payload as { data: { profiles: unknown[] } }).data.profiles.length,
    ).toBeGreaterThan(2);
  });
});

describe("cctl agent get against the real library routes", () => {
  it("reads the full record — including instructions — by qualified tier:id", async () => {
    const host = makeHost();
    const result = await runCcWithHost(
      ["agent", "get", `global:${SHARED_ID}`, "--json"],
      env(),
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(host.paths).toEqual([
      `/api/projects/cc/agent-profiles/global/${SHARED_ID}`,
    ]);
    const profile = (
      envelope(result.stdout).payload as { data: { profile: unknown } }
    ).data.profile as Record<string, unknown>;
    expect(profile.tier).toBe("global");
    expect(profile.id).toBe(SHARED_ID);
    expect(profile.revision).toBe(1);
    expect(profile.instructions).toBe(
      "GLOBAL TIER INSTRUCTIONS — review the contract.",
    );
  });

  it("addresses siblings independently — the same id in two tiers is two profiles", async () => {
    const globalResult = await runCcWithHost(
      ["agent", "get", `global:${SHARED_ID}`, "--json"],
      env(),
      makeHost(),
    );
    const projectResult = await runCcWithHost(
      ["agent", "get", `project:${SHARED_ID}`, "--json"],
      env(),
      makeHost(),
    );

    const globalProfile = (
      envelope(globalResult.stdout).payload as { data: { profile: unknown } }
    ).data.profile as Record<string, unknown>;
    const projectProfile = (
      envelope(projectResult.stdout).payload as { data: { profile: unknown } }
    ).data.profile as Record<string, unknown>;
    expect(globalProfile.instructions).not.toBe(projectProfile.instructions);
    expect(projectProfile.instructions).toBe(
      "PROJECT TIER INSTRUCTIONS — review the contract.",
    );
    expect(projectProfile.name).toBe("Project Contract Reviewer");
  });

  it("reads a builtin through the same qualified surface", async () => {
    const result = await runCcWithHost(
      ["agent", "get", `builtin:${STANDARD_AGENT_PROFILE_ID}`, "--json"],
      env(),
      makeHost(),
    );

    expect(result.exitCode).toBe(0);
    const profile = (
      envelope(result.stdout).payload as { data: { profile: unknown } }
    ).data.profile as Record<string, unknown>;
    expect(profile.tier).toBe("builtin");
    expect(profile.readOnly).toBe(true);
    expect(typeof profile.instructions).toBe("string");
  });

  it("prints the instructions in text mode (the one surface that carries them)", async () => {
    const result = await runCcWithHost(
      ["agent", "get", `project:${SHARED_ID}`],
      env(),
      makeHost(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PROJECT TIER INSTRUCTIONS");
    expect(result.stdout).toContain(`project:${SHARED_ID}`);
  });

  it("refuses an unqualified id locally, with the located refusal and no request", async () => {
    const host = makeHost();
    const result = await runCcWithHost(
      ["agent", "get", SHARED_ID, "--json"],
      env(),
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(host.paths).toEqual([]);
    const body = envelope(result.stdout);
    expect(body.error).toMatchObject({
      code: "CC_USAGE",
      details: { kind: "unqualified" },
    });
    expect((body.error as { message: string }).message).toContain(
      "unqualified",
    );
    expect((body.error as { details: unknown }).details).toMatchObject({
      kind: "unqualified",
      text: SHARED_ID,
      offset: 0,
      length: SHARED_ID.length,
    });
  });

  it("refuses an unknown tier locally, pointing at the offending span", async () => {
    const host = makeHost();
    const result = await runCcWithHost(
      ["agent", "get", `builtins:${SHARED_ID}`, "--json"],
      env(),
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(host.paths).toEqual([]);
    const body = envelope(result.stdout);
    expect(body.error).toMatchObject({
      code: "CC_USAGE",
      details: { kind: "unknown_tier" },
    });
    expect((body.error as { details: unknown }).details).toMatchObject({
      kind: "unknown_tier",
      text: `builtins:${SHARED_ID}`,
      offset: 0,
      length: "builtins".length,
    });
  });

  it("surfaces the server's typed refusal for a well-formed but unknown reference", async () => {
    const host = makeHost();
    const result = await runCcWithHost(
      ["agent", "get", "global:no-such-profile", "--json"],
      env(),
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(host.paths).toEqual([
      "/api/projects/cc/agent-profiles/global/no-such-profile",
    ]);
    const body = envelope(result.stdout);
    expect(body.error).toMatchObject({
      details: { serverCode: "agent_profile_not_resolvable" },
    });
    expect((body.error as { message: string }).message).toContain(
      "global:no-such-profile",
    );
  });
});
