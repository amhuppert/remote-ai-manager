import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { recordMergeIntent, getMergeIntents } from "./repo";
import {
  _createTestDb,
  _installTestDb,
  _resetForTesting,
} from "../state-store/state-db";

beforeEach(() => {
  _installTestDb(_createTestDb({ inMemory: true }));
});

afterEach(() => {
  _resetForTesting();
});

describe("merge-intents repo", () => {
  it("returns only the intents matching the requested shas for the project", () => {
    recordMergeIntent({
      projectPath: "/p1",
      commitSha: "sha-a",
      intent: "intent a",
      source: "session-merge",
    });
    recordMergeIntent({
      projectPath: "/p1",
      commitSha: "sha-b",
      intent: "intent b",
      source: "graph-join",
    });
    recordMergeIntent({
      projectPath: "/p2",
      commitSha: "sha-a",
      intent: "other project",
      source: "session-merge",
    });

    const intents = getMergeIntents("/p1", ["sha-a", "sha-b", "sha-missing"]);

    expect(intents).toHaveLength(2);
    expect(intents.map((i) => i.intent).sort()).toEqual([
      "intent a",
      "intent b",
    ]);
    expect(intents.every((i) => i.projectPath === "/p1")).toBe(true);
  });

  it("returns an empty array without touching the DB for an empty sha list", () => {
    expect(getMergeIntents("/p1", [])).toEqual([]);
  });

  it("replaces the intent when the same commit is recorded twice", () => {
    recordMergeIntent({
      projectPath: "/p1",
      commitSha: "sha-a",
      intent: "first",
      source: "session-merge",
    });
    recordMergeIntent({
      projectPath: "/p1",
      commitSha: "sha-a",
      intent: "second",
      source: "session-merge",
    });

    const intents = getMergeIntents("/p1", ["sha-a"]);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.intent).toBe("second");
  });
});
