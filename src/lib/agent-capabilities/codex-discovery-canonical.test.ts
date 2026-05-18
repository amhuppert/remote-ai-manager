import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  agentCapabilityDiagnosticSchema,
  agentCapabilityDiscoveredItemSchema,
} from "@/lib/schemas";

import {
  discoverCodexPluginsCanonical,
  discoverCodexSkillsCanonical,
} from "./codex-discovery";

let workTree: string;
let home: string;

async function writeSkill(
  dir: string,
  skillId: string,
  body: string,
): Promise<void> {
  await mkdir(path.join(dir, skillId), { recursive: true });
  await writeFile(
    path.join(dir, skillId, "SKILL.md"),
    `---\nname: ${skillId}\ndescription: ${body}\n---\n${body}\n`,
    "utf-8",
  );
}

beforeEach(async () => {
  workTree = await mkdtemp(path.join(os.tmpdir(), "codex-canon-work-"));
  home = await mkdtemp(path.join(os.tmpdir(), "codex-canon-home-"));
});

afterEach(async () => {
  await rm(workTree, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("discoverCodexSkillsCanonical", () => {
  it("returns items in canonical AgentCapabilityDiscoveredItem shape", async () => {
    await writeSkill(path.join(workTree, ".agents/skills"), "p1", "a");
    await writeSkill(path.join(home, ".codex/skills/.system"), "s1", "b");
    const result = await discoverCodexSkillsCanonical({
      worktreePath: workTree,
      home,
    });
    expect(result.cascadeKind).toBe("codex-skills");
    expect(result.items).toHaveLength(2);
    for (const item of result.items) {
      // Boundary parse: ensures the schema accepts each item shape.
      agentCapabilityDiscoveredItemSchema.parse(item);
      expect(item.capabilityKind).toBe("skill");
      expect(item.nativeDefault.enabled).toBe(true);
      expect(item.runtimeVisibility).toBe("source-only");
    }
    const sourceKinds = result.items.map((i) => i.source.kind).sort();
    expect(sourceKinds).toEqual(["project-file", "system-file"]);
  });

  it("attaches canonical diagnostic shape for source-read failures (parseable + non-blocking)", async () => {
    await mkdir(path.join(workTree, ".agents/skills"), { recursive: true });
    const result = await discoverCodexSkillsCanonical({
      worktreePath: workTree,
      home,
      readDir: async () => {
        throw new Error("EACCES: simulated permission denied");
      },
    });
    expect(result.items).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    for (const diag of result.diagnostics) {
      // The diagnostic schema enforces cascadeKind/backend ownership pairing;
      // parsing here proves Codex diagnostics carry "codex" backend, not Claude.
      agentCapabilityDiagnosticSchema.parse(diag);
      expect(diag.cascadeKind).toBe("codex-skills");
      expect(diag.backend).toBe("codex");
    }
    // Non-blocking: refreshedAt is still populated.
    expect(typeof result.refreshedAt).toBe("string");
  });

  it("preserves the native source kind on read-failure diagnostics", async () => {
    const userSkillsDir = path.join(home, ".codex/skills");
    await mkdir(userSkillsDir, { recursive: true });

    const result = await discoverCodexSkillsCanonical({
      worktreePath: workTree,
      home,
      readDir: async (dir) => {
        if (dir === userSkillsDir) {
          throw new Error("user source unreadable");
        }
        return [];
      },
    });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        sourceRef: { kind: "user-file", path: userSkillsDir },
      }),
    );
  });

  it("produces a stable content-sensitive source signature", async () => {
    await writeSkill(path.join(workTree, ".agents/skills"), "p1", "before");
    const first = await discoverCodexSkillsCanonical({
      worktreePath: workTree,
      home,
    });
    await writeSkill(path.join(workTree, ".agents/skills"), "p1", "after");
    const second = await discoverCodexSkillsCanonical({
      worktreePath: workTree,
      home,
    });
    expect(first.sourceSignature).not.toBe(second.sourceSignature);
  });
});

describe("discoverCodexPluginsCanonical", () => {
  it("returns no items, the unavailable diagnostic, and canonical-shaped diagnostic", async () => {
    const result = await discoverCodexPluginsCanonical({
      worktreePath: workTree,
      home,
    });
    expect(result.cascadeKind).toBe("codex-plugins");
    expect(result.items).toEqual([]);
    expect(result.discoverySupport).toBe("unavailable-pending-verification");
    expect(result.diagnostics).toHaveLength(1);
    const diag = result.diagnostics[0]!;
    agentCapabilityDiagnosticSchema.parse(diag);
    expect(diag.code).toBe("codex-plugins-unavailable");
    expect(diag.cascadeKind).toBe("codex-plugins");
    expect(diag.backend).toBe("codex");
    expect(diag.severity).toBe("warning");
  });

  it("populates refreshedAt and a stable signature so cache layers can key on it", async () => {
    const first = await discoverCodexPluginsCanonical({
      worktreePath: workTree,
      home,
    });
    const second = await discoverCodexPluginsCanonical({
      worktreePath: workTree,
      home,
    });
    expect(first.sourceSignature).toBe(second.sourceSignature);
    expect(typeof first.refreshedAt).toBe("string");
  });
});
