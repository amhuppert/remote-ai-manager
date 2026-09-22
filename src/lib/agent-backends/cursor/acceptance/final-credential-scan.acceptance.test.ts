import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { getDefaultSdkAuthPath, getDefaultSdkStateRoot } from "@cursor/sdk";
import type { CredentialSecret, ScanSource } from "./credential-scan";
import {
  MIN_SCANNABLE_SECRET_LENGTH,
  readFileTreeSources,
  scanForCredentials,
} from "./credential-scan";
import {
  createAcceptanceEvidenceStore,
  resolveAcceptanceEvidenceRoot,
  type AcceptanceEvidenceStore,
} from "./evidence";
import {
  ACCEPTANCE_BOUNDARY_ARTIFACT_PREFIX,
  openAcceptanceEvidence,
} from "./harness";
import { CURSOR_PARITY_MATRIX } from "./parity-matrix";
import { ambientCredentialKeys } from "../worker/credential-env";
import { findMarkedPids } from "./process-scan";

/**
 * The closing sweep over everything the live matrix produced (spec R6.2,
 * R14.2).
 *
 * Every earlier case checks the boundary it owns. This one runs last and asks
 * the question once more over the whole accumulated surface — worker logs,
 * transcripts, caller-owned SDK stores, workspaces, raw fixtures and published
 * records — plus the SDK's own default state root, which is the one place a
 * credential could have been persisted outside Command Center's ownership.
 *
 * It also re-reads the published evidence through the bounded schema, so
 * "published output carries only bounded metadata and hashes" is verified
 * against the file that will actually be read, not against the intent of the
 * code that wrote it.
 */

let store: AcceptanceEvidenceStore;
let secret: CredentialSecret;
let evidenceRoot: string;
let sources: readonly ScanSource[];
let defaultStateRoots: readonly string[];

/** The argv/environ captures the live cases persisted while their processes
 *  were still alive. */
function boundarySnapshots(): readonly ScanSource[] {
  return sources.filter((source) =>
    source.label.startsWith(`raw/${ACCEPTANCE_BOUNDARY_ARTIFACT_PREFIX}`),
  );
}

/** Markers the cancellation and MCP cases planted on the host. */
const HOST_MARKERS = [
  "cc-cursor-acceptance-shell-",
  "cc-cursor-acceptance-mcp-",
];

/**
 * Every credential-shaped value in the environment this run inherited.
 *
 * The names come from `ambientCredentialKeys` — the same rule the supervisor
 * strips a worker environment by — so the sweep looks for exactly what
 * production claims to withhold rather than for a definition of its own.
 * Labelled by variable name: a name is not a secret, and a finding must never
 * quote the value.
 */
function ambientCredentials(): readonly CredentialSecret[] {
  return ambientCredentialKeys(process.env).flatMap((key) => {
    const value = process.env[key];
    return value !== undefined &&
      // The scan's own floor for a value long enough that a hit is a leak
      // rather than a coincidence.
      value.length >= MIN_SCANNABLE_SECRET_LENGTH
      ? [{ label: `env:${key}`, value }]
      : [];
  });
}

beforeAll(async () => {
  ({ store, secret } = await openAcceptanceEvidence(process.env));
  evidenceRoot = resolveAcceptanceEvidenceRoot(process.env);

  const collected: ScanSource[] = [
    ...(await readFileTreeSources(evidenceRoot)),
  ];

  // The SDK's own credential store, outside Command Center's ownership. Every
  // conversation authenticated through the explicit `apiKey` option, so the SDK
  // should never have written a key here.
  const authPath = getDefaultSdkAuthPath();
  if (existsSync(authPath)) {
    collected.push({
      label: "sdk-auth-path",
      text: await readFile(authPath, "utf8"),
    });
  }

  // Where the SDK would have put this run's agent state had Command Center not
  // supplied a store. Computed per workspace the matrix created, so the check
  // is exact rather than a sweep of the user's whole Cursor directory.
  defaultStateRoots = (
    await readdir(path.join(evidenceRoot, "workspaces"), {
      withFileTypes: true,
    }).catch(() => [])
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      getDefaultSdkStateRoot(
        path.join(evidenceRoot, "workspaces", entry.name, "workspace"),
      ),
    );

  sources = collected;
});

