import { afterEach, describe, it, expect, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  parseFrontmatter,
  discoverCommands,
  createCommandDiscovery,
} from "./service";
import type { CommandItem } from "./schemas";
import type { ResolvedCapabilityCascade } from "@/lib/agent-backends/runtime-config";

describe("parseFrontmatter", () => {
  it("parses valid frontmatter block", () => {
    const content = `---
description: Initialize a spec
argument-hint: <project-description>
---
Body content here.`;

    const result = parseFrontmatter(content);
    expect(result.fields["description"]).toBe("Initialize a spec");
    expect(result.fields["argument-hint"]).toBe("<project-description>");
    expect(result.body).toBe("Body content here.");
  });

  it("returns empty fields when no frontmatter", () => {
    const content = "Just body content.";
    const result = parseFrontmatter(content);
    expect(result.fields).toEqual({});
    expect(result.body).toBe("Just body content.");
  });

  it("handles empty content", () => {
    const result = parseFrontmatter("");
    expect(result.fields).toEqual({});
    expect(result.body).toBe("");
  });

  it("handles frontmatter with no closing delimiter", () => {
    const content = `---
description: No closing`;

    const result = parseFrontmatter(content);
    expect(result.fields).toEqual({});
    expect(result.body).toBe(content);
  });

  it("strips surrounding quotes from values", () => {
    const content = `---
description: "A quoted value"
name: 'single quoted'
---
Body.`;

    const result = parseFrontmatter(content);
    expect(result.fields["description"]).toBe("A quoted value");
    expect(result.fields["name"]).toBe("single quoted");
  });

  it("handles empty frontmatter block", () => {
    const content = `---
---
Body only.`;

    const result = parseFrontmatter(content);
    expect(result.fields).toEqual({});
    expect(result.body).toBe("Body only.");
  });
});

