import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  maskSecrets,
  readFileTreeSources,
  readProcessArgvSource,
  readProcessEnvironSource,
  redactBoundaryRecord,
  scanForCredentials,
} from "./credential-scan";

/**
 * The credential-sentinel scan the acceptance harness runs over every boundary
 * a Cursor turn touches (spec R6.2, R14.2).
 *
 * The scan is the only thing standing between "we believe the key never
 * leaked" and evidence, so its own failure modes matter: a scan that cannot
 * read a boundary, or that reports a hit by quoting the secret, would be worse
 * than no scan at all.
 */

const SECRET = { label: "cursor-api-key", value: "key_live_sentinel_4f81ca92" };

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "cursor-credential-scan-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("scanForCredentials", () => {
  it("reports the source and the secret's label, never its value", () => {
    const findings = scanForCredentials(
      [SECRET],
      [{ label: "worker-log", text: `startup ok apiKey=${SECRET.value} done` }],
    );

    expect(findings).toEqual([
      {
        sourceLabel: "worker-log",
        secretLabel: "cursor-api-key",
        variant: "literal",
        occurrences: 1,
      },
    ]);
    expect(JSON.stringify(findings)).not.toContain(SECRET.value);
  });

  it("finds nothing in a clean source", () => {
    expect(
      scanForCredentials(
        [SECRET],
        [{ label: "worker-log", text: "startup ok apiKey=<redacted> done" }],
      ),
    ).toEqual([]);
  });

  it("counts every occurrence so a single hit cannot hide a systemic leak", () => {
    const findings = scanForCredentials(
      [SECRET],
      [{ label: "transcript", text: `${SECRET.value} ${SECRET.value}` }],
    );

    expect(findings.at(0)?.occurrences).toBe(2);
  });

  it("catches a base64-encoded credential, the shape a JSONL store would hold", () => {
    const encoded = Buffer.from(SECRET.value, "utf8").toString("base64");
    const findings = scanForCredentials(
      [SECRET],
      [{ label: "sdk-state", text: `{"token":"${encoded}"}` }],
    );

    expect(findings).toEqual([
      {
        sourceLabel: "sdk-state",
        secretLabel: "cursor-api-key",
        variant: "base64",
        occurrences: 1,
      },
    ]);
  });

  it("refuses a secret too short to make a scan meaningful", () => {
    expect(() =>
      scanForCredentials([{ label: "short", value: "abc" }], []),
    ).toThrow(/too short/i);
  });
});

describe("redactBoundaryRecord", () => {
  it("keeps the key and replaces the value with its size and digest", () => {
    const redacted = redactBoundaryRecord("CC_SESSION=session-4f81");

    expect(redacted).toMatch(
      /^CC_SESSION=<redacted bytes=12 sha256=[0-9a-f]{16}>$/,
    );
    expect(redacted).not.toContain("session-4f81");
  });

  it("redacts a value whose key no allow-list would flag as credential-shaped", () => {
    // The finding this guards: an environment snapshot persisted whole carried
    // third-party keys and connection strings from the server environment. A
    // key-name heuristic cannot enumerate those, so every value goes.
    for (const record of [
      "ELEVENLABS_API_KEY=el_live_9f2c4471aa",
      "BACKEND_DB_URL=postgres://user:hunter2@host/db",
      "SUMMONER_CONFIG=/home/alex/.summoner with spaces",
    ]) {
      const value = record.slice(record.indexOf("=") + 1);
      const redacted = redactBoundaryRecord(record);

      expect(redacted).toContain(`${record.slice(0, record.indexOf("="))}=`);
      expect(redacted).not.toContain(value);
    }
  });

  it("leaves an argv record verbatim so the captured command stays readable", () => {
    // argv is evidence in its own right — the marked shell command is how the
    // cancellation cases identify their descendant.
    const record = "sleep 100000 # cc-cursor-acceptance-shell-1";

    expect(redactBoundaryRecord(record)).toBe(record);
  });

  it("still redacts an inline assignment passed as an argv record", () => {
    expect(
      redactBoundaryRecord("CURSOR_API_KEY=key_live_leaked"),
    ).not.toContain("key_live_leaked");
  });

  it("gives equal values equal digests so a reviewer can correlate boundaries", () => {
    expect(redactBoundaryRecord("A=shared-value")).toBe(
      redactBoundaryRecord("A=shared-value"),
    );
    expect(redactBoundaryRecord("A=shared-value")).not.toBe(
      redactBoundaryRecord("A=other-value"),
    );
  });
});

