import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { publishManagedSkillBundle } from "@/lib/managed-skills/publisher";
import { prepareCursorCapabilityDelivery } from "./capability-delivery";
let root: string;
beforeEach(async () => {
  await mkdir(".cc/temp", { recursive: true });
  root = await mkdtemp(path.resolve(".cc/temp/cursor-delivery-"));
  await mkdir(path.join(root, "workspace/.cursor/skills/demo"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "workspace/.cursor/skills/demo/SKILL.md"),
    "---\nname: demo\ndescription: A test skill\n---\nDO_NOT_INJECT_BODY",
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const input = () => ({
  worktreePath: path.join(root, "workspace"),
  home: path.join(root, "home"),
  storePath: path.join(root, "store"),
  bundle: null,
  resumed: false,
  hermetic: false,
});
it("persists the initial selection and delivery receipt across resume without taking pending config", async () => {
  const created = await prepareCursorCapabilityDelivery(input());
  expect(created.snapshot.catalog).toContain("/demo");
  expect(created.snapshot.catalog).not.toContain("DO_NOT_INJECT_BODY");
  await created.markDelivered();
  const resumed = await prepareCursorCapabilityDelivery({
    ...input(),
    resumed: true,
    resolved: {
      backend: "cursor",
      kinds: [
        {
          kind: "skills",
          items: [
            { itemId: "demo", enabled: false, originLayer: "conversation" },
          ],
        },
      ],
    },
  });
  expect(resumed.snapshot.catalog).toBe(created.snapshot.catalog);
  expect(resumed.snapshot.commands).toEqual(created.snapshot.commands);
  expect(resumed.snapshot.delivered).toBe(true);
  expect(
    JSON.parse(
      await readFile(path.join(root, "store/cc-capabilities.json"), "utf8"),
    ).delivered,
  ).toBe(true);
});
it("reconciles a fresh conversation to the current selection", async () => {
  await prepareCursorCapabilityDelivery(input());
  const created = await prepareCursorCapabilityDelivery({
    ...input(),
    resolved: {
      backend: "cursor",
      kinds: [
        {
          kind: "skills",
          items: [{ itemId: "demo", enabled: false, originLayer: "global" }],
        },
      ],
    },
  });
  expect(created.snapshot.catalog).toBe("");
});
it("hermetic delivery never reuses an ordinary conversation's capability snapshot", async () => {
  await prepareCursorCapabilityDelivery(input());
  const isolated = await prepareCursorCapabilityDelivery({
    ...input(),
    hermetic: true,
    resumed: true,
  });
  expect(isolated.snapshot).toMatchObject({
    catalog: "",
    agents: {},
    delivered: true,
  });
});

it("replaces stale bundle entries on fresh creation and pins the immutable version on resume", async () => {
  const sourceDir = path.join(root, "bundle-source");
  await mkdir(path.join(sourceDir, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(sourceDir, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "command-center", version: "1.0.0" }),
  );
  await mkdir(path.join(sourceDir, "skills/retired"), { recursive: true });
  await writeFile(
    path.join(sourceDir, "skills/retired/SKILL.md"),
    "---\nname: retired\ndescription: Retired fixture\n---\nold body",
  );
  const first = await publishManagedSkillBundle({
    sourceDir,
    configDir: path.join(root, "config"),
  });
  expect(first.published).toBe(true);
  if (!first.published) throw Error("fixture publish failed");
  const created = await prepareCursorCapabilityDelivery({
    ...input(),
    bundle: first.bundle,
  });
  await created.markDelivered();
  await rm(path.join(sourceDir, "skills/retired"), { recursive: true });
  await mkdir(path.join(sourceDir, "skills/current"), { recursive: true });
  await writeFile(
    path.join(sourceDir, "skills/current/SKILL.md"),
    "---\nname: current\ndescription: Current fixture\n---\ncurrent body",
  );
  const next = await publishManagedSkillBundle({
    sourceDir,
    configDir: path.join(root, "config"),
  });
  if (!next.published) throw Error("fixture publish failed");
  const resumed = await prepareCursorCapabilityDelivery({
    ...input(),
    bundle: next.bundle,
    resumed: true,
  });
  expect(resumed.snapshot.catalog).toBe(created.snapshot.catalog);
  expect(resumed.snapshot.commands).toEqual(created.snapshot.commands);
  const fresh = await prepareCursorCapabilityDelivery({
    ...input(),
    bundle: next.bundle,
  });
  expect(fresh.snapshot.catalog).toContain("/command-center:current");
  expect(fresh.snapshot.catalog).not.toContain("retired");
  expect(fresh.snapshot.commands.map((item) => item.name)).toContain(
    "/command-center:current",
  );
  expect(fresh.snapshot.commands.map((item) => item.name)).not.toContain(
    "/command-center:retired",
  );
  expect(
    await readFile(
      path.join(first.bundle.skillsRoot, "retired/SKILL.md"),
      "utf8",
    ),
  ).toContain("old body");
});

it("refuses corrupted persisted delivery instead of silently changing a resumed selection", async () => {
  await prepareCursorCapabilityDelivery(input());
  await writeFile(path.join(root, "store/cc-capabilities.json"), "{}");
  await expect(
    prepareCursorCapabilityDelivery({ ...input(), resumed: true }),
  ).rejects.toThrow();
});
