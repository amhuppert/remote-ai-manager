import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createMergeIntentsRepo, type MergeIntentsRepo } from "./repo";
import {
  _createTestDb,
  _installTestDb,
  _resetForTesting,
} from "../state-store/state-db";

let repo: MergeIntentsRepo;

beforeEach(() => {
  const db = _createTestDb({ inMemory: true });
  _installTestDb(db);
  repo = createMergeIntentsRepo(db);
});

afterEach(() => {
  _resetForTesting();
});

describe("merge-intents repo", () => {
  it("returns only the intents matching the requested shas for the project", () => {
    repo.recordMergeIntent({
      projectPath: "/p1",
      commitSha: "sha-a",
      intent: "intent a",
      source: "session-merge",
    });
    repo.recordMergeIntent({
      projectPath: "/p1",
      commitSha: "sha-b",
      intent: "intent b",
      source: "graph-join",
    });
    repo.recordMergeIntent({
      projectPath: "/p2",
      commitSha: "sha-a",
      intent: "other project",
      source: "session-merge",
    });

    const intents = repo.getMergeIntents("/p1", [
      "sha-a",
      "sha-b",
      "sha-missing",
    ]);

    expect(intents).toHaveLength(2);
    expect(intents.map((i) => i.intent).sort()).toEqual([
      "intent a",
      "intent b",
    ]);
    expect(intents.every((i) => i.projectPath === "/p1")).toBe(true);
  });

  it("returns an empty array without touching the DB for an empty sha list", () => {
    expect(repo.getMergeIntents("/p1", [])).toEqual([]);
  });

  it("replaces the intent when the same commit is recorded twice", () => {
    repo.recordMergeIntent({
      projectPath: "/p1",
      commitSha: "sha-a",
      intent: "first",
      source: "session-merge",
    });
    repo.recordMergeIntent({
      projectPath: "/p1",
      commitSha: "sha-a",
      intent: "second",
      source: "session-merge",
    });

    const intents = repo.getMergeIntents("/p1", ["sha-a"]);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.intent).toBe("second");
  });
});