describe("maskSecrets", () => {
  it("replaces a registered secret with its label so a leak reads as a leak", () => {
    const masked = maskSecrets(`apiKey=${SECRET.value};`, [SECRET]);

    expect(masked).toBe("apiKey=<redacted-secret:cursor-api-key/literal>;");
  });

  it("replaces the base64 spelling as well as the literal one", () => {
    const encoded = Buffer.from(SECRET.value, "utf8").toString("base64");

    expect(maskSecrets(`{"token":"${encoded}"}`, [SECRET])).toBe(
      '{"token":"<redacted-secret:cursor-api-key/base64>"}',
    );
  });

  it("leaves clean text untouched", () => {
    expect(maskSecrets("apiKey=<redacted>", [SECRET])).toBe(
      "apiKey=<redacted>",
    );
  });
});

describe("process boundary sources", () => {
  it("exposes the NUL-delimited records so each value can be redacted exactly", async () => {
    // `/proc` stores argv and environ as NUL-separated records. Values contain
    // spaces, so a snapshot joined into one string cannot be split back apart —
    // the records have to survive the read for redaction to be exact.
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)"],
      {
        env: { ...process.env, CURSOR_SCAN_SPACED: "a value with spaces" },
      },
    );
    const pid = child.pid;
    if (pid === undefined) throw new Error("the fixture child did not start");

    try {
      const environ = await readProcessEnvironSource(pid);

      expect(environ.records).toContain(
        "CURSOR_SCAN_SPACED=a value with spaces",
      );
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("reads a child's argv and environment without reading its secret into a label", async () => {
    const marker = "cursor-scan-fixture-marker";
    const child = spawn(
      process.execPath,
      ["-e", `setTimeout(() => {}, 60000); // ${marker}`],
      { env: { ...process.env, CURSOR_SCAN_FIXTURE: SECRET.value } },
    );
    const pid = child.pid;
    if (pid === undefined) throw new Error("the fixture child did not start");

    try {
      const argv = await readProcessArgvSource(pid);
      const environ = await readProcessEnvironSource(pid);

      expect(argv.text).toContain(marker);
      expect(scanForCredentials([SECRET], [argv])).toEqual([]);
      // The environment genuinely carries the value here, which is exactly the
      // condition the acceptance scan must be able to detect on a real worker.
      expect(scanForCredentials([SECRET], [environ])).toEqual([
        {
          sourceLabel: environ.label,
          secretLabel: "cursor-api-key",
          variant: "literal",
          occurrences: 1,
        },
      ]);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("reports an unreadable process as an explicitly empty source rather than throwing", async () => {
    // A pid that has already exited: the scan must not turn a race with process
    // teardown into a suite error.
    const source = await readProcessEnvironSource(2 ** 22 - 1);
    expect(source.text).toBe("");
  });
});

describe("readFileTreeSources", () => {
  it("covers every file in the tree, including nested state", async () => {
    mkdirSync(path.join(workdir, "store", "runs"), { recursive: true });
    writeFileSync(path.join(workdir, "top.log"), "clean\n", "utf8");
    writeFileSync(
      path.join(workdir, "store", "runs", "agent.jsonl"),
      `{"apiKey":"${SECRET.value}"}\n`,
      "utf8",
    );

    const sources = await readFileTreeSources(workdir);
    const findings = scanForCredentials([SECRET], sources);

    expect(sources.map((source) => source.label).sort()).toEqual([
      "store/runs/agent.jsonl",
      "top.log",
    ]);
    expect(findings.map((finding) => finding.sourceLabel)).toEqual([
      "store/runs/agent.jsonl",
    ]);
  });

  it("returns no sources for a tree that does not exist", async () => {
    expect(await readFileTreeSources(path.join(workdir, "absent"))).toEqual([]);
  });
});
