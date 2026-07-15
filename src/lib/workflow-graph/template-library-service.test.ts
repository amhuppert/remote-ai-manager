import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type { WorkflowPrerequisite } from "@/lib/workflow-graph/definition-schemas";
import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
} from "./test-fixtures";
import { createWorkflowStorageService } from "./storage";
import { createTemplateLibraryService } from "./template-library-service";

const PROJECT_PATH = "/repo";

const SKILL_PREREQUISITE: WorkflowPrerequisite = {
  kind: "skill",
  skill: "kiro-spec-design",
};

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "cc-template-library-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function realStorage() {
  return createWorkflowStorageService({ resolveConfigDir: () => tempDir });
}

function draft(name: string, overrides = {}) {
  return {
    name,
    description: `Description for ${name}`,
    definition: createWorkflowDefinition(overrides),
    layout: createWorkflowDefinitionRecord().layout,
  };
}

describe("template library service — combined cross-tier listing", () => {
  it("tags each item with its tier (global → global, project → project)", async () => {
    const storage = realStorage();
    await storage.create({ kind: "global" }, draft("Global Template"));
    await storage.create(
      { kind: "project", projectPath: PROJECT_PATH },
      draft("Project Template"),
    );

    const service = createTemplateLibraryService({ storage });
    const items = await service.list(PROJECT_PATH);

    const byName = new Map(items.map((item) => [item.name, item]));
    expect(byName.get("Global Template")?.tier).toBe("global");
    expect(byName.get("Project Template")?.tier).toBe("project");
    expect(items).toHaveLength(2);
  });

  it("lists same-name items across tiers distinctly (no merge/dedupe)", async () => {
    const storage = realStorage();
    await storage.create({ kind: "global" }, draft("Shared Name"));
    await storage.create(
      { kind: "project", projectPath: PROJECT_PATH },
      draft("Shared Name"),
    );

    const service = createTemplateLibraryService({ storage });
    const items = await service.list(PROJECT_PATH);

    const sharedNamed = items.filter((item) => item.name === "Shared Name");
    expect(sharedNamed).toHaveLength(2);
    expect(new Set(sharedNamed.map((item) => item.tier))).toEqual(
      new Set(["global", "project"]),
    );
    // Distinct stored ids — never collapsed into one item.
    expect(sharedNamed[0]?.id).not.toBe(sharedNamed[1]?.id);
  });

  it("returns the project tier when the global tier is empty", async () => {
    const storage = realStorage();
    await storage.create(
      { kind: "project", projectPath: PROJECT_PATH },
      draft("Only Project"),
    );

    const service = createTemplateLibraryService({ storage });
    const items = await service.list(PROJECT_PATH);

    expect(items).toHaveLength(1);
    expect(items[0]?.name).toBe("Only Project");
    expect(items[0]?.tier).toBe("project");
  });

  it("returns the global tier when the project tier is empty", async () => {
    const storage = realStorage();
    await storage.create({ kind: "global" }, draft("Only Global"));

    const service = createTemplateLibraryService({ storage });
    const items = await service.list(PROJECT_PATH);

    expect(items).toHaveLength(1);
    expect(items[0]?.name).toBe("Only Global");
    expect(items[0]?.tier).toBe("global");
  });

  it("returns an empty listing when both tiers are empty", async () => {
    const service = createTemplateLibraryService({ storage: realStorage() });
    expect(await service.list(PROJECT_PATH)).toEqual([]);
  });

  it("carries parameters and prerequisites for launch without a second fetch", async () => {
    const storage = realStorage();
    await storage.create(
      { kind: "global" },
      draft("Parameterized Template", {
        parameters: [
          {
            type: "string",
            name: "feature-name",
            label: "Feature name",
            required: true,
          },
        ],
        prerequisites: [SKILL_PREREQUISITE],
      }),
    );

    const service = createTemplateLibraryService({ storage });
    const [item] = await service.list(PROJECT_PATH);

    expect(item?.parameters).toHaveLength(1);
    expect(item?.parameters[0]?.name).toBe("feature-name");
    expect(item?.prerequisites).toEqual([SKILL_PREREQUISITE]);
    expect(item?.revision).toBe(1);
    expect(item?.description).toBe("Description for Parameterized Template");
  });

  it("builds the combined listing with exactly one storage list call per tier (no N+1 per item)", async () => {
    const storage = realStorage();
    await storage.create({ kind: "global" }, draft("G1"));
    await storage.create({ kind: "global" }, draft("G2"));
    await storage.create(
      { kind: "project", projectPath: PROJECT_PATH },
      draft("P1"),
    );

    const listSpy = vi.spyOn(storage, "list");
    const getSpy = vi.spyOn(storage, "get");

    const service = createTemplateLibraryService({ storage });
    const items = await service.list(PROJECT_PATH);

    expect(items).toHaveLength(3);
    // Twice — once per tier — and never a per-item `get`.
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(getSpy).not.toHaveBeenCalled();
  });
});

describe("template library service — tier-scoped resolve", () => {
  it("resolves a record from the indicated tier", async () => {
    const storage = realStorage();
    const globalRecord = await storage.create(
      { kind: "global" },
      draft("Resolvable Global"),
    );
    const projectRecord = await storage.create(
      { kind: "project", projectPath: PROJECT_PATH },
      draft("Resolvable Project"),
    );

    const service = createTemplateLibraryService({ storage });

    const resolvedGlobal = await service.resolve({
      projectPath: PROJECT_PATH,
      tier: "global",
      id: globalRecord.id,
    });
    expect(resolvedGlobal?.id).toBe(globalRecord.id);
    expect(resolvedGlobal?.name).toBe("Resolvable Global");

    const resolvedProject = await service.resolve({
      projectPath: PROJECT_PATH,
      tier: "project",
      id: projectRecord.id,
    });
    expect(resolvedProject?.id).toBe(projectRecord.id);
    expect(resolvedProject?.name).toBe("Resolvable Project");
  });

  it("returns null for a template not found in the indicated tier", async () => {
    const storage = realStorage();
    const globalRecord = await storage.create(
      { kind: "global" },
      draft("Global Only"),
    );

    const service = createTemplateLibraryService({ storage });

    // The id exists in the global tier but not in the project tier.
    expect(
      await service.resolve({
        projectPath: PROJECT_PATH,
        tier: "project",
        id: globalRecord.id,
      }),
    ).toBeNull();

    expect(
      await service.resolve({
        projectPath: PROJECT_PATH,
        tier: "global",
        id: "does-not-exist",
      }),
    ).toBeNull();
  });

  it("never mutates the stored template (read-only resolve)", async () => {
    const storage = realStorage();
    const created = await storage.create(
      { kind: "global" },
      draft("Immutable Template"),
    );

    const service = createTemplateLibraryService({ storage });
    await service.resolve({
      projectPath: PROJECT_PATH,
      tier: "global",
      id: created.id,
    });

    const afterResolve = await storage.get({ kind: "global" }, created.id);
    expect(afterResolve).toEqual(created);
  });

  it("scopes resolve to the correct tier via the matching storage scope", async () => {
    const storage = realStorage();
    const getSpy = vi.spyOn(storage, "get");
    const created = await storage.create(
      { kind: "project", projectPath: PROJECT_PATH },
      draft("Scoped Resolve"),
    );

    const service = createTemplateLibraryService({ storage });
    await service.resolve({
      projectPath: PROJECT_PATH,
      tier: "project",
      id: created.id,
    });

    expect(getSpy).toHaveBeenCalledWith(
      { kind: "project", projectPath: PROJECT_PATH },
      created.id,
    );
  });
});
