import { statSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CURSOR_DEFAULT_MODEL } from "../model-policy";
import {
  createCursorPackageProbe,
  runCursorStaticPreflight,
} from "../preflight";
import {
  CURSOR_SDK_PACKAGE,
  CURSOR_SDK_PINNED_VERSION,
  CURSOR_SDK_PLATFORM_PACKAGE,
  CURSOR_SDK_TESTED_ARCH,
  CURSOR_SDK_TESTED_PLATFORM,
} from "../sdk-pin";
import { loadCursorWorkerSdk } from "../worker/sdk-port";
import {
  readFileTreeSources,
  scanForCredentials,
  type CredentialSecret,
} from "./credential-scan";
import {
  resolveAcceptanceEvidenceRoot,
  type AcceptanceEvidenceStore,
} from "./evidence";
import { openAcceptanceEvidence } from "./harness";

/**
 * The harness's own acceptance case (spec R14.2, D19).
 *
 * Before any live matrix case is worth reading, three things have to be true of
 * the run that produced it: a real credential was present, the host really is
 * the pinned baseline the capability claims rest on, and the evidence the suite
 * writes is owner-only and free of credential material. Each of those is
 * checked here against the real environment rather than asserted in prose at
 * the top of an evidence document.
 */

let store: AcceptanceEvidenceStore;
let secret: CredentialSecret;

beforeAll(async () => {
  ({ store, secret } = await openAcceptanceEvidence(process.env));
});

function modeOf(target: string): number {
  return statSync(target).mode & 0o777;
}

describe("acceptance harness", () => {
  it("runs on a credential the live SDK accepts", async () => {
    expect(secret.value.length).toBeGreaterThanOrEqual(8);

    // The gate that keeps this suite honest. Everything else in the harness —
    // the baseline probe, the evidence modes, the scan — passes on a
    // placeholder string, so without this the whole acceptance command could
    // report green in an environment that can reach no Cursor account at all.
    // Verified through the same port the worker authenticates with, and the
    // account payload is discarded rather than published.
    const sdk = await loadCursorWorkerSdk();
    await expect(sdk.verifyCredential(secret.value)).resolves.toBeUndefined();

    await store.publish({
      caseId: "credential-live",
      outcome: "pass",
      metrics: { authenticated: true },
      artifacts: [],
    });
  });

  it("runs on the pinned Linux/Node/SDK/model baseline", async () => {
    const result = await runCursorStaticPreflight(
      { model: CURSOR_DEFAULT_MODEL },
      {
        packages: createCursorPackageProbe(
          path.join(process.cwd(), "node_modules"),
        ),
        host: { platform: process.platform, arch: process.arch },
        workerNodeVersion: async () => process.version,
      },
    );

    if (!result.ok) {
      throw new Error(
        `the acceptance host is not the pinned baseline: ${result.code} — ${result.message}`,
      );
    }
    expect(result.diagnostics).toMatchObject({
      sdkPackage: CURSOR_SDK_PACKAGE,
      installedSdkVersion: CURSOR_SDK_PINNED_VERSION,
      platformPackage: CURSOR_SDK_PLATFORM_PACKAGE,
      installedPlatformVersion: CURSOR_SDK_PINNED_VERSION,
      host: `${CURSOR_SDK_TESTED_PLATFORM}-${CURSOR_SDK_TESTED_ARCH}`,
      model: CURSOR_DEFAULT_MODEL,
    });

    await store.publish({
      caseId: "baseline",
      outcome: "pass",
      metrics: {
        sdkVersion: result.diagnostics.installedSdkVersion,
        platformVersion: result.diagnostics.installedPlatformVersion,
        host: result.diagnostics.host,
        nodeVersion: result.diagnostics.nodeVersion,
        model: result.diagnostics.model,
      },
      artifacts: [],
    });
  });

  it("refuses to publish the live credential", async () => {
    await expect(
      store.publish({
        caseId: "harness-credential-guard",
        outcome: "pass",
        metrics: { observed: secret.value },
        artifacts: [],
      }),
    ).rejects.toThrow(/credential/i);
  });

  it("keeps raw evidence owner-only and the whole evidence root credential-free", async () => {
    const artifact = await store.writeRaw(
      "harness-baseline.json",
      `${JSON.stringify({ node: process.version, sdk: CURSOR_SDK_PINNED_VERSION })}\n`,
    );

    expect(modeOf(store.rawDir)).toBe(0o700);
    expect(modeOf(path.join(store.rawDir, artifact.name))).toBe(0o600);
    expect(modeOf(store.publishedPath)).toBe(0o600);

    const root = resolveAcceptanceEvidenceRoot(process.env);
    const findings = scanForCredentials(
      [secret],
      await readFileTreeSources(root),
    );
    expect(findings).toEqual([]);

    await store.publish({
      caseId: "evidence-hygiene",
      outcome: "pass",
      metrics: {
        rawDirMode: "0700",
        publishedMode: "0600",
        credentialFindings: findings.length,
      },
      artifacts: [artifact],
    });
  });
});
