import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendCollaborationArtifact,
  readCollaborationArtifactStream,
} from "./artifacts-store";
import {
  makeAgentOneInitialDraft,
  makeAgentTwoInitialDraft,
} from "./test-fixtures";
import { collaborationArtifactSchema } from "./types";

let configDir: string;

beforeEach(async () => {
  configDir = mkdtempSync(path.join(tmpdir(), "collab-strict-"));
  await mkdir(path.join(configDir, "collab-artifacts"), { recursive: true });
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

function sidecarPath(workflowId: string): string {
  return path.join(configDir, "collab-artifacts", `${workflowId}.jsonl`);
}

describe("readCollaborationArtifactStream", () => {
  it("reports an absent sidecar as absent, not as an empty stream", async () => {
    const outcome = await readCollaborationArtifactStream(
      "never-written",
      collaborationArtifactSchema,
      configDir,
    );
    expect(outcome.kind).toBe("absent");
  });

  it("returns recorded entries in append order", async () => {
    const one = makeAgentOneInitialDraft();
    const two = makeAgentTwoInitialDraft();
    await appendCollaborationArtifact("wf-1", one, configDir);
    await appendCollaborationArtifact("wf-1", two, configDir);

    const outcome = await readCollaborationArtifactStream(
      "wf-1",
      collaborationArtifactSchema,
      configDir,
    );
    expect(outcome).toMatchObject({ kind: "ok", skipped: [] });
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.entries).toEqual([one, two]);
  });

  // The lenient reader drops a bad line and returns the rest, which for a
  // resume would mean silently replaying a stream with a hole in it. The
  // strict reader reports the hole so the ledger can refuse.
  it("reports the true source line index of a malformed line", async () => {
    await appendCollaborationArtifact(
      "wf-2",
      makeAgentOneInitialDraft(),
      configDir,
    );
    writeFileSync(sidecarPath("wf-2"), "{ not json\n", { flag: "a" });
    await appendCollaborationArtifact(
      "wf-2",
      makeAgentTwoInitialDraft(),
      configDir,
    );

    const outcome = await readCollaborationArtifactStream(
      "wf-2",
      collaborationArtifactSchema,
      configDir,
    );
    expect(outcome).toMatchObject({ kind: "ok", skipped: [1] });
  });

  it("reports a schema-invalid line as skipped", async () => {
    await appendCollaborationArtifact(
      "wf-3",
      makeAgentOneInitialDraft(),
      configDir,
    );
    await appendCollaborationArtifact("wf-3", { kind: "nonsense" }, configDir);

    const outcome = await readCollaborationArtifactStream(
      "wf-3",
      collaborationArtifactSchema,
      configDir,
    );
    expect(outcome).toMatchObject({ kind: "ok", skipped: [1] });
  });

  it("distinguishes an unreadable sidecar from an absent one", async () => {
    // A directory where the sidecar file should be: present on disk, but every
    // read of it throws — the shape a transient I/O failure takes.
    await mkdir(sidecarPath("wf-4"), { recursive: true });

    const outcome = await readCollaborationArtifactStream(
      "wf-4",
      collaborationArtifactSchema,
      configDir,
    );
    expect(outcome.kind).toBe("unreadable");
  });
});
