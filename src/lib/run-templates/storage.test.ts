import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunTemplateContent } from "./document";
import { createRunTemplateStorage, type RunTemplateScope } from "./storage";

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "cc-run-template-storage-"));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

const project: RunTemplateScope = { kind: "project", projectPath: "/repo/app" };
const global: RunTemplateScope = { kind: "global" };

function content(name = "Fix a ticket"): RunTemplateContent {
  return {
    name,
    description: "",
    parameters: [],
    defaults: {},
    workflow: { contexts: [{ key: "fix", brief: "Fix it" }] },
  };
}

function storage(now = () => new Date("2026-10-12T10:00:00.000Z")) {
  return createRunTemplateStorage({ resolveConfigDir: () => configDir, now });
}

/** The template a read found, or null when it found none. */
async function stored(scope: RunTemplateScope, id: string) {
  const read = await storage().get(scope, id);
  return read.kind === "found" ? read.record : null;
}

function scopeDir(scope: RunTemplateScope): string {
  return path.join(
    configDir,
    "run-templates",
    scope.kind === "global"
      ? "global.shared"
      : Buffer.from(scope.projectPath).toString("base64url"),
  );
}

describe("run template storage", () => {
  it("creates a template at revision 1 and reads it back from its file", async () => {
    const created = await storage().create(project, "fix-ticket", content());

    expect(created).toEqual({
      ok: true,
      record: {
        ...content(),
        format: 1,
        id: "fix-ticket",
        revision: 1,
        createdAt: "2026-10-12T10:00:00.000Z",
        updatedAt: "2026-10-12T10:00:00.000Z",
      },
    });
    expect(await stored(project, "fix-ticket")).toEqual(
      created.ok ? created.record : null,
    );
    expect(await stored(global, "fix-ticket")).toBeNull();
  });

  it("refuses to create over an existing id, leaving the template as it was", async () => {
    await storage().create(project, "fix-ticket", content("First"));

    const second = await storage().create(
      project,
      "fix-ticket",
      content("Second"),
    );

    expect(second).toMatchObject({
      ok: false,
      refusal: { code: "run_template_exists" },
    });
    expect((await stored(project, "fix-ticket"))?.name).toBe("First");
  });

  it("replaces a template only at its current revision, naming the current one otherwise", async () => {
    const later = storage(() => new Date("2026-10-12T11:00:00.000Z"));
    await storage().create(project, "fix-ticket", content("First"));

    const replaced = await later.update(
      project,
      "fix-ticket",
      1,
      content("Second"),
    );
    const stale = await later.update(
      project,
      "fix-ticket",
      1,
      content("Third"),
    );

    expect(replaced).toMatchObject({
      ok: true,
      record: {
        name: "Second",
        revision: 2,
        createdAt: "2026-10-12T10:00:00.000Z",
        updatedAt: "2026-10-12T11:00:00.000Z",
      },
    });
    expect(stale).toMatchObject({
      ok: false,
      refusal: { code: "run_template_revision_conflict", currentRevision: 2 },
    });
    expect((await stored(project, "fix-ticket"))?.name).toBe("Second");
  });

  it("deletes a template only at its current revision", async () => {
    await storage().create(project, "fix-ticket", content());

    const stale = await storage().delete(project, "fix-ticket", 2);
    expect(stale).toMatchObject({
      ok: false,
      refusal: { code: "run_template_revision_conflict", currentRevision: 1 },
    });
    expect(await stored(project, "fix-ticket")).not.toBeNull();

    const deleted = await storage().delete(project, "fix-ticket", 1);
    expect(deleted).toMatchObject({ ok: true, record: { revision: 1 } });
    expect(await stored(project, "fix-ticket")).toBeNull();
  });

  it("refuses to replace or delete a template that does not exist", async () => {
    expect(
      await storage().update(project, "missing", 1, content()),
    ).toMatchObject({
      ok: false,
      refusal: { code: "run_template_not_found" },
    });
    expect(await storage().delete(project, "missing", 1)).toMatchObject({
      ok: false,
      refusal: { code: "run_template_not_found" },
    });
  });

  it("serializes two replacements made from the same revision, so exactly one wins", async () => {
    await storage().create(project, "fix-ticket", content());

    const results = await Promise.all([
      storage().update(project, "fix-ticket", 1, content("A")),
      storage().update(project, "fix-ticket", 1, content("B")),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect((await stored(project, "fix-ticket"))?.revision).toBe(2);
  });

  it("quarantines an unreadable file beside readable siblings, naming its path", async () => {
    await storage().create(project, "good", content());
    const dir = scopeDir(project);
    await writeFile(path.join(dir, "broken.json"), "{ not json");
    const misfiled = {
      ...content(),
      format: 1,
      id: "other",
      revision: 1,
      createdAt: "x",
      updatedAt: "x",
    };
    await writeFile(path.join(dir, "misfiled.json"), JSON.stringify(misfiled));

    const listing = await storage().list(project);

    expect(listing.records.map((record) => record.id)).toEqual(["good"]);
    expect(listing.diagnostics).toEqual([
      {
        id: "broken",
        path: path.join(dir, "broken.json"),
        reason: expect.stringContaining("invalid JSON"),
      },
      {
        id: "misfiled",
        path: path.join(dir, "misfiled.json"),
        reason: expect.stringContaining('"other"'),
      },
    ]);
    expect(await storage().get(project, "broken")).toEqual({
      kind: "unreadable",
      path: path.join(dir, "broken.json"),
      reason: expect.stringContaining("invalid JSON"),
    });
    expect(await storage().get(project, "missing")).toEqual({ kind: "absent" });
  });

  it("keeps a quarantined file's id from being taken, and names the file to fix", async () => {
    const dir = scopeDir(project);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "broken.json"), "{ not json");

    const created = await storage().create(project, "broken", content());

    expect(created).toMatchObject({
      ok: false,
      refusal: { code: "run_template_exists" },
    });
    if (created.ok) return;
    expect(created.refusal.message).toContain(path.join(dir, "broken.json"));
  });

  it("refuses an id that could leave its directory before touching the filesystem", async () => {
    await expect(storage().get(project, "../escape")).rejects.toThrow(
      /Invalid run template id/,
    );
    await expect(storage().create(project, "a/b", content())).rejects.toThrow(
      /Invalid run template id/,
    );
    expect(existsSync(path.join(configDir, "run-templates"))).toBe(false);
  });

  it("lists every scope that holds templates, with its project path", async () => {
    const other: RunTemplateScope = {
      kind: "project",
      projectPath: "/repo/other",
    };
    await storage().create(global, "shared", content());
    await storage().create(project, "fix", content());
    await storage().create(other, "fix", content());

    const scopes = await storage().listScopes();

    expect(scopes).toHaveLength(3);
    expect(scopes).toEqual(expect.arrayContaining([global, project, other]));
    expect(await readdir(path.join(configDir, "run-templates"))).toHaveLength(
      3,
    );
  });
});
