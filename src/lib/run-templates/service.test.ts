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

  describe("preparing a launch", () => {
    const prepare = (
      input: {
        id?: string;
        tier?: "project" | "global";
        revision?: number;
        parameters?: Record<string, string>;
      } = {},
    ) =>
      service.prepareLaunch({
        projectPath: PROJECT,
        tier: input.tier ?? "project",
        id: input.id ?? "fix-ticket",
        ...(input.revision !== undefined ? { revision: input.revision } : {}),
        parameters: input.parameters ?? { ticket: "CC-12" },
      });

    it("makes the workflow request with the values substituted, and an origin naming the template as it stood", async () => {
      await save(
        "project",
        null,
        content({ defaults: { humanApproval: true } }),
      );

      const prepared = await prepare({ revision: 1 });

      expect(prepared).toEqual({
        ok: true,
        request: {
          title: "Fix a ticket",
          contexts: [{ key: "fix", brief: "Fix CC-12", humanApproval: true }],
        },
        origin: {
          kind: "template",
          tier: "project",
          id: "fix-ticket",
          revision: 1,
          name: "Fix a ticket",
        },
      });
    });

    it("launches the current revision when the launch names none", async () => {
      await save("project", null, content());
      await save("project", 1, content({ name: "Fix it fast" }));

      expect(await prepare()).toMatchObject({
        ok: true,
        request: { title: "Fix it fast" },
        origin: { revision: 2, name: "Fix it fast" },
      });
    });

    it("refuses a revision the person launching did not see, naming the current one", async () => {
      await save("project", null, content());
      await save("project", 1, content({ name: "Fix it fast" }));

      expect(await prepare({ revision: 1 })).toEqual({
        ok: false,
        refusal: {
          code: "run_template_changed",
          message: expect.stringContaining("revision 2"),
          currentRevision: 2,
        },
      });
    });

    it("locates every value problem at its parameter", async () => {
      await save(
        "project",
        null,
        content({
          parameters: [
            { name: "ticket", description: "Ticket", required: true },
            { name: "area", description: "Area", required: false },
          ],
        }),
      );

      expect(
        await prepare({ parameters: { ticket: "  ", extra: "x" } }),
      ).toEqual({
        ok: false,
        refusal: {
          code: "run_template_launch_invalid",
          message: expect.any(String),
          issues: [
            { path: "parameters.extra", message: expect.any(String) },
            { path: "parameters.ticket", message: expect.any(String) },
          ],
        },
      });
    });

    it("refuses a template that does not exist, one whose file cannot be read naming the file, and a malformed id", async () => {
      const projectDir = path.join(
        configDir,
        "run-templates",
        Buffer.from(PROJECT).toString("base64url"),
      );
      await mkdir(projectDir, { recursive: true });
      await writeFile(path.join(projectDir, "broken.json"), "{");

      expect(await prepare({ id: "missing" })).toEqual({
        ok: false,
        refusal: {
          code: "run_template_not_found",
          message: "Run template project:missing does not exist",
        },
      });
      expect(await prepare({ id: "broken" })).toEqual({
        ok: false,
        refusal: {
          code: "run_template_not_found",
          message: expect.stringContaining(
            path.join(projectDir, "broken.json"),
          ),
        },
      });
      expect(await prepare({ id: "../escape" })).toMatchObject({
        ok: false,
        refusal: { code: "run_template_invalid_id" },
      });
    });
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
