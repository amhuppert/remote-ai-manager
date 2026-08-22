import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURSOR_DEFAULT_MODEL } from "../model-policy";
import {
  CURSOR_WORKER_PARENT_POLL_INTERVAL_MS,
  CURSOR_WORKER_TERMINATION_GRACE_MS,
} from "../worker/bounds";
import type { CredentialSecret } from "./credential-scan";
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
import { isGroupAlive, isProcessAlive, measureUntil } from "./process-scan";

/**
 * Bounded worker lifetime (spec R9.5, R14.2).
 *
 * A supervised worker is only as safe as its behaviour when nobody is
 * supervising it. Two ways that happens: the server dies without shutting
 * anything down, and a conversation is simply forgotten. In both cases the
 * worker has to end itself within a stated bound rather than sit on the host
 * holding a model session open.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORPHAN_PARENT = path.join(HERE, "orphan-parent-main.ts");

/** The worker polls its parent on this cadence and then takes its own group
 *  down within its termination grace; the bound is the sum plus slack for
 *  process teardown on a loaded host. */
const ORPHAN_BOUND_MS =
  CURSOR_WORKER_PARENT_POLL_INTERVAL_MS +
  CURSOR_WORKER_TERMINATION_GRACE_MS +
  15_000;

const IDLE_TTL_MS = 4_000;
const IDLE_BOUND_MS = IDLE_TTL_MS + 20_000;

let store: AcceptanceEvidenceStore;
let secret: CredentialSecret;
const harnesses: LiveHarness[] = [];

beforeAll(async () => {
  ({ store, secret } = await openAcceptanceEvidence(process.env));
});

afterAll(async () => {
  await Promise.all(harnesses.map((harness) => harness.closeAll()));
});

describe("a Cursor worker whose Command Center server dies", () => {
  it("self-terminates with its process group, within the bound", async () => {
    const evidenceRoot = resolveAcceptanceEvidenceRoot(process.env);
    // The credential reaches the stand-in server under its production name, so
    // the supervisor inside it strips the same key from the worker environment
    // it builds. A fixture-specific variable would have survived that deletion.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CURSOR_API_KEY: secret.value,
      CURSOR_ACCEPTANCE_PARENT_ROOT: evidenceRoot,
      CURSOR_ACCEPTANCE_PARENT_SESSION: `orphan-${randomUUID()}`,
    };

    const parent = spawn(process.execPath, ["--import", "tsx", ORPHAN_PARENT], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    parent.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    try {
      expect(
        await waitUntil(() => stdout.includes("workerPid"), 120_000),
        "the stand-in server never reported a ready worker",
      ).toBe(true);

      const reported: unknown = JSON.parse(
        stdout.trim().split("\n")[0] ?? "{}",
      );
      const workerPid =
        typeof reported === "object" && reported !== null
          ? Reflect.get(reported, "workerPid")
          : null;
      expect(typeof workerPid).toBe("number");
      if (typeof workerPid !== "number") throw new Error("unreachable");
      expect(isProcessAlive(workerPid)).toBe(true);

      // SIGKILL: no handler runs, no shutdown frame is sent, the channel simply
      // dies with the process. This is the case an orderly close cannot cover.
      parent.kill("SIGKILL");

      const goneMs = await measureUntil(
        () => !isProcessAlive(workerPid),
        ORPHAN_BOUND_MS,
      );
      expect(
        goneMs,
        "the worker outlived the server that owned it",
      ).not.toBeNull();
      expect(isGroupAlive(workerPid), "the worker's group survived it").toBe(
        false,
      );

      await store.publish({
        caseId: "orphan-worker-lifetime",
        outcome: "pass",
        metrics: {
          serverKilled: "SIGKILL",
          workerGoneMs: goneMs,
          boundMs: ORPHAN_BOUND_MS,
          groupSurvived: false,
        },
        artifacts: [],
      });
    } finally {
      parent.kill("SIGKILL");
    }
  }, 280_000);
});

describe("a Cursor worker nobody uses", () => {
  it("is reaped within its idle bound", async () => {
    const harness = createLiveHarness({
      credential: secret.value,
      evidenceRoot: resolveAcceptanceEvidenceRoot(process.env),
      bounds: { idleTtlMs: IDLE_TTL_MS },
    });
    harnesses.push(harness);

    const live = await harness.startReady({
      sessionName: `idle-${randomUUID()}`,
      model: CURSOR_DEFAULT_MODEL,
    });
    const pgid = frameOfType(live.frames, "ready")?.pgid ?? live.session.pid;
    expect(isProcessAlive(live.session.pid)).toBe(true);

    // Nothing else is sent: no attach, no turn, no close. The only thing that
    // can end this worker is the idle bound itself.
    const reapedMs = await measureUntil(
      () => !isProcessAlive(live.session.pid),
      IDLE_BOUND_MS,
    );
    expect(reapedMs, "the idle worker was never reaped").not.toBeNull();
    expect(isGroupAlive(pgid)).toBe(false);

    await store.publish({
      caseId: "idle-worker-expiry",
      outcome: "pass",
      metrics: {
        idleTtlMs: IDLE_TTL_MS,
        reapedMs,
        boundMs: IDLE_BOUND_MS,
        groupSurvived: false,
      },
      artifacts: [],
    });
  }, 120_000);
});