describe("final credential sweep over the live matrix", () => {
  it("scanned a surface that actually contains this run's output", () => {
    // A clean scan over nothing would be the easiest way to pass this file.
    expect(sources.length).toBeGreaterThan(0);
    expect(
      sources.some((source) => source.label.startsWith("raw/")),
      "no raw fixtures were scanned",
    ).toBe(true);
    expect(
      sources.some((source) => source.label.includes("logs/")),
      "no worker logs were scanned",
    ).toBe(true);
    expect(
      sources.some((source) => source.label.includes("store")),
      "no caller-owned SDK state was scanned",
    ).toBe(true);
  });

  it("covers the argv and environment of the live processes the run created", () => {
    // `/proc` entries are gone by the time this file runs, so the live cases
    // captured each process boundary while it existed and persisted the exact
    // bytes here. This asserts those snapshots are present and non-empty —
    // otherwise the sweep below would be scanning files only, and argv and
    // child environments would go unchecked.
    const snapshots = boundarySnapshots();
    expect(
      snapshots.length,
      "no process-boundary snapshot was captured by any live case",
    ).toBeGreaterThanOrEqual(3);

    const combined = snapshots.map((source) => source.text).join("\n");
    expect(
      (combined.match(/^### pid:\d+\/argv records=\d+ /gm) ?? []).length,
      "no argv boundary was captured",
    ).toBeGreaterThan(0);
    expect(
      (combined.match(/^### pid:\d+\/environ records=\d+ /gm) ?? []).length,
      "no process environment was captured",
    ).toBeGreaterThan(0);
    // A worker group carries the Command Center session contract, so a real
    // environment capture must show it. An empty snapshot would pass a scan.
    expect(combined).toContain("CC_SESSION=");
    // Every block carries the verdict of the live scan that produced it, so the
    // artifact still proves the boundary was checked while it existed.
    expect(
      combined.match(/credentialFindings=(?!0$)\d+/gm) ?? [],
      "a captured boundary recorded a credential finding",
    ).toEqual([]);
  });

  it("persisted environment keys without their values", () => {
    // The evidence tree is owner-only, but it is still an artifact, and a
    // worker inherits the server environment: writing those environments out
    // whole would put every third-party credential on the host into the very
    // files that exist to prove credential material stays out.
    const environBlocks = boundarySnapshots()
      .flatMap((source) => source.text.split(/^### /m))
      .filter((block) => /^pid:\d+\/environ /.test(block));
    expect(
      environBlocks.length,
      "no environment block was persisted",
    ).toBeGreaterThan(0);

    const assignments = environBlocks.flatMap((block) =>
      // Line 0 is the block's own header; the rest are the captured records.
      block
        .split("\n")
        .slice(1)
        .filter((line) => line.length > 0),
    );
    expect(assignments.length).toBeGreaterThan(0);
    for (const assignment of assignments) {
      expect(assignment, "an environment value was persisted verbatim").toMatch(
        /^[A-Za-z_][A-Za-z0-9_]*=<redacted bytes=\d+ sha256=[0-9a-f]{16}>$/,
      );
    }
  });

  it("finds no third-party credential from the server environment either", () => {
    // Broader than the registered Cursor key on purpose: the guarantee the
    // evidence tree has to carry is that it holds no credential material, not
    // that it holds no *Cursor* credential material.
    const ambient = ambientCredentials();
    // The run's own credential is itself credential-shaped, so a set that has
    // lost it means the collection stopped working — not that the host is
    // unusually clean. Guarding on the count alone would pass either way.
    expect(
      ambient.map((entry) => entry.label),
      "the scanned set no longer contains the run's own credential",
    ).toContain("env:CURSOR_API_KEY");

    const findings = scanForCredentials(ambient, sources);
    expect(
      findings.map(
        (finding) => `${finding.sourceLabel} (${finding.secretLabel})`,
      ),
    ).toEqual([]);
  });

  it("finds no credential material anywhere the run wrote", () => {
    const findings = scanForCredentials([secret], sources);
    // Reported by label: a failure here names the boundary that leaked, never
    // the value that leaked through it.
    expect(
      findings.map((finding) => `${finding.sourceLabel} (${finding.variant})`),
    ).toEqual([]);
  });

  it("produced a passing record for every live case the parity matrix cites", async () => {
    // The matrix names the live evidence each parity row rests on. Checking
    // those names against the records this run actually published is what
    // makes the matrix executable against the run rather than against the
    // source: a case that was renamed, skipped, or quietly failed stops
    // supporting its row here, while the suite still has a credential.
    const published = await store.readPublished();
    const byCaseId = new Map(
      published.map((record) => [record.caseId, record.outcome]),
    );
    const cited = [
      ...new Set(
        CURSOR_PARITY_MATRIX.flatMap((row) =>
          row.evidence.flatMap((entry) =>
            entry.kind === "acceptance-case" ? [entry.caseId] : [],
          ),
        ),
      ),
    ].sort();
    expect(cited.length, "the matrix cites no live evidence").toBeGreaterThan(
      0,
    );
    expect(
      cited.filter((caseId) => byCaseId.get(caseId) !== "pass"),
      "a parity row cites live evidence this run did not produce as a pass",
    ).toEqual([]);
  });

  it("publishes only bounded metadata and hashes", async () => {
    // Re-read through the schema that bounds it, so the claim is about the file
    // a reviewer will open rather than about the writer's intent.
    const published = await store.readPublished();
    expect(published.length).toBeGreaterThan(0);
    for (const record of published) {
      for (const [key, value] of Object.entries(record.metrics)) {
        if (typeof value !== "string") continue;
        expect(
          value.length,
          `${record.caseId}.${key} is not bounded metadata`,
        ).toBeLessThanOrEqual(200);
      }
      for (const artifact of record.artifacts) {
        expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(
          existsSync(path.join(store.rawDir, artifact.name)),
          `${record.caseId} published a digest for a fixture that is not there`,
        ).toBe(true);
      }
    }
  });

  it("leaves no marked worker, tool, or MCP process on the host", () => {
    for (const marker of HOST_MARKERS) {
      expect(findMarkedPids(marker), `${marker} left a survivor`).toEqual([]);
    }
  });

  it("persisted no agent state outside Command Center's ownership", () => {
    expect(
      defaultStateRoots.length,
      "no workspace was checked, so this proves nothing",
    ).toBeGreaterThan(0);
    // Every conversation ran with a caller-owned store, so the SDK's default
    // per-workspace root must not exist for any of them.
    expect(defaultStateRoots.filter((root) => existsSync(root))).toEqual([]);
  });

  it("records the sweep", async () => {
    // A fresh store: publishing the sweep through the same guarded boundary
    // every other case used, with the live credential registered.
    const sweepStore = await createAcceptanceEvidenceStore(evidenceRoot);
    sweepStore.registerSecret(secret);
    await sweepStore.publish({
      caseId: "final-credential-sweep",
      outcome: "pass",
      metrics: {
        scannedSources: sources.length,
        processBoundarySnapshots: boundarySnapshots().length,
        findings: 0,
        // The scan covers every credential-shaped variable the run inherited,
        // not only the Cursor key: the count is what makes that claim legible
        // to a reviewer, and a variable NAME is not credential material.
        ambientCredentialsScanned: ambientCredentials().length,
        ambientCredentialFindings: 0,
        workspacesChecked: defaultStateRoots.length,
        defaultStateRootsCreated: 0,
        sdkAuthPathScanned: existsSync(getDefaultSdkAuthPath()),
        survivingMarkedProcesses: 0,
      },
      artifacts: [],
    });
  });
});
