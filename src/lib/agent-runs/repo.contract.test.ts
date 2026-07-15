import { afterEach, beforeEach, describe, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createAgentRunsRepo, type AgentRunsRepo } from "./repo";
import {
  _createTestDb,
  _installTestDb,
  _resetForTesting,
} from "../state-store/state-db";
import { agentRunRecordSchema } from "./schemas";
import type { AgentRunRecord } from "./schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";

let repo: AgentRunsRepo;

beforeEach(() => {
  const db = _createTestDb({ inMemory: true });
  _installTestDb(db);
  repo = createAgentRunsRepo(db);
});

afterEach(() => {
  _resetForTesting();
});

/**
 * Build a durable agent-run record with EVERY persisted key path populated to a
 * distinctive non-default value so the schema-driven durability harness proves
 * no column is dropped on write or defaulted on read — including the optional
 * terminal metadata (`completedAt`, `summary`, `error`) and the JSON-encoded
 * multi-element `referenceDocuments` column.
 *
 * A real record never carries both `summary` and `error`, but the harness needs
 * every field set at once to detect a silent drop; that is orthogonal to the
 * status/result combinations the service produces.
 */
function buildMaximalRecord(): AgentRunRecord {
  return agentRunRecordSchema.parse({
    runId: "agent-run-maximal",
    backend: "codex",
    projectName: "maximal-project",
    sessionName: "maximal-session",
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:05:00.000Z",
    summary: "the agent analyzed the repository and found two issues",
    referenceDocuments: [
      {
        filePath: "memory-bank/agent-runs/alpha.md",
        description: "the alpha notes",
      },
      {
        filePath: "memory-bank/agent-runs/beta.md",
        description: "the beta notes",
      },
    ],
    error: "a distinctive non-default error string",
  });
}

describe("agent-run-records durability contract", () => {
  it("round-trips every persisted durable agent-run key path through the real repo", async () => {
    await assertRoundTripDurability({
      label: "agent-run-records",
      schema: agentRunRecordSchema,
      buildMaximalFixture: buildMaximalRecord,
      persist: (fixture) => {
        // createAgentRunRecord only seeds the create-time columns (inserting as
        // running); the terminal status, results, and completion time reach
        // their columns via updateAgentRunRecord.
        repo.createAgentRunRecord({
          runId: fixture.runId,
          backend: fixture.backend,
          projectName: fixture.projectName,
          sessionName: fixture.sessionName,
          startedAt: fixture.startedAt,
          ownerPid: process.pid,
        });
        repo.updateAgentRunRecord(fixture.runId, {
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
        const expected = repo.getAgentRunRecord(fixture.runId);
        if (expected === null) {
          throw new Error(
            "agent-run-records contract: getAgentRunRecord returned null after create+update",
          );
        }
        return expected;
      },
      reload: (expected) => repo.getAgentRunRecord(expected.runId),
    });
  });
});
