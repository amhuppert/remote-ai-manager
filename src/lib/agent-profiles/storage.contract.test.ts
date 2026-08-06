import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { computeContentHash } from "./hashing";
import {
  storedAgentProfileRecordSchema,
  type StoredAgentProfileRecord,
} from "./schemas";
import { createAgentProfileStorage, type AgentProfileScope } from "./storage";

/**
 * Maximal round-trip backstop for the mutable agent-profile tiers.
 *
 * Storage is file-backed (one atomic JSON document per record, D16), so the
 * "real persistence fixture" here is a real temp config directory: every case
 * persists through `atomicWriteJson` and reloads by re-reading the document
 * from disk through the storage service, never from an in-memory copy.
 */

const PROJECT_PATH = "/durability-project";

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "cc-agent-profile-contract-"));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

const INSTRUCTIONS =
  "Read the change against its stated contract, then report each defect with the input that produces it.";

/**
 * Every introspectable persisted key path carries a distinctive non-default
 * value, so the harness fails if any field is dropped or reset at the
 * serialization boundary. `recommendedFor` and `tags` default to `[]` in the
 * schema and are populated here for exactly that reason.
 */
function buildMaximalRecord(): StoredAgentProfileRecord {
  return {
    id: "maximal-reviewer",
    revision: 1,
    name: "Maximal Reviewer",
    description: "Every persisted field carries a distinctive value.",
    instructions: INSTRUCTIONS,
    recommendedFor: [
      "conversation",
      "workflow_implementer",
      "workflow_validator",
    ],
    tags: ["review", "durability", "maximal"],
    sourceContentHash: computeContentHash(INSTRUCTIONS),
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-02T03:04:05.000Z",
  };
}

/**
 * `revision`, `sourceContentHash`, and both timestamps are owned by the write
 * path, not by the caller: the fixture's values for them are ignored and the
 * harness validates the values storage derived instead.
 */
const FIELD_POLICIES = {
  revision: "derived-on-write",
  sourceContentHash: "derived-on-write",
  createdAt: "derived-on-write",
  updatedAt: "derived-on-write",
} as const;

const SCOPES: ReadonlyArray<[label: string, scope: AgentProfileScope]> = [
  ["global scope", { kind: "global" }],
  ["project scope", { kind: "project", projectPath: PROJECT_PATH }],
];

/** The document path a scope's record occupies — pins the on-disk layout. */
function recordFilePath(scope: AgentProfileScope, id: string): string {
  const key =
    scope.kind === "global"
      ? "global.shared"
      : Buffer.from(scope.projectPath).toString("base64url");
  return path.join(configDir, "agent-profiles", key, `${id}.json`);
}

describe("agent profile storage — persisted-field round-trip durability", () => {
  for (const [label, scope] of SCOPES) {
    it(`survives a create round trip through ${label}`, async () => {
      const storage = createAgentProfileStorage({
        resolveConfigDir: () => configDir,
      });

      await assertRoundTripDurability({
        label: `agent profile record (${label}, create)`,
        schema: storedAgentProfileRecordSchema,
        buildMaximalFixture: buildMaximalRecord,
        fieldPolicies: FIELD_POLICIES,
        persist: async (fixture) => {
          const { id, revision: _revision, ...content } = fixture;
          return storage.create(scope, { id, ...content });
        },
        // Reloaded from the document on disk, not from the returned value.
        reload: (expected) => storage.get(scope, expected.id),
      });
    });

    it(`survives an update round trip through ${label}`, async () => {
      const storage = createAgentProfileStorage({
        resolveConfigDir: () => configDir,
      });

      await assertRoundTripDurability({
        label: `agent profile record (${label}, update)`,
        schema: storedAgentProfileRecordSchema,
        buildMaximalFixture: buildMaximalRecord,
        fieldPolicies: FIELD_POLICIES,
        persist: async (fixture) => {
          const { id, revision: _revision, ...content } = fixture;
          // Seed with placeholder content so the update genuinely replaces
          // every editable field rather than rewriting identical bytes.
          await storage.create(scope, {
            id,
            name: "Placeholder",
            description: "Placeholder",
            instructions: "Placeholder instructions.",
            recommendedFor: [],
            tags: [],
          });
          return storage.update(scope, id, 1, content);
        },
        reload: (expected) => storage.get(scope, expected.id),
      });
    });
  }

  for (const [label, scope] of SCOPES) {
    it(`removes the document from disk on delete through ${label}`, async () => {
      const storage = createAgentProfileStorage({
        resolveConfigDir: () => configDir,
      });
      const { id, revision: _revision, ...content } = buildMaximalRecord();

      const created = await storage.create(scope, { id, ...content });
      // Prove it was durably there before proving it is durably gone —
      // otherwise a delete over a record that never persisted would pass.
      const beforeDelete = await storage.get(scope, id);
      expect(beforeDelete).toEqual(created);
      expect(existsSync(recordFilePath(scope, id))).toBe(true);

      await storage.delete(scope, id, created.revision);

      // Reloaded through the repository, not from an in-memory copy.
      expect(await storage.get(scope, id)).toBeNull();
      expect((await storage.list(scope)).records).toEqual([]);
      expect(existsSync(recordFilePath(scope, id))).toBe(false);
    });

    it(`frees the id for reuse at revision 1 after a delete through ${label}`, async () => {
      const storage = createAgentProfileStorage({
        resolveConfigDir: () => configDir,
      });
      const { id, revision: _revision, ...content } = buildMaximalRecord();

      const created = await storage.create(scope, { id, ...content });
      await storage.update(scope, id, created.revision, {
        ...content,
        name: "Bumped",
      });
      await storage.delete(scope, id, 2);

      // A recreate starts a fresh identity rather than resuming the old
      // revision line: the deleted document is gone, not tombstoned.
      const recreated = await storage.create(scope, { id, ...content });
      expect(recreated.revision).toBe(1);
      expect((await storage.get(scope, id))?.revision).toBe(1);
    });
  }

  it("carries the update's incremented revision and refreshed hash into the reloaded document", async () => {
    const storage = createAgentProfileStorage({
      resolveConfigDir: () => configDir,
    });
    const scope: AgentProfileScope = { kind: "global" };
    const fixture = buildMaximalRecord();
    const { id, revision: _revision, ...content } = fixture;

    await storage.create(scope, {
      id,
      ...content,
      instructions: "Original instructions.",
    });
    const updated = await storage.update(scope, id, 1, content);

    const reloaded = await storage.get(scope, id);
    expect(reloaded).toEqual(updated);
    expect(reloaded?.revision).toBe(2);
    expect(reloaded?.sourceContentHash).toBe(computeContentHash(INSTRUCTIONS));
  });
});
