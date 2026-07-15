/**
 * Round-trip tests for the collaboration artifacts sidecar store.
 *
 * These exercise the real filesystem against a fresh temp directory passed as
 * the `configDir` argument (the same seam `transcript.ts` uses), so the
 * append → read → delete cycle runs the actual JSONL serialization and parse
 * paths rather than a fake. No mocking: the store is pure I/O over a real
 * directory.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendCollaborationArtifact,
  deleteCollaborationArtifacts,
  getCollaborationArtifactsPath,
  parseAndValidateArtifactLines,
  readCollaborationArtifacts,
} from "./artifacts-store";
import { collaborationArtifactSchema } from "./types";
import { collaborationWorkflowArtifactEntrySchema } from "./feature-snapshot";
import type { CollaborationArtifact } from "./types";
import type { CollaborationWorkflowArtifactEntry } from "./feature-snapshot";
import {
  makeAgentOneInitialDraft,
  makeAgentOneProposedChanges,
  makeFinalAnswer,
  makeOpenConflicts,
} from "./test-fixtures";

let configDir: string;

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "collab-artifacts-"));
});

afterEach(async () => {
  await fs.rm(configDir, { recursive: true, force: true });
});

const INITIAL_DRAFT: CollaborationArtifact = makeAgentOneInitialDraft({
  summary: "draft narrative",
  assumptions: [],
  key_claims: [],
});

const FINAL_ANSWER: CollaborationArtifact = makeFinalAnswer({
  summary: "the answer",
});

const OPEN_CONFLICTS: CollaborationArtifact = makeOpenConflicts({
  disagreements: [],
  questions: [],
});

describe("collaboration artifacts sidecar store", () => {
  it("appends several artifacts and reads them back in append order", async () => {
    await appendCollaborationArtifact("wf-1", INITIAL_DRAFT, configDir);
    await appendCollaborationArtifact("wf-1", OPEN_CONFLICTS, configDir);
    await appendCollaborationArtifact("wf-1", FINAL_ANSWER, configDir);

    const read = await readCollaborationArtifacts(
      "wf-1",
      collaborationArtifactSchema,
      configDir,
    );

    expect(read.map((a) => a.kind)).toEqual([
      "initial_draft",
      "open_conflicts",
      "final_answer",
    ]);
    // Full value round-trips, not just the discriminant.
    expect(read[2]).toEqual(FINAL_ANSWER);
  });

  it("returns [] when the sidecar file does not exist", async () => {
    const read = await readCollaborationArtifacts(
      "never-written",
      collaborationArtifactSchema,
      configDir,
    );
    expect(read).toEqual([]);
  });

  it("isolates streams by workflowId", async () => {
    await appendCollaborationArtifact("wf-a", INITIAL_DRAFT, configDir);
    await appendCollaborationArtifact("wf-b", FINAL_ANSWER, configDir);

    const a = await readCollaborationArtifacts(
      "wf-a",
      collaborationArtifactSchema,
      configDir,
    );
    const b = await readCollaborationArtifacts(
      "wf-b",
      collaborationArtifactSchema,
      configDir,
    );

    expect(a.map((x) => x.kind)).toEqual(["initial_draft"]);
    expect(b.map((x) => x.kind)).toEqual(["final_answer"]);
  });

  it("deletes the sidecar so a subsequent read returns []", async () => {
    await appendCollaborationArtifact("wf-del", INITIAL_DRAFT, configDir);
    const filePath = await getCollaborationArtifactsPath("wf-del", configDir);
    expect(existsSync(filePath)).toBe(true);

    await deleteCollaborationArtifacts("wf-del", configDir);

    expect(existsSync(filePath)).toBe(false);
    const read = await readCollaborationArtifacts(
      "wf-del",
      collaborationArtifactSchema,
      configDir,
    );
    expect(read).toEqual([]);
  });

  it("does not throw when deleting a sidecar that was never written", async () => {
    await expect(
      deleteCollaborationArtifacts("absent", configDir),
    ).resolves.toBeUndefined();
  });

  it("skips malformed and schema-invalid lines while preserving the valid ones in order", async () => {
    // Write valid lines interleaved with a non-JSON line and a JSON line that
    // fails schema validation, bypassing the typed append to simulate
    // corruption / a foreign producer.
    const filePath = await getCollaborationArtifactsPath("wf-mixed", configDir);
    const lines = [
      JSON.stringify(INITIAL_DRAFT),
      "this-is-not-json{",
      JSON.stringify({ kind: "initial_draft", agent: "not-a-valid-agent" }),
      "",
      JSON.stringify(FINAL_ANSWER),
    ];
    await fs.writeFile(filePath, lines.join("\n") + "\n", "utf-8");

    const read = await readCollaborationArtifacts(
      "wf-mixed",
      collaborationArtifactSchema,
      configDir,
    );

    expect(read.map((a) => a.kind)).toEqual(["initial_draft", "final_answer"]);
  });

  it("reports the TRUE source line index for a schema-invalid line preceded by blank and malformed lines", () => {
    // Line 0: blank. Line 1: valid. Line 2: malformed JSON (parse failure).
    // Line 3: valid JSON but schema-invalid. Line 4: valid.
    // The schema-invalid diagnostic must name source line 3 (not the compacted
    // index 1 it would collapse to after blank/malformed removal), and the
    // parse-failure diagnostic must name source line 2.
    const raw = [
      "",
      JSON.stringify(INITIAL_DRAFT),
      "this-is-not-json{",
      JSON.stringify({ kind: "initial_draft", agent: "not-a-valid-agent" }),
      JSON.stringify(FINAL_ANSWER),
    ].join("\n");

    const result = parseAndValidateArtifactLines(
      raw,
      collaborationArtifactSchema,
    );

    expect(result.entries.map((a) => a.kind)).toEqual([
      "initial_draft",
      "final_answer",
    ]);
    expect(result.parseFailures.map((f) => f.lineIndex)).toEqual([2]);
    expect(result.invalidLines.map((l) => l.lineIndex)).toEqual([3]);
    expect(result.invalidLines[0]!.issues).toContain("agent");
  });

  it("round-trips workflow-path entries through their wrapper schema", async () => {
    const entry: CollaborationWorkflowArtifactEntry = {
      kind: "proposed_changes",
      agent: "agent_one",
      round: 2,
      value: makeAgentOneProposedChanges({
        round: 2,
        summary: "n",
        accepted_from_other_agent_draft: [],
        proposed_changes: [],
        remaining_disagreements: [],
      }),
    };
    await appendCollaborationArtifact("wf-wrap", entry, configDir);

    const read = await readCollaborationArtifacts(
      "wf-wrap",
      collaborationWorkflowArtifactEntrySchema,
      configDir,
    );

    expect(read).toEqual([entry]);
  });
});