describe("discoverCommands", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      cleanupPaths
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  // Spec D14: a backend with no command surface returns a bounded empty
  // result. The load-bearing half is that it reaches that result without
  // touching another backend's directories — the previous `codex ? … : claude`
  // fallback would have scanned `.claude/` for it, and a populated worktree is
  // the only way to tell "found nothing" from "looked nowhere".
  it("returns an empty Cursor result without scanning any backend's directories", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "commands-home-"));
    const worktreePath = await mkdtemp(
      path.join(tmpdir(), "commands-worktree-"),
    );
    cleanupPaths.push(homeDir, worktreePath);
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    for (const backendDir of [".claude", ".agents", ".codex"]) {
      await mkdir(path.join(worktreePath, backendDir, "commands"), {
        recursive: true,
      });
      await writeFile(
        path.join(worktreePath, backendDir, "commands", "visible.md"),
        `---
description: Would be discovered for the backend that owns this directory
---
Body.`,
      );
    }

    const items = await discoverCommands(worktreePath, "cursor");

    expect(items).toEqual([]);
  });

  it("uses directory basename for skill id, ignoring frontmatter name with spaces", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "commands-home-"));
    const worktreePath = await mkdtemp(
      path.join(tmpdir(), "commands-worktree-"),
    );
    cleanupPaths.push(homeDir, worktreePath);
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    await mkdir(
      path.join(worktreePath, ".claude", "skills", "expo-ui-swift-ui"),
      { recursive: true },
    );
    await writeFile(
      path.join(
        worktreePath,
        ".claude",
        "skills",
        "expo-ui-swift-ui",
        "SKILL.md",
      ),
      `---
name: Expo UI SwiftUI
description: A display name with spaces
---
Body.`,
    );

    const items = await (
      discoverCommands as unknown as (
        worktreePath: string,
        backend: string,
      ) => Promise<Array<{ name: string; source: string }>>
    )(worktreePath, "claude");

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "/expo-ui-swift-ui" }),
      ]),
    );
    expect(items.every((item) => !item.name.includes(" "))).toBe(true);
  });

  it("discovers a Claude skill installed as a symlink in ~/.claude/skills", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "commands-home-"));
    const worktreePath = await mkdtemp(
      path.join(tmpdir(), "commands-worktree-"),
    );
    cleanupPaths.push(homeDir, worktreePath);
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    const realSkillDir = path.join(homeDir, ".agents", "skills", "find-skills");
    await mkdir(realSkillDir, { recursive: true });
    await writeFile(
      path.join(realSkillDir, "SKILL.md"),
      `---
name: find-skills
description: Discover and install agent skills
---
Body.`,
    );

    const linkDir = path.join(homeDir, ".claude", "skills");
    await mkdir(linkDir, { recursive: true });
    await symlink(realSkillDir, path.join(linkDir, "find-skills"), "dir");

    const items = await (
      discoverCommands as unknown as (
        worktreePath: string,
        backend: string,
      ) => Promise<Array<{ name: string; source: string }>>
    )(worktreePath, "claude");

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "/find-skills", source: "user" }),
      ]),
    );
  });

  it("offers only user-invocable Claude skills while retaining explicit-only skills", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "commands-home-"));
    const worktreePath = await mkdtemp(
      path.join(tmpdir(), "commands-worktree-"),
    );
    cleanupPaths.push(homeDir, worktreePath);
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    const pluginPath = path.join(homeDir, ".claude", "plugins", "demo");
    await mkdir(pluginPath, { recursive: true });
    await writeFile(
      path.join(homeDir, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "demo@local": true } }),
    );
    await writeFile(
      path.join(homeDir, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: { "demo@local": [{ installPath: pluginPath }] },
      }),
    );

    const expectedNames: string[] = [];
    for (const [source, skillsRoot, prefix] of [
      ["project", path.join(worktreePath, ".claude", "skills"), "/"],
      ["user", path.join(homeDir, ".claude", "skills"), "/"],
      ["plugin", path.join(pluginPath, "skills"), "/demo:"],
    ] as const) {
      for (const [suffix, metadata] of [
        ["hidden", "user-invocable: false"],
        ["explicit", "disable-model-invocation: true"],
        ["ordinary", ""],
      ] as const) {
        const skillId = `${source}-${suffix}`;
        const skillDir = path.join(skillsRoot, skillId);
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          path.join(skillDir, "SKILL.md"),
          `---\nname: ${skillId}\ndescription: ${skillId}\n${metadata}\n---\nBody.`,
        );
        if (suffix !== "hidden") expectedNames.push(`${prefix}${skillId}`);
      }
    }

    const items = await discoverCommands(worktreePath, "claude");

    expect(items.map((item) => item.name).sort()).toEqual(expectedNames.sort());
  });

  it.each([false, true])(
    "uses the personal Claude skill's invocation policy when it shadows a project skill (hidden: %s)",
    async (hidden) => {
      const homeDir = await mkdtemp(path.join(tmpdir(), "commands-home-"));
      const worktreePath = await mkdtemp(
        path.join(tmpdir(), "commands-worktree-"),
      );
      cleanupPaths.push(homeDir, worktreePath);
      vi.spyOn(os, "homedir").mockReturnValue(homeDir);

      for (const [root, description, metadata] of [
        [worktreePath, "Project definition", ""],
        [homeDir, "Personal definition", `user-invocable: ${!hidden}`],
      ] as const) {
        const skillDir = path.join(root, ".claude", "skills", "shared");
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          path.join(skillDir, "SKILL.md"),
          `---\nname: shared\ndescription: ${description}\n${metadata}\n---\nBody.`,
        );
      }

      const items = await discoverCommands(worktreePath, "claude");

      expect(items).toEqual(
        hidden
          ? []
          : [
              {
                name: "/shared",
                description: "Personal definition",
                type: "skill",
                source: "user",
              },
            ],
      );
    },
  );

  it.each([false, true])(
    "keeps a Claude skill authoritative over same-name legacy commands (hidden: %s)",
    async (hidden) => {
      const homeDir = await mkdtemp(path.join(tmpdir(), "commands-home-"));
      const worktreePath = await mkdtemp(
        path.join(tmpdir(), "commands-worktree-"),
      );
      cleanupPaths.push(homeDir, worktreePath);
      vi.spyOn(os, "homedir").mockReturnValue(homeDir);

      const skillDir = path.join(worktreePath, ".claude", "skills", "shared");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        `---\ndescription: Skill definition\nuser-invocable: ${!hidden}\n---\nBody.`,
      );
      for (const [root, description] of [
        [worktreePath, "Project legacy"],
        [homeDir, "Personal legacy"],
      ] as const) {
        const commandDir = path.join(root, ".claude", "commands");
        await mkdir(commandDir, { recursive: true });
        for (const name of ["shared", "legacy-only"]) {
          await writeFile(
            path.join(commandDir, `${name}.md`),
            `---\ndescription: ${description}\n---\nBody.`,
          );
        }
      }

      const items = await discoverCommands(worktreePath, "claude");

      expect(items.filter((item) => item.name === "/shared")).toEqual(
        hidden
          ? []
          : [
              {
                name: "/shared",
                description: "Skill definition",
                type: "skill",
                source: "project",
              },
            ],
      );
      expect(items.find((item) => item.name === "/legacy-only")).toMatchObject({
        description: "Project legacy",
        source: "project",
      });
    },
  );
});

