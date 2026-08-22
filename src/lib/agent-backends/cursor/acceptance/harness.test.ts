import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CredentialFinding } from "./credential-scan";
import { createAcceptanceEvidenceStore } from "./evidence";
import {
  captureProcessBoundaries,
  requireAcceptanceCredential,
} from "./harness";

/**
 * The in-suite half of the credential gate, and the redaction boundary every
 * captured process snapshot passes through (spec R6.2, R14.2, D19).
 *
 * The registered command refuses before Vitest starts, but an acceptance file
 * reached any other way — a bare `vitest run`, an IDE run button — must fail
 * loudly rather than pass on an empty matrix.
 */

const SENTINEL = "key_live_acceptance_sentinel_2b7e";

describe("requireAcceptanceCredential", () => {
  it("fails loudly rather than skipping when CURSOR_API_KEY is absent", () => {
    expect(() => requireAcceptanceCredential({})).toThrow(/CURSOR_API_KEY/);
  });

  it("treats an empty credential as absent", () => {
    expect(() => requireAcceptanceCredential({ CURSOR_API_KEY: "  " })).toThrow(
      /CURSOR_API_KEY/,
    );
  });

  it("labels the credential for scanning without renaming its value", () => {
    expect(requireAcceptanceCredential({ CURSOR_API_KEY: SENTINEL })).toEqual({
      label: "cursor-api-key",
      value: SENTINEL,
    });
  });
});

describe("captureProcessBoundaries", () => {
  /** An unrelated third-party credential of the kind a server environment
   *  carries and the registered Cursor scan knows nothing about. */
  const AMBIENT_SECRET = "el_live_ambient_a91f77c4be";
  const MARKER = "cc-cursor-harness-boundary-fixture";

  let root: string;
  let children: ChildProcess[];

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "cursor-boundary-"));
    children = [];
  });

  afterEach(() => {
    for (const child of children) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * A child with an EXPLICIT environment rather than an inherited one, so the
   * cases mean the same thing on a developer machine carrying real keys and on
   * a bare CI host carrying none.
   */
  function startChild(env: Record<string, string>): number {
    // NODE_ENV is required by the Next.js `ProcessEnv` augmentation, so the
    // explicit environment states it rather than inheriting one.
    const childEnv: NodeJS.ProcessEnv = { NODE_ENV: "test", ...env };
    const child: ChildProcess = spawn(
      process.execPath,
      ["-e", `setTimeout(() => {}, 60000); // ${MARKER}`],
      { env: childEnv },
    );
    children.push(child);
    const pid = child.pid;
    if (pid === undefined) throw new Error("the fixture child did not start");
    return pid;
  }

  async function capture(
    pid: number,
    ambientEnv: Record<string, string | undefined> = {},
  ): Promise<{
    text: string;
    findings: number;
    ambientFindings: readonly CredentialFinding[];
  }> {
    const store = await createAcceptanceEvidenceStore(root);
    const secret = { label: "cursor-api-key", value: SENTINEL };
    store.registerSecret(secret);
    const captured = await captureProcessBoundaries({
      store,
      secret,
      ambientEnv,
      label: "fixture",
      pgids: [],
      extraPids: [pid],
    });
    return {
      text: readFileSync(
        path.join(store.rawDir, captured.artifact.name),
        "utf8",
      ),
      findings: captured.findings.length,
      ambientFindings: captured.ambientFindings,
    };
  }

  it("persists environment keys but never their values", async () => {
    // The finding this guards: the snapshot was written whole, so every
    // credential the server environment carried reached a raw evidence file
    // while the scan — which knows only the Cursor key — reported it clean.
    const pid = startChild({ ELEVENLABS_API_KEY: AMBIENT_SECRET });

    const { text, findings } = await capture(pid);

    expect(text).toContain("ELEVENLABS_API_KEY=");
    expect(
      text,
      "an unrelated credential reached the evidence tree",
    ).not.toContain(AMBIENT_SECRET);
    expect(findings).toBe(0);
  });

  it("keeps the captured command line readable", async () => {
    const pid = startChild({});

    expect((await capture(pid)).text).toContain(MARKER);
  });

  it("records the scan verdict per boundary so the artifact stays auditable", async () => {
    const pid = startChild({});

    const { text } = await capture(pid);

    expect(text).toMatch(
      new RegExp(
        `^### pid:${pid}/environ records=\\d+ credentialFindings=0$`,
        "m",
      ),
    );
  });

  it("reports an ambient credential in a child environment as a finding", async () => {
    // Redacting the persisted snapshot closed the artifact leak but would blind
    // a scan that only ever ran over the artifact. The live capture therefore
    // scans /proc for every credential-shaped variable the run inherited, not
    // just the Cursor key — otherwise a worker or tool child could carry the
    // server's other credentials and the run would still report zero findings.
    const pid = startChild({ ELEVENLABS_API_KEY: AMBIENT_SECRET });

    const { text, findings, ambientFindings } = await capture(pid, {
      ELEVENLABS_API_KEY: AMBIENT_SECRET,
    });

    expect(ambientFindings.map((finding) => finding.secretLabel)).toContain(
      "env:ELEVENLABS_API_KEY",
    );
    // Still the Cursor-key verdict on its own axis, and still nothing on disk.
    expect(findings).toBe(0);
    expect(text).not.toContain(AMBIENT_SECRET);
  });

  it("reports no ambient finding for a child the supervisor stripped", async () => {
    // What a real worker looks like once `withoutAmbientCredentials` has run:
    // the server holds the credential, the child does not.
    const pid = startChild({ PATH: "/usr/bin" });

    expect(
      (await capture(pid, { ELEVENLABS_API_KEY: AMBIENT_SECRET }))
        .ambientFindings,
    ).toEqual([]);
  });

  it("reports a registered secret as a finding without writing it to disk", async () => {
    // The leak the suite exists to catch. It must be visible in the artifact as
    // a leak, and countable by the caller, without the value itself landing.
    const pid = startChild({ CURSOR_API_KEY: SENTINEL });

    const { text, findings } = await capture(pid);

    expect(findings).toBeGreaterThan(0);
    expect(text).not.toContain(SENTINEL);
  });
});
