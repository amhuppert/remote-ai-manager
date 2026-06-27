import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ALIGNMENT_DOCUMENT_PATH } from "./render";
import {
  createCharterMirrorWriter,
  type CharterMirrorRegistryEntry,
  type CharterMirrorWriterDeps,
} from "./mirror";

const PROJECT_PATH = "/repos/demo";
const SESSION_NAME = "csm/align-demo";

/**
 * In-memory reference-documents registry double that mimics the real registry's
 * idempotent-on-filePath semantics (update the description for an existing path,
 * otherwise create). Injected so tests never touch the real state-store.
 */
function createRegistryDouble() {
  const entries: CharterMirrorRegistryEntry[] = [];
  let nextId = 1;

  const register: CharterMirrorWriterDeps["registerReferenceDocument"] = async (
    projectPath,
    sessionName,
    filePath,
    description,
  ) => {
    const existing = entries.find(
      (e) =>
        e.projectPath === projectPath &&
        e.sessionName === sessionName &&
        e.filePath === filePath,
    );
    if (existing) {
      existing.description = description;
      return { ...existing };
    }
    const entry: CharterMirrorRegistryEntry = {
      id: `doc-${nextId++}`,
      projectPath,
      sessionName,
      filePath,
      description,
    };
    entries.push(entry);
    return { ...entry };
  };

  return { entries, register };
}

describe("createCharterMirrorWriter", () => {
  let worktreePath: string;

  beforeEach(async () => {
    worktreePath = await mkdtemp(path.join(tmpdir(), "cc-align-mirror-"));
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });

  const mirrorAbsolutePath = () =>
    path.join(worktreePath, ALIGNMENT_DOCUMENT_PATH);

  it("materializes the charter copy and registers a reference document pointing to it", async () => {
    const registry = createRegistryDouble();
    const writer = createCharterMirrorWriter({
      registerReferenceDocument: registry.register,
    });

    const content = "## Mission\nShip the alignment mirror.";
    const result = await writer.write({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      worktreePath,
      content,
    });

    expect(result.ok).toBe(true);

    const written = await readFile(mirrorAbsolutePath(), "utf-8");
    expect(written).toBe(content);

    expect(registry.entries).toHaveLength(1);
    expect(registry.entries[0]?.filePath).toBe(ALIGNMENT_DOCUMENT_PATH);
    expect(registry.entries[0]?.projectPath).toBe(PROJECT_PATH);
    expect(registry.entries[0]?.sessionName).toBe(SESSION_NAME);
    if (result.ok) {
      expect(result.filePath).toBe(ALIGNMENT_DOCUMENT_PATH);
    }
  });

  it("re-registers idempotently on rewrite without duplicating the entry", async () => {
    const registry = createRegistryDouble();
    const writer = createCharterMirrorWriter({
      registerReferenceDocument: registry.register,
    });

    await writer.write({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      worktreePath,
      content: "v1",
    });
    await writer.write({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      worktreePath,
      content: "v2",
    });

    expect(registry.entries).toHaveLength(1);
    expect(await readFile(mirrorAbsolutePath(), "utf-8")).toBe("v2");
  });

  it("repairs a missing copy from the provided content and keeps the registry pointing correctly", async () => {
    const registry = createRegistryDouble();
    const writer = createCharterMirrorWriter({
      registerReferenceDocument: registry.register,
    });

    const content = "## Mission\nRepair me.";
    await writer.write({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      worktreePath,
      content,
    });

    await rm(mirrorAbsolutePath());
    await expect(stat(mirrorAbsolutePath())).rejects.toMatchObject({
      code: "ENOENT",
    });

    const repair = await writer.ensure({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      worktreePath,
      content,
    });

    expect(repair.ok).toBe(true);
    if (repair.ok) {
      expect(repair.repaired).toBe(true);
    }
    expect(await readFile(mirrorAbsolutePath(), "utf-8")).toBe(content);
    expect(registry.entries).toHaveLength(1);
    expect(registry.entries[0]?.filePath).toBe(ALIGNMENT_DOCUMENT_PATH);
  });

  it("ensure does not rewrite when the copy already exists", async () => {
    const registry = createRegistryDouble();
    const writer = createCharterMirrorWriter({
      registerReferenceDocument: registry.register,
    });

    await writer.write({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      worktreePath,
      content: "original",
    });

    const repair = await writer.ensure({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      worktreePath,
      content: "different-content-should-not-overwrite",
    });

    expect(repair.ok).toBe(true);
    if (repair.ok) {
      expect(repair.repaired).toBe(false);
    }
    expect(await readFile(mirrorAbsolutePath(), "utf-8")).toBe("original");
  });

  it("surfaces a write failure as a failed result without corrupting the input", async () => {
    const registry = createRegistryDouble();
    const failure = new Error("disk full");
    const writer = createCharterMirrorWriter({
      registerReferenceDocument: registry.register,
      writeFile: async () => {
        throw failure;
      },
    });

    const input = {
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      worktreePath,
      content: "## Mission\nDo not corrupt me.",
    };
    const inputSnapshot = JSON.stringify(input);

    const result = await writer.write(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(failure);
    }
    // Input object is untouched.
    expect(JSON.stringify(input)).toBe(inputSnapshot);
    // No reference document registered when the file write failed.
    expect(registry.entries).toHaveLength(0);
    // No half-written authoritative state on disk.
    await expect(stat(mirrorAbsolutePath())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("surfaces a registry failure as a failed result after the file was written", async () => {
    const registryFailure = new Error("registry unavailable");
    const writer = createCharterMirrorWriter({
      registerReferenceDocument: async () => {
        throw registryFailure;
      },
    });

    const result = await writer.write({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      worktreePath,
      content: "## Mission\nFile ok, registry down.",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(registryFailure);
    }
    // The mirror file itself was still materialized (app state remains
    // authoritative; only discovery registration failed).
    expect(await readFile(mirrorAbsolutePath(), "utf-8")).toBe(
      "## Mission\nFile ok, registry down.",
    );
  });
});
