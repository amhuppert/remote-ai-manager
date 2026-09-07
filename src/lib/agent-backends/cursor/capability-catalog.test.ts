import { mkdir, mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverCursorCatalog,
  renderCursorSkillCatalog,
  selectCursorCatalog,
} from "./capability-catalog";

let root: string;
let worktreePath: string;
let home: string;
async function file(relative: string, content: string) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}
const skill = (name: string, body = "SECRET_BODY") =>
  `---\nname: ${name}\ndescription: >-\n  Use for checking\n  selected capabilities.\n---\n${body}`;
beforeEach(async () => {
  await mkdir(".cc/temp", { recursive: true });
  root = await mkdtemp(path.resolve(".cc/temp/cursor-catalog-"));
  worktreePath = path.join(root, "workspace");
  home = path.join(root, "home");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Cursor CC capability catalog", () => {
  it("discovers project and user skills without including their bodies in the index", async () => {
    await file("workspace/.cursor/skills/check/SKILL.md", skill("check"));
    await file("home/.cursor/skills/audit/SKILL.md", skill("audit"));
    const catalog = await discoverCursorCatalog({
      worktreePath,
      home,
      bundle: null,
    });
    expect(catalog.items.map((i) => i.id).sort()).toEqual(["audit", "check"]);
    const index = renderCursorSkillCatalog(catalog.items);
    expect(index).toContain("Use for checking selected capabilities.");
    expect(index).toContain("/check");
    expect(index).not.toContain("SECRET_BODY");
  });
  it("uses project precedence and reports collisions without walking symlink cycles", async () => {
    await file("home/.cursor/skills/check/SKILL.md", skill("check"));
    await file("workspace/.cursor/skills/check/SKILL.md", skill("check"));
    await symlink(
      path.join(worktreePath, ".cursor/skills"),
      path.join(worktreePath, ".cursor/skills/loop"),
    );
    const catalog = await discoverCursorCatalog({
      worktreePath,
      home,
      bundle: null,
    });
    expect(catalog.items).toHaveLength(1);
    expect(catalog.items[0]?.scope).toBe("project");
    expect(
      catalog.diagnostics.some((d) => d.code === "cursor-capability-collision"),
    ).toBe(true);
  });
  it("discovers plugin children and suppresses them when the parent is disabled", async () => {
    await file(
      "home/.cursor/plugins/local/review/.cursor-plugin/plugin.json",
      JSON.stringify({ name: "review" }),
    );
    await file(
      "home/.cursor/plugins/local/review/skills/check/SKILL.md",
      skill("check"),
    );
    await file(
      "home/.cursor/plugins/local/review/agents/audit.md",
      "---\nname: audit\ndescription: Audit changes\n---\nInspect carefully.",
    );
    await file("home/.cursor/plugins/local/review/hooks/hooks.json", "{}");
    const catalog = await discoverCursorCatalog({
      worktreePath,
      home,
      bundle: null,
    });
    expect(catalog.items.map((i) => i.id).sort()).toEqual([
      "review",
      "review:audit",
      "review:check",
    ]);
    expect(
      catalog.diagnostics.some(
        (d) => d.code === "cursor-plugin-components-unsupported",
      ),
    ).toBe(true);
    expect(
      selectCursorCatalog(catalog, {
        backend: "cursor",
        kinds: [
          {
            kind: "plugins",
            items: [
              { itemId: "review", enabled: false, originLayer: "conversation" },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });
  it("keeps managed skills independent of overrides and rejects namespace impersonation", async () => {
    await file("bundle/skills/cc-cli/SKILL.md", skill("cc-cli"));
    await file(
      "workspace/.cursor/skills/imposter/SKILL.md",
      skill("command-center:cc-cli"),
    );
    const bundle = {
      id: "command-center" as const,
      version: "1",
      digest: "1234567890abcdef",
      root: path.join(root, "bundle"),
      skillsRoot: path.join(root, "bundle/skills"),
      skillNames: ["cc-cli"],
    };
    const catalog = await discoverCursorCatalog({ worktreePath, home, bundle });
    const selected = selectCursorCatalog(catalog, {
      backend: "cursor",
      kinds: [
        {
          kind: "skills",
          items: [
            {
              itemId: "command-center:cc-cli",
              enabled: false,
              originLayer: "global",
            },
          ],
        },
      ],
    });
    expect(selected).toHaveLength(1);
    expect(selected[0]?.scope).toBe("managed");
    expect(
      catalog.diagnostics.some(
        (d) => d.code === "cursor-capability-reserved-name",
      ),
    ).toBe(true);
  });
});

it("omits disabled skills and fails closed when discovery for a declared cascade is missing", async () => {
  await file("workspace/.cursor/skills/check/SKILL.md", skill("check"));
  const catalog = await discoverCursorCatalog({
    worktreePath,
    home,
    bundle: null,
  });
  expect(
    selectCursorCatalog(catalog, { backend: "cursor", kinds: [] }),
  ).toEqual([]);
});
it("rejects an oversized catalog instead of silently dropping enabled skills", () => {
  expect(() =>
    renderCursorSkillCatalog([
      {
        id: "large",
        name: "large",
        description: "x".repeat(17000),
        path: "/skills/large/SKILL.md",
        scope: "user",
        kind: "skills",
      },
    ]),
  ).toThrow("disable skills");
});
it("does not follow plugin component paths outside the plugin root", async () => {
  await file(
    "home/.cursor/plugins/local/review/.cursor-plugin/plugin.json",
    JSON.stringify({ name: "review", skills: ["../../outside"] }),
  );
  const catalog = await discoverCursorCatalog({
    worktreePath,
    home,
    bundle: null,
  });
  expect(
    catalog.diagnostics.some((d) => d.code === "cursor-plugin-path-rejected"),
  ).toBe(true);
  expect(catalog.items.filter((i) => i.kind === "skills")).toEqual([]);
});

it("writes shared skill roots once to avoid repeating long bundle paths", () => {
  const items = ["one", "two"].map((id) => ({
    id,
    name: id,
    description: "Read when needed",
    path: `/long/published/bundle/skills/${id}/SKILL.md`,
    scope: "managed" as const,
    kind: "skills" as const,
  }));
  const index = renderCursorSkillCatalog(items);
  expect(index.split("/long/published/bundle/skills")).toHaveLength(2);
  expect(index).toContain("one/SKILL.md");
});

it("does not rediscover the managed bridge as configurable user skills", async () => {
  await file("bundle/skills/cc-cli/SKILL.md", skill("cc-cli"));
  await mkdir(path.join(worktreePath, ".agents/skills"), { recursive: true });
  await symlink(
    path.join(root, "bundle/skills"),
    path.join(worktreePath, ".agents/skills/command-center"),
  );
  const catalog = await discoverCursorCatalog({
    worktreePath,
    home,
    bundle: null,
  });
  expect(catalog.items).toEqual([]);
});

it("preserves an explicit Cursor agent model and its prompt", async () => {
  await file(
    "workspace/.cursor/agents/auditor.md",
    "---\nname: auditor\ndescription: Audit changes\nmodel: composer-2.5\n---\nUse the provided review checklist.",
  );
  const catalog = await discoverCursorCatalog({
    worktreePath,
    home,
    bundle: null,
  });
  expect(catalog.items[0]?.definition).toEqual({
    description: "Audit changes",
    prompt: "Use the provided review checklist.",
    model: { id: "composer-2.5" },
  });
});

it("discloses skill invocation controls that CC delivery cannot enforce", async () => {
  await file(
    "workspace/.cursor/skills/manual/SKILL.md",
    "---\nname: manual\ndescription: A manual skill\ndisable-model-invocation: true\n---\nManual instructions",
  );
  const catalog = await discoverCursorCatalog({
    worktreePath,
    home,
    bundle: null,
  });
  expect(catalog.items.some((item) => item.id === "manual")).toBe(false);
  expect(catalog.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "cursor-skill-fields-unsupported",
      itemId: "manual",
    }),
  );
});
