import { afterEach, beforeEach, describe, it, vi } from "vitest";

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
import { mergeIntentSchema } from "./schemas";
import type { MergeIntent } from "./schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";

beforeEach(() => {
  _installTestDb(_createTestDb({ inMemory: true }));
});

afterEach(() => {
  _resetForTesting();
});

/**
 * Every persisted key path of `mergeIntentSchema` populated with a distinctive
 * non-default value. `createdAt` is stamped by `recordMergeIntent` on write, so
 * the fixture seeds a placeholder and the policy below validates it against the
 * accessor-read `expected`.
 */
function buildMaximalMergeIntent(): MergeIntent {
  return mergeIntentSchema.parse({
    projectPath: "/projects/maximal",
    commitSha: "abc123def456abc123def456abc123def456abc1",
    intent:
      "Renamed SessionStore to SessionRepo across the codebase; keep the new name when reconciling.",
    source: "session-merge",
    createdAt: "placeholder-created-at",
  });
}

const fieldPolicies = {
  createdAt: "derived-on-write",
} as const;

describe("merge-intents durability contract", () => {
  it("round-trips every persisted merge-intent key path through the real repo", async () => {
    await assertRoundTripDurability({
      label: "merge-intents",
      schema: mergeIntentSchema,
      buildMaximalFixture: buildMaximalMergeIntent,
      persist: (fixture) => {
        recordMergeIntent({
          projectPath: fixture.projectPath,
          commitSha: fixture.commitSha,
          intent: fixture.intent,
          source: fixture.source,
        });
        const expected = getMergeIntents(fixture.projectPath, [
          fixture.commitSha,
        ])[0];
        if (expected === undefined) {
          throw new Error(
            "merge-intents contract: getMergeIntents returned nothing after record",
          );
        }
        return expected;
      },
      reload: (expected) =>
        getMergeIntents(expected.projectPath, [expected.commitSha])[0] ?? null,
      fieldPolicies,
    });
  });
});
