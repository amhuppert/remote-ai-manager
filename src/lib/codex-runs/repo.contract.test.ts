import { afterEach, beforeEach, describe, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  createCodexRunRecord,
  updateCodexRunRecord,
  getCodexRunRecord,
} from "./repo";
import {
  _createTestDb,
  _installTestDb,
  _resetForTesting,
} from "../state-store/state-db";
import { codexRunRecordSchema } from "./schemas";
import type { CodexRunRecord } from "./schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";

beforeEach(() => {
  _installTestDb(_createTestDb({ inMemory: true }));
});

afterEach(() => {
  _resetForTesting();
});

/**
 * Build a durable codex-run record with EVERY persisted key path populated to a
 * distinctive non-default value so the schema-driven durability harness proves
 * no column is dropped on write or defaulted on read — including the optional
 * terminal metadata (`completedAt`, `summary`, `error`) and the JSON-encoded
 * multi-element `referenceDocuments` column.
 *
 * A real record never carries both `summary` and `error`, but the harness needs
 * every field set at once to detect a silent drop; that is orthogonal to the
 * status/result combinations the service produces.
 */
function buildMaximalRecord(): CodexRunRecord {
  return codexRunRecordSchema.parse({
    runId: "codex-run-maximal",
    projectName: "maximal-project",
    sessionName: "maximal-session",
    status: "succeeded",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:05:00.000Z",
    summary: "codex analyzed the repository and found two issues",
    referenceDocuments: [
      {
        filePath: "memory-bank/codex/alpha.md",
        description: "the alpha notes",
      },
      { filePath: "memory-bank/codex/beta.md", description: "the beta notes" },
    ],
    error: "a distinctive non-default error string",
  });
}

describe("codex-run-records durability contract", () => {
  it("round-trips every persisted durable codex-run key path through the real repo", async () => {
    await assertRoundTripDurability({
      label: "codex-run-records",
      schema: codexRunRecordSchema,
      buildMaximalFixture: buildMaximalRecord,
      persist: (fixture) => {
        // createCodexRunRecord only seeds the create-time columns (inserting as
        // running); the terminal status, results, and completion time reach
        // their columns via updateCodexRunRecord.
        createCodexRunRecord({
          runId: fixture.runId,
          projectName: fixture.projectName,
          sessionName: fixture.sessionName,
          startedAt: fixture.startedAt,
        });
        updateCodexRunRecord(fixture.runId, {
          status: fixture.status,
          completedAt: fixture.completedAt ?? "",
          ...(fixture.summary !== undefined
            ? { summary: fixture.summary }
            : {}),
          ...(fixture.referenceDocuments !== undefined
            ? { referenceDocuments: fixture.referenceDocuments }
            : {}),
          ...(fixture.error !== undefined ? { error: fixture.error } : {}),
        });
        const expected = getCodexRunRecord(fixture.runId);
        if (expected === null) {
          throw new Error(
            "codex-run-records contract: getCodexRunRecord returned null after create+update",
          );
        }
        return expected;
      },
      reload: (expected) => getCodexRunRecord(expected.runId),
    });
  });
});
