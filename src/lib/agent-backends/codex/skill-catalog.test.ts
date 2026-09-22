import { describe, expect, it, vi } from "vitest";
import { CodexSkillCatalog } from "./skill-catalog";

const cwd = "/checkout";
function skill(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    description: `${name} description`,
    path: `/skills/${name}/SKILL.md`,
    scope: "user",
    enabled: true,
    pluginId: null,
    ...overrides,
  };
}
function response(skills: unknown[]) {
  return { config: { skills: null }, data: [{ cwd, skills, errors: [] }] };
}

describe("Codex native skill catalog", () => {
  it("uses native names, exact paths and enablement instead of inventing filesystem entries", async () => {
    const request = vi.fn().mockResolvedValue(
      response([
        skill("wait-what"),
        skill("disabled", { enabled: false }),
        skill("tools:review", {
          path: "/plugins/tools/review/SKILL.md",
          pluginId: "tools@market",
        }),
      ]),
    );
    const catalog = new CodexSkillCatalog({ request }, cwd);
    expect(await catalog.commands()).toEqual([
      {
        name: "$wait-what",
        description: "wait-what description",
        type: "skill",
        source: "user",
        skillPath: "/skills/wait-what/SKILL.md",
      },
      {
        name: "$tools:review",
        description: "tools:review description",
        type: "skill",
        source: "tools",
        skillPath: "/plugins/tools/review/SKILL.md",
      },
    ]);
    expect(request).toHaveBeenCalledWith("skills/list", {
      cwds: [cwd],
      forceReload: true,
    });
  });

  it("refreshes after native invalidation without serving an in-flight stale snapshot", async () => {
    const first = Promise.withResolvers<unknown>();
    const request = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(response([skill("new")]));
    const catalog = new CodexSkillCatalog({ request }, cwd);
    const pending = catalog.commands();
    catalog.invalidate();
    first.resolve(response([skill("old")]));
    expect((await pending).map((item) => item.name)).toEqual(["$new"]);
    expect((await catalog.commands()).map((item) => item.name)).toEqual([
      "$new",
    ]);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("delivers an exact explicit selection despite prepended context and duplicate names", async () => {
    const request = vi.fn().mockResolvedValue(
      response([
        skill("wait-what"),
        skill("wait-what", {
          path: "/project/skills/wait-what/SKILL.md",
          scope: "repo",
        }),
      ]),
    );
    const catalog = new CodexSkillCatalog({ request }, cwd);
    expect(
      await catalog.invocations(
        "<memory>host context</memory>\n\n[$wait-what](</project/skills/wait-what/SKILL.md>) clarify this",
      ),
    ).toEqual([
      {
        type: "skill",
        name: "wait-what",
        path: "/project/skills/wait-what/SKILL.md",
      },
    ]);
  });

  it("refuses stale or disabled selections instead of silently searching for a replacement", async () => {
    const catalog = new CodexSkillCatalog(
      {
        request: vi
          .fn()
          .mockResolvedValue(
            response([skill("wait-what", { enabled: false })]),
          ),
      },
      cwd,
    );
    await expect(
      catalog.invocations("[$wait-what](</skills/wait-what/SKILL.md>)"),
    ).rejects.toThrow(/no longer available/i);
  });

  it("does not invoke examples inside code or load a catalog for ordinary text", async () => {
    const request = vi.fn();
    const catalog = new CodexSkillCatalog({ request }, cwd);
    expect(
      await catalog.invocations(
        "Explain `[$example](</skills/example/SKILL.md>)`.",
      ),
    ).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an invalid native catalog instead of advertising partial or wrong-cwd data", async () => {
    const catalog = new CodexSkillCatalog(
      {
        request: vi.fn().mockResolvedValue({
          data: [{ cwd: "/wrong", skills: [], errors: [] }],
        }),
      },
      cwd,
    );
    await expect(catalog.commands()).rejects.toThrow(/working directory/i);
  });
});

it("retains disabled native entries in inventory while autocomplete filters them", async () => {
  const entries = [
    skill("visible"),
    skill("native-off", { enabled: false, path: "/linked/SKILL.md" }),
  ];
  const catalog = new CodexSkillCatalog(
    { request: vi.fn().mockResolvedValue(response(entries)) },
    cwd,
  );
  expect(await catalog.inventory()).toEqual(entries);
  expect((await catalog.commands()).map((item) => item.name)).toEqual([
    "$visible",
  ]);
});

it("uses effective native config selectors rather than reading potentially ignored project files", async () => {
  const native = [{ path: "/skills/native-off/SKILL.md", enabled: false }];
  const request = vi
    .fn()
    .mockResolvedValue({ config: { skills: { config: native } } });
  const catalog = new CodexSkillCatalog({ request }, cwd);
  expect(await catalog.selectors()).toEqual(native);
  expect(request).toHaveBeenCalledWith("config/read", {
    cwd,
    includeLayers: false,
  });
});

it("uses the effective project selector when a native catalog lists the skill before applying it", async () => {
  const catalog = new CodexSkillCatalog(
    {
      request: async (method) =>
        method === "config/read"
          ? {
              config: {
                skills: {
                  config: [
                    { path: "/skills/project-off/SKILL.md", enabled: false },
                  ],
                },
              },
            }
          : response([skill("project-off")]),
    },
    cwd,
  );
  expect((await catalog.inventory())[0]?.enabled).toBe(false);
  expect(await catalog.commands()).toEqual([]);
});