describe("native Codex command discovery", () => {
  const first: CommandItem = {
    name: "$plugin-name:native-name",
    description: "Native description",
    type: "skill",
    source: "user",
    skillPath: "/skills/first/SKILL.md",
  };
  const second: CommandItem = {
    ...first,
    skillPath: "/skills/second/SKILL.md",
  };
  const capabilities: ResolvedCapabilityCascade = {
    backend: "codex",
    kinds: [
      {
        kind: "skills",
        items: [
          { itemId: "private-skill", enabled: false, originLayer: "session" },
        ],
      },
    ],
  };

  it("preserves native names and same-name skills with distinct paths", async () => {
    const discover = createCommandDiscovery({
      getSkillCatalog: () => ({
        getCommands: async () => [first, second, first],
      }),
    });
    expect(await discover("/worktree", "codex")).toEqual([first, second]);
  });

  it("uses scoped lazy configuration before requesting the native catalog", async () => {
    const discover = createCommandDiscovery({
      getSkillCatalog: () => ({
        getCommands: async (input) => {
          expect(input).toEqual({
            worktreePath: "/scoped/worktree",
            capabilities,
          });
          return [first];
        },
      }),
    });
    expect(
      await discover("/scoped/worktree", "codex", {
        capabilities: { backend: "codex", kinds: [] },
        resolveCapabilities: async () => capabilities,
      }),
    ).toEqual([first]);
  });

  it("uses supplied capability configuration when there is no lazy resolver", async () => {
    const discover = createCommandDiscovery({
      getSkillCatalog: () => ({
        getCommands: async (input) => {
          expect(input.capabilities).toEqual(capabilities);
          return [first];
        },
      }),
    });
    expect(await discover("/worktree", "codex", { capabilities })).toEqual([
      first,
    ]);
  });

  it("validates conversation scope before consulting a registered runtime", async () => {
    const getRuntime = vi.fn(() => undefined);
    const discover = createCommandDiscovery({
      getRuntime,
      getSkillCatalog: () => ({ getCommands: async () => [] }),
    });
    await expect(
      discover("/worktree", "codex", {
        conversationId: "foreign-conversation",
        resolveCapabilities: async () => {
          throw new Error("Conversation outside requested scope");
        },
      }),
    ).rejects.toThrow("Conversation outside requested scope");
    expect(getRuntime).not.toHaveBeenCalled();
  });

  it("returns the live runtime's applied catalog after scope validation", async () => {
    let scopeValidated = false;
    const discover = createCommandDiscovery({
      getRuntime(conversationId) {
        expect(scopeValidated).toBe(true);
        expect(conversationId).toBe("current-conversation");
        return {
          backend: "codex",
          status: "alive",
          getSkillCommands: async (resolved?: ResolvedCapabilityCascade) => {
            expect(resolved).toEqual(capabilities);
            return [second];
          },
        };
      },
      getSkillCatalog: () => ({
        getCommands: async () => {
          throw new Error("live catalog must win");
        },
      }),
    });
    expect(
      await discover("/worktree", "codex", {
        conversationId: "current-conversation",
        resolveCapabilities: async () => {
          scopeValidated = true;
          return capabilities;
        },
      }),
    ).toEqual([second]);
  });

  it.each([
    undefined,
    {
      backend: "claude",
      status: "alive",
      getSkillCommands: async () => [second],
    },
    {
      backend: "codex",
      status: "dead",
      getSkillCommands: async () => [second],
    },
    { backend: "codex", status: "alive" },
  ] as const)(
    "uses native discovery when a usable runtime is absent: %s",
    async (runtime) => {
      const discover = createCommandDiscovery({
        getRuntime: () => runtime,
        getSkillCatalog: () => ({ getCommands: async () => [first] }),
      });
      expect(
        await discover("/worktree", "codex", {
          conversationId: "conversation",
        }),
      ).toEqual([first]);
    },
  );

  it("surfaces catalog failure instead of offering filesystem guesses", async () => {
    const discover = createCommandDiscovery({
      getSkillCatalog: () => ({
        getCommands: async () => {
          throw new Error("Native catalog unavailable");
        },
      }),
    });
    await expect(discover("/worktree", "codex")).rejects.toThrow(
      "Native catalog unavailable",
    );
  });
});
