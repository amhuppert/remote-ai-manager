import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { computeContentHash } from "./hashing";
import {
  AgentProfileIdConflictError,
  AgentProfileNotFoundError,
  AgentProfileRevisionConflictError,
  createAgentProfileStorage,
  scopeForMutableTier,
  type AgentProfileScope,
  type AgentProfileStorage,
} from "./storage";

const PROJECT_A = "/repos/project-a";
const PROJECT_B = "/repos/project-b";

const GLOBAL_SCOPE: AgentProfileScope = { kind: "global" };
const PROJECT_A_SCOPE: AgentProfileScope = {
  kind: "project",
  projectPath: PROJECT_A,
};
const PROJECT_B_SCOPE: AgentProfileScope = {
  kind: "project",
  projectPath: PROJECT_B,
};

let configDir: string;
let storage: AgentProfileStorage;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "cc-agent-profile-storage-"));
  storage = createAgentProfileStorage({ resolveConfigDir: () => configDir });
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

/** The on-disk directory a scope's records live in — pins the storage layout. */
function scopeDir(scope: AgentProfileScope): string {
  const key =
    scope.kind === "global"
      ? "global.shared"
      : Buffer.from(scope.projectPath).toString("base64url");
  return path.join(configDir, "agent-profiles", key);
}

function draft(
  overrides: Partial<{ name: string; instructions: string }> = {},
) {
  return {
    name: overrides.name ?? "Reviewer",
    description: "Reviews changes against their stated contract.",
    instructions: overrides.instructions ?? "Review the change as written.",
    recommendedFor: ["workflow_validator" as const],
    tags: ["review"],
  };
}

function content(
  overrides: Partial<{ name: string; instructions: string }> = {},
) {
  return draft(overrides);
}

// ============================================================
// Races — the reason storage owns a per-record mutex (D16)
// ============================================================

