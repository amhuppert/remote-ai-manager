import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SSEEvent } from "@/lib/api/sse-events";
import { RUN_SETTING_DEFAULTS } from "@/lib/runs/settings";
import { createRunTemplateRouteHandlers } from "./route-handlers";
import { createRunTemplateService } from "./service";
import { createRunTemplateStorage } from "./storage";

const PROJECT_PATH = "/repo/app";

let configDir: string;
let published: SSEEvent[];
let handlers: ReturnType<typeof createRunTemplateRouteHandlers>;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "cc-run-template-routes-"));
  published = [];
  handlers = createRunTemplateRouteHandlers({
    resolveProjectPath: async (name) => (name === "app" ? PROJECT_PATH : null),
    templates: createRunTemplateService({
      storage: createRunTemplateStorage({ resolveConfigDir: () => configDir }),
      profiles: { check: async () => ({ ok: true }) },
    }),
    publish: (event) => {
      published.push(event);
      return { delivered: true };
    },
    log: { info: () => {}, warn: () => {} },
  });
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

const template = (name = "Fix a ticket") => ({
  name,
  description: "Fixes one ticket",
  parameters: [],
  defaults: {},
  workflow: { contexts: [{ key: "fix", brief: "Fix it" }] },
});

function context(params: Record<string, string>) {
  return { params: Promise.resolve({ name: "app", ...params }) };
}

function put(tier: string, id: string, body: unknown): Promise<Response> {
  return handlers.save(
    new Request("http://cc.test/x", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
    context({ tier, id }),
  );
}

function del(tier: string, id: string, body: unknown): Promise<Response> {
  return handlers.remove(
    new Request("http://cc.test/x", {
      method: "DELETE",
      body: JSON.stringify(body),
    }),
    context({ tier, id }),
  );
}

function get(tier: string, id: string): Promise<Response> {
  return handlers.get(new Request("http://cc.test/x"), context({ tier, id }));
}

describe("run template routes", () => {
  it("creates a project template, answers the stored record and announces it for that project", async () => {
    const response = await put("project", "fix-ticket", {
      expectedRevision: null,
      template: template(),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      template: { id: "fix-ticket", revision: 1, name: "Fix a ticket" },
    });
    expect(published).toEqual([
      {
        type: "run-template-changed",
        scope: "project",
        projectPath: PROJECT_PATH,
        id: "fix-ticket",
        revision: 1,
        action: "created",
      },
    ]);
  });

  it("announces a global template to every project, without a project", async () => {
    await put("global", "shared", {
      expectedRevision: null,
      template: template(),
    });
    const replaced = await put("global", "shared", {
      expectedRevision: 1,
      template: template("Shared fix"),
    });

    expect(replaced.status).toBe(200);
    expect(published).toEqual([
      expect.objectContaining({
        scope: "global",
        action: "created",
        revision: 1,
      }),
      {
        type: "run-template-changed",
        scope: "global",
        id: "shared",
        revision: 2,
        action: "updated",
      },
    ]);
  });

  it("reads a template with the global tier its settings fall back to", async () => {
    await put("project", "fix-ticket", {
      expectedRevision: null,
      template: template(),
    });

    const response = await get("project", "fix-ticket");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      template: expect.objectContaining({ id: "fix-ticket", revision: 1 }),
      globals: RUN_SETTING_DEFAULTS,
    });
    expect((await get("global", "fix-ticket")).status).toBe(404);
  });

  it("names the file when a template addressed by tier and id cannot be read", async () => {
    const dir = path.join(
      configDir,
      "run-templates",
      Buffer.from(PROJECT_PATH).toString("base64url"),
    );
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "broken.json"), "{ not json");

    const response = await get("project", "broken");

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("run_template_not_found");
    expect(body.error).toContain("invalid JSON");
    expect(body.error).toContain(path.join(dir, "broken.json"));
  });

  it("lists the project's and the global templates", async () => {
    await put("project", "fix-ticket", {
      expectedRevision: null,
      template: template(),
    });
    await put("global", "shared", {
      expectedRevision: null,
      template: template(),
    });

    const response = await handlers.list(
      new Request("http://cc.test/x"),
      context({}),
    );

    expect(response.status).toBe(200);
    expect(
      (await response.json()).items.map(
        (item: { tier: string; id: string }) => `${item.tier}:${item.id}`,
      ),
    ).toEqual(["project:fix-ticket", "global:shared"]);
  });

  it("refuses a create over an existing id, and a replacement of a stale revision, announcing neither", async () => {
    await put("project", "fix-ticket", {
      expectedRevision: null,
      template: template(),
    });
    published = [];

    const again = await put("project", "fix-ticket", {
      expectedRevision: null,
      template: template(),
    });
    const stale = await put("project", "fix-ticket", {
      expectedRevision: 3,
      template: template(),
    });

    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "run_template_exists" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: "run_template_revision_conflict",
      details: { currentRevision: 1 },
    });
    expect(published).toEqual([]);
  });

  it("refuses an invalid template with its located issues, announcing nothing", async () => {
    const response = await put("project", "fix-ticket", {
      expectedRevision: null,
      template: {
        ...template(),
        workflow: { contexts: [{ key: "fix", brief: "{{x}}" }] },
      },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "run_template_invalid",
      issues: [{ path: "workflow.contexts.0.brief" }],
    });
    expect(published).toEqual([]);
  });

  it("deletes at the current revision and announces the revision it removed", async () => {
    await put("project", "fix-ticket", {
      expectedRevision: null,
      template: template(),
    });
    published = [];

    const stale = await del("project", "fix-ticket", { expectedRevision: 2 });
    const deleted = await del("project", "fix-ticket", { expectedRevision: 1 });

    expect(stale.status).toBe(409);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({
      ok: true,
      tier: "project",
      id: "fix-ticket",
      revision: 1,
    });
    expect(published).toEqual([
      expect.objectContaining({
        action: "deleted",
        revision: 1,
        id: "fix-ticket",
      }),
    ]);
    expect((await get("project", "fix-ticket")).status).toBe(404);
  });

  it("refuses an unknown project, tier or malformed id before reading anything", async () => {
    const unknownProject = await handlers.list(
      new Request("http://cc.test/x"),
      { params: Promise.resolve({ name: "missing" }) },
    );

    expect(unknownProject.status).toBe(404);
    expect((await get("builtin", "fix-ticket")).status).toBe(404);
    expect((await get("project", "..")).status).toBe(400);
  });
});
