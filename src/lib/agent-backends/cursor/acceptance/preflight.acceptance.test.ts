import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURSOR_DEFAULT_MODEL } from "../model-policy";
import type { CredentialSecret } from "./credential-scan";
import { scanForCredentials } from "./credential-scan";
import {
  resolveAcceptanceEvidenceRoot,
  type AcceptanceEvidenceStore,
} from "./evidence";
import { openAcceptanceEvidence } from "./harness";
import {
  createLiveHarness,
  frameOfType,
  waitUntil,
  type LiveHarness,
} from "./live-worker";

/**
 * The live credential taxonomy (spec R3.1, R14.2).
 *
 * Three environments have to be distinguishable at the point a worker starts —
 * no credential, a credential the provider rejects, and a working one — and a
 * fourth, subtler one has to be ruled out: an operator whose Cursor CLI is
 * logged in has NOT thereby configured the SDK, and a preflight that accepted
 * ambient CLI authentication would hand that operator a backend that fails at
 * the first turn instead of at configuration time.
 */

let store: AcceptanceEvidenceStore;
let secret: CredentialSecret;
const harnesses: LiveHarness[] = [];

/**
 * What the Cursor CLI (`agent`) on this host reports. "absent" covers a CLI
 * that is not installed or not answering: either way there is no ambient CLI
 * authentication on this host that the SDK could be mistaking for its own.
 */
function readCursorCliAuthState(): "authenticated" | "logged_out" | "absent" {
  let raw: string;
  try {
    raw = execFileSync("agent", ["status", "--format", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return "absent";
  }
  try {
    const payload: unknown = JSON.parse(raw);
    return typeof payload === "object" &&
      payload !== null &&
      Reflect.get(payload, "isAuthenticated") === true
      ? "authenticated"
      : "logged_out";
  } catch {
    return "logged_out";
  }
}

function harnessWith(credential: string | null): LiveHarness {
  const harness = createLiveHarness({
    credential,
    evidenceRoot: resolveAcceptanceEvidenceRoot(process.env),
  });
  harnesses.push(harness);
  return harness;
}

beforeAll(async () => {
  ({ store, secret } = await openAcceptanceEvidence(process.env));
});

afterAll(async () => {
  await Promise.all(harnesses.map((harness) => harness.closeAll()));
});

describe("live CURSOR_API_KEY preflight taxonomy", () => {
  it("refuses an absent credential before any worker process exists", async () => {
    const result = await harnessWith(null).start({
      sessionName: `preflight-absent-${randomUUID()}`,
      model: CURSOR_DEFAULT_MODEL,
    });

    expect(result.kind).toBe("preflight_failed");
    if (result.kind !== "preflight_failed") throw new Error("unreachable");
    expect(result.reason).toBe("missing_credential");
    expect(result.message).toContain("CURSOR_API_KEY");

    await store.publish({
      caseId: "preflight-credential-absent",
      outcome: "pass",
      metrics: {
        kind: result.kind,
        reason: result.reason,
        workerSpawned: false,
      },
      artifacts: [],
    });
  });

  it("treats an empty credential exactly as an absent one", async () => {
    const result = await harnessWith("").start({
      sessionName: `preflight-empty-${randomUUID()}`,
      model: CURSOR_DEFAULT_MODEL,
    });

    expect(result.kind).toBe("preflight_failed");
    if (result.kind !== "preflight_failed") throw new Error("unreachable");
    expect(result.reason).toBe("missing_credential");
  });

  it("rejects a credential the provider refuses, without echoing it", async () => {
    // Shaped like a real key so the refusal comes from the provider rather than
    // from a local format check that would prove nothing about live preflight.
    const bogus = `crsr-acceptance-invalid-${randomUUID().replace(/-/g, "")}`;
    const result = await harnessWith(bogus).start({
      sessionName: `preflight-invalid-${randomUUID()}`,
      model: CURSOR_DEFAULT_MODEL,
    });

    expect(result.kind).toBe("preflight_failed");
    if (result.kind !== "preflight_failed") throw new Error("unreachable");
    expect(result.reason).toBe("invalid_credential");
    expect(
      scanForCredentials(
        [{ label: "bogus-key", value: bogus }],
        [{ label: "preflight-error", text: result.message }],
      ),
      "the rejection echoed the credential it rejected",
    ).toEqual([]);

    await store.publish({
      caseId: "preflight-credential-invalid",
      outcome: "pass",
      metrics: {
        kind: result.kind,
        reason: result.reason,
        credentialEchoed: false,
      },
      artifacts: [],
    });
  });

  it("accepts a valid credential on a create start and again on a resume start", async () => {
    const harness = harnessWith(secret.value);
    const workspace = harness.createWorkspace(
      `preflight-valid-${randomUUID()}`,
    );

    const created = await harness.startReady({
      sessionName: workspace.name,
      model: CURSOR_DEFAULT_MODEL,
      workspace,
    });
    created.attach({
      mode: "create",
      ref: null,
      model: CURSOR_DEFAULT_MODEL,
      mcpServers: {},
    });
    expect(
      await waitUntil(
        () => frameOfType(created.frames, "refIssued") !== undefined,
        60_000,
      ),
    ).toBe(true);
    const ref = frameOfType(created.frames, "refIssued")?.ref;
    expect(ref).toBeTruthy();
    await created.close();

    // The second start is a genuinely separate worker process reached through
    // the resume arm, which is where a credential re-read that regressed to a
    // cached value would show up.
    const resumed = await harness.startReady({
      sessionName: workspace.name,
      model: CURSOR_DEFAULT_MODEL,
      workspace,
    });
    resumed.attach({
      mode: "resume",
      ref: ref ?? "",
      model: CURSOR_DEFAULT_MODEL,
      mcpServers: {},
    });
    expect(
      await waitUntil(
        () => frameOfType(resumed.frames, "attachResult") !== undefined,
        60_000,
      ),
    ).toBe(true);
    expect(frameOfType(resumed.frames, "attachResult")?.outcome).toBe(
      "attached",
    );
    expect(resumed.session.pid).not.toBe(created.session.pid);
    await resumed.close();

    await store.publish({
      caseId: "preflight-credential-valid",
      outcome: "pass",
      metrics: {
        createStart: "ready",
        resumeStart: "ready",
        distinctWorkerProcesses: true,
      },
      artifacts: [],
    });
  });

  it("does not accept ambient host auth — a Cursor CLI included — as SDK authentication", async () => {
    // The strongest form of this claim needs an authenticated Cursor CLI on
    // the host, which only some evidence hosts have. The CLI's state is
    // recorded rather than required, so a host without one still proves the
    // half it can — the SDK finds no ambient credential — and the published
    // record says exactly which form ran. Only the boolean is read from the
    // CLI: its status payload also carries the operator's account identity,
    // which must not reach test output or evidence.
    const cliState = readCursorCliAuthState();

    // The SDK is asked in a child with the credential scrubbed, so what it
    // reports is what an operator relying on ambient host auth alone would
    // get.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env["CURSOR_API_KEY"];
    const sdkStatus = execFileSync(
      process.execPath,
      [
        "-e",
        "import('@cursor/sdk').then(async (m) => { const s = await m.Cursor.auth.status(); console.log(JSON.stringify({ status: s.status })); })",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect(sdkStatus.trim()).toBe('{"status":"logged-out"}');

    await store.publish({
      caseId: "preflight-cli-is-not-sdk-auth",
      outcome: "pass",
      metrics: { cliState, sdkLoggedIn: false },
      artifacts: [],
    });
  });
});
