import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAcceptanceEvidenceStore,
  resolveAcceptanceEvidenceRoot,
} from "./evidence";

/**
 * Evidence hygiene for the authenticated acceptance suite (spec R14.2, D19).
 *
 * Raw fixtures are the only complete record of a live run and also the one
 * artifact that could carry a credential, a prompt, or image bytes into a
 * commit. They stay untracked and owner-only; what gets published alongside
 * them is bounded metadata and hashes, and the publish boundary refuses
 * anything else rather than trusting each caller to remember.
 */

const SECRET = { label: "cursor-api-key", value: "key_live_sentinel_77b3ea10" };

function modeOf(target: string): number {
  return statSync(target).mode & 0o777;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cursor-acceptance-evidence-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("acceptance evidence store", () => {
  it("writes raw fixtures owner-only, under an owner-only directory", async () => {
    const store = await createAcceptanceEvidenceStore(root);
    const artifact = await store.writeRaw("native-events.jsonl", "{}\n{}\n");

    expect(modeOf(store.rawDir)).toBe(0o700);
    expect(modeOf(path.join(store.rawDir, "native-events.jsonl"))).toBe(0o600);
    expect(artifact).toEqual({
      name: "native-events.jsonl",
      bytes: 6,
      sha256: createHash("sha256").update("{}\n{}\n", "utf8").digest("hex"),
    });
    expect(await readFile(path.join(store.rawDir, artifact.name), "utf8")).toBe(
      "{}\n{}\n",
    );
  });

  it("publishes bounded metadata and hashes that survive a reload", async () => {
    const store = await createAcceptanceEvidenceStore(root);
    const artifact = await store.writeRaw("run.jsonl", "raw\n");
    const record = {
      caseId: "generation-cancel",
      outcome: "pass" as const,
      metrics: {
        cancelLatencyMs: 412,
        survivingProcesses: 0,
        terminalOutcome: "cancelled",
        replayed: false,
        costUsd: null,
      },
      artifacts: [artifact],
    };

    await store.publish(record);

    expect(modeOf(store.publishedPath)).toBe(0o600);
    expect(await store.readPublished()).toEqual([record]);
  });

  it("refuses to publish a record carrying registered credential material", async () => {
    const store = await createAcceptanceEvidenceStore(root);
    store.registerSecret(SECRET);

    await expect(
      store.publish({
        caseId: "preflight-valid-key",
        outcome: "pass",
        metrics: { observedKey: SECRET.value },
        artifacts: [],
      }),
    ).rejects.toThrow(/credential/i);

    expect(await store.readPublished()).toEqual([]);
  });

  it("refuses an unbounded metric value instead of publishing raw content", async () => {
    const store = await createAcceptanceEvidenceStore(root);

    await expect(
      store.publish({
        caseId: "streaming",
        outcome: "pass",
        metrics: { assistantText: "x".repeat(5_000) },
        artifacts: [],
      }),
    ).rejects.toThrow();

    expect(await store.readPublished()).toEqual([]);
  });

  it("refuses an artifact hash that is not a sha256 digest", async () => {
    const store = await createAcceptanceEvidenceStore(root);

    await expect(
      store.publish({
        caseId: "streaming",
        outcome: "pass",
        metrics: {},
        artifacts: [{ name: "run.jsonl", bytes: 4, sha256: "not-a-digest" }],
      }),
    ).rejects.toThrow();
  });
});

describe("acceptance evidence root", () => {
  it("uses the root the registered command exports", () => {
    expect(
      resolveAcceptanceEvidenceRoot({ CC_CURSOR_ACCEPTANCE_ROOT: root }),
    ).toBe(root);
  });

  it("falls back to a location git refuses to track", () => {
    const fallback = resolveAcceptanceEvidenceRoot({});
    // `check-ignore` exits 0 only when the path is actually ignored, so this
    // fails if the fallback ever moves out from under `.cc/`.
    expect(() =>
      execFileSync("git", ["check-ignore", "-q", fallback], {
        cwd: process.cwd(),
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});
