import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkProfileResolves,
  createAgentProfileLibraryService,
} from "@/lib/agent-profiles/library-service";
import { createAgentProfileStorage } from "@/lib/agent-profiles/storage";
import { createRunTemplateService, type RunTemplateService } from "./service";
import { createRunTemplateStorage } from "./storage";

const PROJECT = "/repo/app";
const OTHER_PROJECT = "/repo/other";

let configDir: string;
let service: RunTemplateService;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "cc-run-template-service-"));
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
  await library.create({
    projectPath: PROJECT,
    tier: "global",
    id: "strict-reviewer",
    name: "Strict reviewer",
    description: "Reviews strictly",
    instructions: "Review strictly.",
  });
  service = createRunTemplateService({
    storage: createRunTemplateStorage({ resolveConfigDir: () => configDir }),
    profiles: {
      check: (projectPath, ref) =>
        checkProfileResolves(library, projectPath, ref),
    },
  });
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

function content(overrides: Record<string, unknown> = {}) {
  return {
    name: "Fix a ticket",
    description: "Fixes one ticket",
    parameters: [{ name: "ticket", description: "Ticket", required: true }],
    defaults: {},
    workflow: { contexts: [{ key: "fix", brief: "Fix {{inputs.ticket}}" }] },
    ...overrides,
  };
}

const save = (
  tier: "project" | "global",
  expectedRevision: number | null,
  raw: unknown,
  id = "fix-ticket",
) =>
  service.save({
    projectPath: PROJECT,
    tier,
    id,
    expectedRevision,
    content: raw,
  });

describe("run template service", () => {
  it("creates a template, refuses to create it again, and replaces it only at its revision", async () => {
    const created = await save("project", null, content());
    const again = await save("project", null, content());
    const replaced = await save("project", 1, content({ name: "Fix it fast" }));
    const stale = await save("project", 1, content({ name: "Too late" }));

    expect(created).toMatchObject({
      ok: true,
      action: "created",
      record: { id: "fix-ticket", revision: 1 },
    });
    expect(again).toMatchObject({
      ok: false,
      refusal: { code: "run_template_exists" },
    });
    expect(replaced).toMatchObject({
      ok: true,
      action: "updated",
      record: { name: "Fix it fast", revision: 2 },
    });
    expect(stale).toMatchObject({
      ok: false,
      refusal: { code: "run_template_revision_conflict", currentRevision: 2 },
    });
    expect(await service.get(PROJECT, "project", "fix-ticket")).toMatchObject({
      kind: "found",
      record: { name: "Fix it fast" },
    });
  });

  it("refuses a template that would not launch, with every located issue, and writes nothing", async () => {
    const saved = await save(
      "project",
      null,
      content({
        workflow: {
          contexts: [
            { key: "fix", brief: "Fix {{inputs.tickt}}" },
            { key: "docs", brief: "{{inputs.other}}" },
          ],
        },
      }),
    );

    expect(saved).toMatchObject({
      ok: false,
      refusal: {
        code: "run_template_invalid",
        issues: [
          { path: "workflow.contexts.0.brief" },
          { path: "workflow.contexts.1.brief" },
        ],
      },
    });
    expect(await service.get(PROJECT, "project", "fix-ticket")).toEqual({
      kind: "absent",
    });
  });

  it("accepts profiles that resolve where the template lives", async () => {
    const saved = await save(
      "project",
      null,
      content({
        defaults: {
          implementer: { profile: { tier: "project", id: "api-writer" } },
          reviewers: [
            {
              authority: "blocking",
              profile: { tier: "global", id: "strict-reviewer" },
            },
          ],
        },
      }),
    );

    expect(saved.ok).toBe(true);
  });

  it("refuses a profile that does not resolve, at the setting that names it", async () => {
    const saved = await save(
      "project",
      null,
      content({
        workflow: {
          contexts: [
            {
              key: "fix",
              brief: "Fix {{inputs.ticket}}",
              settings: {
                implementer: {
                  profile: { tier: "project", id: "deleted-writer" },
                },
              },
            },
          ],
        },
      }),
    );

    expect(saved).toMatchObject({
      ok: false,
      refusal: {
        code: "run_template_invalid",
        issues: [
          {
            path: "workflow.contexts.0.settings.implementer.profile",
            message: expect.stringContaining("project:deleted-writer"),
          },
        ],
      },
    });
  });

  it("refuses a project profile in a global template, which every project uses", async () => {
    const saved = await save(
      "global",
      null,
      content({
        defaults: {
          implementer: { profile: { tier: "project", id: "api-writer" } },
          reviewers: [
            {
              authority: "blocking",
              profile: { tier: "global", id: "strict-reviewer" },
            },
          ],
        },
      }),
    );

    expect(saved).toMatchObject({
      ok: false,
      refusal: {
        code: "run_template_invalid",
        issues: [
          {
            path: "defaults.implementer.profile",
            message: expect.stringContaining("global template"),
          },
        ],
      },
    });
  });

  it("lists the project's templates and the global ones, each with its tier, and the files it could not read", async () => {
    await save("project", null, content(), "fix-ticket");
    await save("global", null, content({ name: "Shared fix" }), "shared-fix");
    await service.save({
      projectPath: OTHER_PROJECT,
      tier: "project",
      id: "elsewhere",
      expectedRevision: null,
      content: content(),
    });
    const globalDir = path.join(configDir, "run-templates", "global.shared");
    await mkdir(globalDir, { recursive: true });
    await writeFile(path.join(globalDir, "broken.json"), "{");

    const library = await service.list(PROJECT);

    expect(library.items).toEqual([
      {
        tier: "project",
        id: "fix-ticket",
        name: "Fix a ticket",
        description: "Fixes one ticket",
        contexts: 1,
        parameters: [{ name: "ticket", description: "Ticket", required: true }],
        revision: 1,
        updatedAt: expect.any(String),
      },
      expect.objectContaining({
        tier: "global",
        id: "shared-fix",
        name: "Shared fix",
      }),
    ]);
    expect(library.diagnostics).toEqual([
      {
        tier: "global",
        id: "broken",
        path: path.join(globalDir, "broken.json"),
        reason: expect.stringContaining("invalid JSON"),
      },
    ]);
  });

  it("deletes a template only at its current revision", async () => {
    await save("project", null, content());

    const stale = await service.delete({
      projectPath: PROJECT,
      tier: "project",
      id: "fix-ticket",
      expectedRevision: 2,
    });
    const deleted = await service.delete({
      projectPath: PROJECT,
      tier: "project",
      id: "fix-ticket",
      expectedRevision: 1,
    });

    expect(stale).toMatchObject({
      ok: false,
      refusal: { code: "run_template_revision_conflict" },
    });
    expect(deleted).toMatchObject({ ok: true, record: { revision: 1 } });
    expect(await service.get(PROJECT, "project", "fix-ticket")).toEqual({
      kind: "absent",
    });
  });
});
