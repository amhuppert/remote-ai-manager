import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ARTIFACT_DIR,
  STDOUT_BUDGET_BYTES,
  boundedRows,
  emitLarge,
  omissionSchema,
  omissionSummary,
} from "./disclosure";
import type { CliHost } from "./shared";

interface WritingHost {
  readonly host: CliHost;
  readonly written: Map<string, string>;
}

function makeHost(
  options: {
    readonly write?: (filePath: string, content: string) => Promise<void>;
    readonly canWrite?: boolean;
  } = {},
): WritingHost {
  const written = new Map<string, string>();
  const base = {
    fetch: async () => new Response("{}", { status: 200 }),
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  } satisfies CliHost;
  if (options.canWrite === false) return { host: base, written };
  return {
    host: {
      ...base,
      writeTextFile:
        options.write ??
        (async (filePath: string, content: string) => {
          written.set(filePath, content);
        }),
    },
    written,
  };
}

describe("boundedRows", () => {
  it("reports the counts and names no rest when the set fits the cap", () => {
    const bounded = boundedRows(["a", "b", "c"], 3, "cctl spec show demo");

    expect(bounded.rows).toEqual(["a", "b", "c"]);
    expect(bounded.lines).toEqual(["a", "b", "c", "3 total, 3 shown"]);
    expect(bounded.omission).toEqual({
      total: 3,
      returned: 3,
      truncated: false,
    });
  });

  it("caps the rows and closes with the exact command that reveals the rest", () => {
    const rows = Array.from({ length: 14 }, (_, index) => `row ${index + 1}`);

    const bounded = boundedRows(rows, 10, "cctl spec status demo --json");

    expect(bounded.rows).toHaveLength(10);
    expect(bounded.rows.at(-1)).toBe("row 10");
    expect(bounded.lines.at(-1)).toBe(
      "14 total, 10 shown — rest: cctl spec status demo --json",
    );
    expect(bounded.omission).toEqual({
      total: 14,
      returned: 10,
      truncated: true,
      reveal: "cctl spec status demo --json",
    });
  });

  it("treats the cap as an exclusive boundary on row count", () => {
    const rows = Array.from({ length: 11 }, (_, index) => `row ${index}`);

    expect(boundedRows(rows.slice(0, 10), 10, "reveal").omission).toEqual({
      total: 10,
      returned: 10,
      truncated: false,
    });
    expect(boundedRows(rows, 10, "reveal").omission).toEqual({
      total: 11,
      returned: 10,
      truncated: true,
      reveal: "reveal",
    });
  });

  it("counts rows, never the lines inside a multi-line row", () => {
    const bounded = boundedRows(
      ["task-1\n  depends on: none", "task-2\n  depends on: task-1"],
      1,
      "cctl spec show demo",
    );

    expect(bounded.omission).toEqual({
      total: 2,
      returned: 1,
      truncated: true,
      reveal: "cctl spec show demo",
    });
    expect(bounded.rows).toEqual(["task-1\n  depends on: none"]);
  });

  it("refuses a cap that discloses nothing", () => {
    expect(() => boundedRows(["a", "b"], 2, "   ")).toThrow(/reveal/u);
    expect(() => boundedRows(["a", "b"], 0, "cctl spec show demo")).toThrow(
      /cap/u,
    );
  });

  it("renders the same facts in text and in a JSON envelope", () => {
    const bounded = boundedRows(["a", "b", "c"], 2, "cctl ticket list --all");
    const envelope: unknown = JSON.parse(
      JSON.stringify({ ok: true, ...bounded.omission }),
    );

    expect(omissionSchema.parse(bounded.omission)).toEqual(bounded.omission);
    expect(envelope).toEqual({
      ok: true,
      total: 3,
      returned: 2,
      truncated: true,
      reveal: "cctl ticket list --all",
    });
    expect(omissionSummary(bounded.omission)).toBe(bounded.lines.at(-1));
    expect(bounded.lines.at(-1)).toBe(
      "3 total, 2 shown — rest: cctl ticket list --all",
    );
  });

  it("makes a truncated omission without a reveal unparseable", () => {
    expect(
      omissionSchema.safeParse({ total: 9, returned: 2, truncated: true })
        .success,
    ).toBe(false);
    expect(
      omissionSchema.safeParse({
        total: 9,
        returned: 2,
        truncated: true,
        reveal: "",
      }).success,
    ).toBe(false);
  });
});