describe("agent profile storage — concurrent mutation races", () => {
  it("lets exactly one of two simultaneous updates from the same revision win", async () => {
    const created = await storage.create(GLOBAL_SCOPE, {
      id: "reviewer",
      ...draft(),
    });
    expect(created.revision).toBe(1);

    const results = await Promise.allSettled([
      storage.update(GLOBAL_SCOPE, "reviewer", 1, content({ name: "First" })),
      storage.update(GLOBAL_SCOPE, "reviewer", 1, content({ name: "Second" })),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const winner = fulfilled[0];
    if (winner?.status !== "fulfilled") throw new Error("expected a winner");
    expect(winner.value.revision).toBe(2);

    const loser = rejected[0];
    if (loser?.status !== "rejected") throw new Error("expected a loser");
    expect(loser.reason).toBeInstanceOf(AgentProfileRevisionConflictError);
    expect(loser.reason).toMatchObject({
      expectedRevision: 1,
      winningRevision: 2,
    });

    // The losing write left nothing behind: disk holds exactly the winner.
    const reloaded = await storage.get(GLOBAL_SCOPE, "reviewer");
    expect(reloaded?.revision).toBe(2);
    expect(reloaded?.name).toBe(winner.value.name);
  });

  it("lets exactly one of two simultaneous creates of the same id win", async () => {
    const results = await Promise.allSettled([
      storage.create(GLOBAL_SCOPE, { id: "reviewer", ...draft({ name: "A" }) }),
      storage.create(GLOBAL_SCOPE, { id: "reviewer", ...draft({ name: "B" }) }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    if (rejected?.status !== "rejected") throw new Error("expected a loser");
    expect(rejected.reason).toBeInstanceOf(AgentProfileIdConflictError);

    const listing = await storage.list(GLOBAL_SCOPE);
    expect(listing.records).toHaveLength(1);
    expect(listing.records[0]?.revision).toBe(1);
  });

  it("lets exactly one of a simultaneous update and delete win, refusing the loser", async () => {
    await storage.create(GLOBAL_SCOPE, { id: "reviewer", ...draft() });

    const results = await Promise.allSettled([
      storage.update(GLOBAL_SCOPE, "reviewer", 1, content({ name: "Updated" })),
      storage.delete(GLOBAL_SCOPE, "reviewer", 1),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    if (rejected?.status !== "rejected") throw new Error("expected a loser");

    const survivor = await storage.get(GLOBAL_SCOPE, "reviewer");
    if (survivor === null) {
      // Delete won: the update found no record to compare-and-swap against.
      expect(rejected.reason).toBeInstanceOf(AgentProfileNotFoundError);
    } else {
      // Update won: the delete's expected revision is now stale.
      expect(survivor.revision).toBe(2);
      expect(rejected.reason).toBeInstanceOf(AgentProfileRevisionConflictError);
      expect(rejected.reason).toMatchObject({ winningRevision: 2 });
    }
  });

  it("serializes a burst of compare-and-swap updates into one revision per write", async () => {
    await storage.create(GLOBAL_SCOPE, { id: "reviewer", ...draft() });

    // Every writer submits the same stale expectation; only the first can win.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_unused, index) =>
        storage.update(
          GLOBAL_SCOPE,
          "reviewer",
          1,
          content({ name: `W${index}` }),
        ),
      ),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const result of results.filter((r) => r.status === "rejected")) {
      if (result.status !== "rejected") continue;
      expect(result.reason).toBeInstanceOf(AgentProfileRevisionConflictError);
      expect(result.reason).toMatchObject({ winningRevision: 2 });
    }
    expect((await storage.get(GLOBAL_SCOPE, "reviewer"))?.revision).toBe(2);
  });

  it("runs mutations for different records concurrently rather than globally serially", async () => {
    await storage.create(GLOBAL_SCOPE, { id: "one", ...draft() });
    await storage.create(GLOBAL_SCOPE, { id: "two", ...draft() });

    const [first, second] = await Promise.all([
      storage.update(GLOBAL_SCOPE, "one", 1, content({ name: "One" })),
      storage.update(GLOBAL_SCOPE, "two", 1, content({ name: "Two" })),
    ]);

    expect(first.revision).toBe(2);
    expect(second.revision).toBe(2);
  });
});

// ============================================================
// Compare-and-swap semantics
// ============================================================

describe("agent profile storage — compare-and-swap", () => {
  it("increments revision on update and derives the source content hash from instructions", async () => {
    const created = await storage.create(GLOBAL_SCOPE, {
      id: "reviewer",
      ...draft({ instructions: "First instructions." }),
    });
    expect(created.revision).toBe(1);
    expect(created.sourceContentHash).toBe(
      computeContentHash("First instructions."),
    );

    const updated = await storage.update(
      GLOBAL_SCOPE,
      "reviewer",
      1,
      content({ instructions: "Second instructions." }),
    );
    expect(updated.revision).toBe(2);
    expect(updated.sourceContentHash).toBe(
      computeContentHash("Second instructions."),
    );
    expect(updated.id).toBe("reviewer");
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it("refuses a stale update with the winning revision and changes nothing", async () => {
    await storage.create(GLOBAL_SCOPE, {
      id: "reviewer",
      ...draft({ name: "Original" }),
    });
    await storage.update(
      GLOBAL_SCOPE,
      "reviewer",
      1,
      content({ name: "Live" }),
    );

    await expect(
      storage.update(GLOBAL_SCOPE, "reviewer", 1, content({ name: "Stale" })),
    ).rejects.toMatchObject({
      name: "AgentProfileRevisionConflictError",
      expectedRevision: 1,
      winningRevision: 2,
    });

    const reloaded = await storage.get(GLOBAL_SCOPE, "reviewer");
    expect(reloaded?.name).toBe("Live");
    expect(reloaded?.revision).toBe(2);
  });

  it("refuses a stale delete and leaves the record intact", async () => {
    await storage.create(GLOBAL_SCOPE, { id: "reviewer", ...draft() });
    await storage.update(
      GLOBAL_SCOPE,
      "reviewer",
      1,
      content({ name: "Live" }),
    );

    await expect(
      storage.delete(GLOBAL_SCOPE, "reviewer", 1),
    ).rejects.toBeInstanceOf(AgentProfileRevisionConflictError);

    expect(await storage.get(GLOBAL_SCOPE, "reviewer")).not.toBeNull();

    await storage.delete(GLOBAL_SCOPE, "reviewer", 2);
    expect(await storage.get(GLOBAL_SCOPE, "reviewer")).toBeNull();
  });

  it("refuses updating or deleting a record that does not exist", async () => {
    await expect(
      storage.update(GLOBAL_SCOPE, "ghost", 1, content()),
    ).rejects.toBeInstanceOf(AgentProfileNotFoundError);
    await expect(
      storage.delete(GLOBAL_SCOPE, "ghost", 1),
    ).rejects.toBeInstanceOf(AgentProfileNotFoundError);
  });

  it("refuses creating an id that already exists in the same scope", async () => {
    await storage.create(GLOBAL_SCOPE, { id: "reviewer", ...draft() });
    await expect(
      storage.create(GLOBAL_SCOPE, { id: "reviewer", ...draft() }),
    ).rejects.toBeInstanceOf(AgentProfileIdConflictError);
  });

  it("refuses an id that is not a kebab-case slug, so no id can address a path", async () => {
    await expect(
      storage.create(GLOBAL_SCOPE, { id: "../escape", ...draft() }),
    ).rejects.toThrow();
    await expect(storage.get(GLOBAL_SCOPE, "../escape")).rejects.toThrow();
  });
});

// ============================================================
// Scope isolation
// ============================================================

describe("agent profile storage — scope isolation", () => {
  it("writes global records under the reserved key and project records under the project key", async () => {
    await storage.create(GLOBAL_SCOPE, { id: "reviewer", ...draft() });
    await storage.create(PROJECT_A_SCOPE, { id: "reviewer", ...draft() });

    expect(await readdir(scopeDir(GLOBAL_SCOPE))).toEqual(["reviewer.json"]);
    expect(await readdir(scopeDir(PROJECT_A_SCOPE))).toEqual(["reviewer.json"]);
  });

  it("never lists, resolves, or mutates one project's records through another project's scope", async () => {
    await storage.create(PROJECT_A_SCOPE, {
      id: "reviewer",
      ...draft({ name: "Project A Reviewer" }),
    });

    expect((await storage.list(PROJECT_B_SCOPE)).records).toEqual([]);
    expect(await storage.get(PROJECT_B_SCOPE, "reviewer")).toBeNull();
    await expect(
      storage.update(PROJECT_B_SCOPE, "reviewer", 1, content()),
    ).rejects.toBeInstanceOf(AgentProfileNotFoundError);
    await expect(
      storage.delete(PROJECT_B_SCOPE, "reviewer", 1),
    ).rejects.toBeInstanceOf(AgentProfileNotFoundError);

    // Project A is untouched by every refusal above.
    const survivor = await storage.get(PROJECT_A_SCOPE, "reviewer");
    expect(survivor?.name).toBe("Project A Reviewer");
    expect(survivor?.revision).toBe(1);
  });

  it("keeps same-id global and project records independent", async () => {
    await storage.create(GLOBAL_SCOPE, {
      id: "reviewer",
      ...draft({ name: "Global Reviewer" }),
    });
    await storage.create(PROJECT_A_SCOPE, {
      id: "reviewer",
      ...draft({ name: "Project Reviewer" }),
    });

    await storage.update(
      GLOBAL_SCOPE,
      "reviewer",
      1,
      content({ name: "Edited" }),
    );

    expect((await storage.get(GLOBAL_SCOPE, "reviewer"))?.name).toBe("Edited");
    expect((await storage.get(PROJECT_A_SCOPE, "reviewer"))?.name).toBe(
      "Project Reviewer",
    );
    expect((await storage.get(PROJECT_A_SCOPE, "reviewer"))?.revision).toBe(1);
  });

  it("maps a mutable tier to exactly one scope", () => {
    expect(scopeForMutableTier("global", PROJECT_A)).toEqual({
      kind: "global",
    });
    expect(scopeForMutableTier("project", PROJECT_A)).toEqual({
      kind: "project",
      projectPath: PROJECT_A,
    });
  });
});

// ============================================================
// Quarantine
// ============================================================

describe("agent profile storage — corrupt record quarantine", () => {
  async function corrupt(
    scope: AgentProfileScope,
    id: string,
    contents: string,
  ): Promise<void> {
    await mkdir(scopeDir(scope), { recursive: true });
    await writeFile(
      path.join(scopeDir(scope), `${id}.json`),
      contents,
      "utf-8",
    );
  }

  it("excludes an unparseable record from listing and resolution with a diagnostic naming it", async () => {
    await storage.create(GLOBAL_SCOPE, { id: "healthy", ...draft() });
    await corrupt(GLOBAL_SCOPE, "broken", "{ not json");

    const listing = await storage.list(GLOBAL_SCOPE);

    expect(listing.records.map((record) => record.id)).toEqual(["healthy"]);
    expect(listing.diagnostics).toHaveLength(1);
    expect(listing.diagnostics[0]?.id).toBe("broken");
    expect(listing.diagnostics[0]?.reason).toBeTruthy();

    expect(await storage.get(GLOBAL_SCOPE, "broken")).toBeNull();
  });

  it("excludes a record that parses as JSON but fails the profile schema", async () => {
    await storage.create(GLOBAL_SCOPE, { id: "healthy", ...draft() });
    await corrupt(
      GLOBAL_SCOPE,
      "schema-broken",
      JSON.stringify({ id: "schema-broken", revision: 0 }),
    );

    const listing = await storage.list(GLOBAL_SCOPE);
    expect(listing.records.map((record) => record.id)).toEqual(["healthy"]);
    expect(listing.diagnostics[0]?.id).toBe("schema-broken");
  });

  it("keeps sibling records fully usable while one record is quarantined", async () => {
    await storage.create(GLOBAL_SCOPE, { id: "healthy", ...draft() });
    await corrupt(GLOBAL_SCOPE, "broken", "{ not json");

    const updated = await storage.update(
      GLOBAL_SCOPE,
      "healthy",
      1,
      content({ name: "Still Editable" }),
    );
    expect(updated.revision).toBe(2);
    expect((await storage.get(GLOBAL_SCOPE, "healthy"))?.name).toBe(
      "Still Editable",
    );
  });

  it("does not let a create silently reclaim a quarantined record's id", async () => {
    await corrupt(GLOBAL_SCOPE, "broken", "{ not json");

    await expect(
      storage.create(GLOBAL_SCOPE, { id: "broken", ...draft() }),
    ).rejects.toBeInstanceOf(AgentProfileIdConflictError);

    // The corrupt bytes are still on disk for an operator to inspect.
    expect(
      await readFile(path.join(scopeDir(GLOBAL_SCOPE), "broken.json"), "utf-8"),
    ).toBe("{ not json");
  });

  /**
   * A document that passes the record schema in every respect — the ONLY thing
   * wrong with it is which key it is filed under.
   */
  function wellFormedDocument(id: string) {
    return {
      id,
      revision: 1,
      name: "Impostor",
      description: "Structurally valid, filed under someone else's key.",
      instructions: "Impostor instructions.",
      recommendedFor: [],
      tags: [],
      sourceContentHash: computeContentHash("Impostor instructions."),
      createdAt: "2026-01-02T03:04:05.000Z",
      updatedAt: "2026-01-02T03:04:05.000Z",
    };
  }

  it("quarantines a record whose stored id does not match the key it is filed under", async () => {
    await storage.create(GLOBAL_SCOPE, { id: "healthy", ...draft() });
    // alpha.json declares id "beta". Nothing else about it is malformed.
    await corrupt(
      GLOBAL_SCOPE,
      "alpha",
      JSON.stringify(wellFormedDocument("beta")),
    );

    const listing = await storage.list(GLOBAL_SCOPE);

    // It must NOT appear as "beta": a record's identity is the key it is
    // addressed by, not a field it can claim for itself.
    expect(listing.records.map((record) => record.id)).toEqual(["healthy"]);
    expect(listing.diagnostics).toHaveLength(1);
    expect(listing.diagnostics[0]?.id).toBe("alpha");
    expect(listing.diagnostics[0]?.reason).toContain("beta");
    expect(listing.diagnostics[0]?.reason).toContain("alpha");
  });

  it("resolves neither the key nor the claimed id of a mismatched record", async () => {
    await corrupt(
      GLOBAL_SCOPE,
      "alpha",
      JSON.stringify(wellFormedDocument("beta")),
    );

    // The key does not resolve, because the document under it is not alpha.
    expect(await storage.get(GLOBAL_SCOPE, "alpha")).toBeNull();
    // The claimed id does not resolve either — no beta.json exists, and a
    // record may not smuggle itself into another id's address.
    expect(await storage.get(GLOBAL_SCOPE, "beta")).toBeNull();
  });

  it("refuses to mutate through either identity of a mismatched record", async () => {
    await corrupt(
      GLOBAL_SCOPE,
      "alpha",
      JSON.stringify(wellFormedDocument("beta")),
    );

    for (const id of ["alpha", "beta"]) {
      await expect(
        storage.update(GLOBAL_SCOPE, id, 1, content()),
      ).rejects.toBeInstanceOf(AgentProfileNotFoundError);
      await expect(storage.delete(GLOBAL_SCOPE, id, 1)).rejects.toBeInstanceOf(
        AgentProfileNotFoundError,
      );
    }

    // Still on disk, untouched, for an operator to inspect.
    expect(
      JSON.parse(
        await readFile(
          path.join(scopeDir(GLOBAL_SCOPE), "alpha.json"),
          "utf-8",
        ),
      ),
    ).toMatchObject({ id: "beta" });
  });

  it("keeps siblings usable while a mismatched record is quarantined", async () => {
    await storage.create(GLOBAL_SCOPE, { id: "healthy", ...draft() });
    await corrupt(
      GLOBAL_SCOPE,
      "alpha",
      JSON.stringify(wellFormedDocument("beta")),
    );

    const updated = await storage.update(
      GLOBAL_SCOPE,
      "healthy",
      1,
      content({ name: "Still Editable" }),
    );
    expect(updated.revision).toBe(2);
  });

  it("returns an empty listing with no diagnostics for a scope that has never been written", async () => {
    expect(await storage.list(PROJECT_B_SCOPE)).toEqual({
      records: [],
      diagnostics: [],
    });
  });
});