describe("emitLarge", () => {
  it("keeps content inline while it fits the budget", async () => {
    const { host, written } = makeHost();

    const outcome = await emitLarge(host, "small payload\n", {
      format: "json",
    });

    expect(outcome).toEqual({ kind: "inline", text: "small payload\n" });
    expect(written.size).toBe(0);
  });

  it("spills once the content reaches the budget, and not one byte earlier", async () => {
    const { host } = makeHost();
    const budgetBytes = 64;

    const fits = await emitLarge(host, "x".repeat(budgetBytes - 1), {
      format: "json",
      budgetBytes,
    });
    const spills = await emitLarge(host, "x".repeat(budgetBytes), {
      format: "json",
      budgetBytes,
    });

    expect(fits.kind).toBe("inline");
    expect(spills.kind).toBe("artifact");
  });

  it("defaults the budget to 60000 bytes and the directory to .cc/temp", async () => {
    const { host, written } = makeHost();
    const content = "y".repeat(STDOUT_BUDGET_BYTES);

    const outcome = await emitLarge(host, content, { format: "json" });

    expect(STDOUT_BUDGET_BYTES).toBe(60_000);
    expect(ARTIFACT_DIR).toBe(".cc/temp");
    if (outcome.kind !== "artifact") throw new Error("expected an artifact");
    expect(outcome.manifest.path.startsWith(".cc/temp/")).toBe(true);
    expect(written.get(outcome.manifest.path)).toBe(content);
  });

  it("receipts the artifact with its own byte count and content digest", async () => {
    const { host, written } = makeHost();
    // Multi-byte content: a byte count taken from string length would be short.
    const content = `${"é".repeat(40)}\n`;

    const outcome = await emitLarge(host, content, {
      format: "markdown",
      budgetBytes: 16,
      dir: ".cc/scratch",
      namePrefix: "spec-outline",
    });

    if (outcome.kind !== "artifact") throw new Error("expected an artifact");
    const digest = createHash("sha256").update(content, "utf8").digest("hex");
    expect(outcome.manifest).toEqual({
      path: `.cc/scratch/spec-outline-${digest.slice(0, 12)}.md`,
      format: "markdown",
      bytes: Buffer.byteLength(content, "utf8"),
      sha256: `sha256:${digest}`,
      reason: "stdout_budget_exceeded",
    });
    expect(written.get(outcome.manifest.path)).toBe(content);
  });

  it("writes to a caller-selected path on request, whatever the budget says", async () => {
    const { host, written } = makeHost();

    const outcome = await emitLarge(host, "tiny\n", {
      format: "markdown",
      force: "requested",
      path: "out/report.md",
    });

    if (outcome.kind !== "artifact") throw new Error("expected an artifact");
    expect(outcome.manifest.path).toBe("out/report.md");
    expect(outcome.manifest.reason).toBe("requested");
    expect(written.get("out/report.md")).toBe("tiny\n");
  });

  it("records a caller-measured budget overrun as the forced reason", async () => {
    const { host } = makeHost();

    const outcome = await emitLarge(host, "tiny\n", {
      format: "json",
      force: "stdout_budget_exceeded",
      namePrefix: "spec-outline",
    });

    if (outcome.kind !== "artifact") throw new Error("expected an artifact");
    expect(outcome.manifest.reason).toBe("stdout_budget_exceeded");
    expect(outcome.manifest.path.startsWith(".cc/temp/spec-outline-")).toBe(
      true,
    );
  });

  it("reports a host that cannot write rather than dropping the content", async () => {
    const { host } = makeHost({ canWrite: false });

    const outcome = await emitLarge(host, "z".repeat(64), {
      format: "json",
      budgetBytes: 16,
    });

    if (outcome.kind !== "unwritable") throw new Error("expected a refusal");
    expect(outcome.reason).toBe("host_cannot_write");
    expect(outcome.path.startsWith(".cc/temp/")).toBe(true);
  });

  it("reports a failed write with the path it attempted", async () => {
    const { host } = makeHost({
      write: async () => {
        throw new Error("EACCES");
      },
    });

    const outcome = await emitLarge(host, "z".repeat(64), {
      format: "json",
      force: "requested",
      path: "/read-only/report.json",
    });

    expect(outcome).toEqual({
      kind: "unwritable",
      reason: "write_failed",
      path: "/read-only/report.json",
    });
  });
});
