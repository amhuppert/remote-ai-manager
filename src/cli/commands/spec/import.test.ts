import { describe, expect, it } from "vitest";

import { importBundleSchema } from "@/lib/specs/schemas";
import { runCli } from "../../core";
import type { CliEnv, CliHost, FetchInit } from "../../shared";

const BUNDLE_FILE = "/tmp/import-bundle.json";
const CREATED_AT = "2026-08-11T00:00:00.000Z";
const SOURCE_LABEL = "kiro:.kiro/specs/imported-feature";

const env: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:4999",
  CC_API_TOKEN: "contract-token",
  CC_PROJECT: "demo",
  CC_SESSION: "feature-session",
  CC_CONVERSATION_ID: "conversation-1",
};

/**
 * A bundle exercising every artifact the document carries, so the round trip
 * proves the CLI forwards the whole shape rather than the subset a minimal
 * fixture would reach.
 */
function bundle(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    slug: "imported-feature",
    name: "Imported Feature",
    source: { label: SOURCE_LABEL },
    sections: [
      { role: "intent_problem", title: "Problem", body: "Stated externally." },
      {
        role: "design_narrative",
        title: "Approach",
        body: "Translated from the external design.",
      },
    ],
    requirements: [
      {
        ref: "core",
        statement: "An agent imports an external spec in one act.",
        priority: "must",
        risk: "high",
        criteria: [
          {
            text: "A bundle becomes an approved spec.",
            validationStrategy: { kinds: ["test_run"] },
          },
          { text: "Nothing the import writes satisfies a human gate." },
        ],
      },
    ],
    decisions: [
      {
        title: "Import is one-shot",
        chosenApproach: "Write the whole spec in one transaction.",
        rejectedAlternatives: [
          { label: "Incremental import", reason: "Leaves half-built specs." },
        ],
        reason:
          "A partial import is indistinguishable from abandoned authoring.",
        traces: ["core"],
      },
    ],
    questions: [
      { text: "Which external formats?", answer: "Any the agent can read." },
    ],
    assumptions: [
      {
        text: "The external source already shipped.",
        disposition: "confirmed",
      },
    ],
    delivered: true,
    ...overrides,
  };
}

const RECEIPT = {
  spec: {
    id: "spec-imported",
    projectPath: "/repos/demo",
    slug: "imported-feature",
    name: "Imported Feature",
    gatePolicy: { preset: "contract-bearing" },
    abandonedAt: null,
    abandonedReason: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  },
  revision: {
    id: "revision-imported",
    specId: "spec-imported",
    number: 1,
    state: "approved",
    authoringStage: "design",
    basedOnRevisionId: null,
    contentHash: "imported-hash",
    proposedAt: CREATED_AT,
    approvedAt: CREATED_AT,
    externalDelivery: {
      at: CREATED_AT,
      actor: { kind: "agent", conversationId: "conversation-1" },
      source: { label: SOURCE_LABEL },
    },
    createdAt: CREATED_AT,
  },
  counts: {
    sections: 2,
    requirements: 1,
    criteria: 2,
    decisions: 1,
    questions: 1,
    assumptions: 1,
  },
};

const PREVIEW = {
  dryRun: true,
  preview: {
    counts: RECEIPT.counts,
    handles: {
      requirements: [
        {
          handle: "R1",
          summary: "An agent imports an external spec in one act.",
        },
      ],
      criteria: [
        { handle: "R1.1", summary: "A bundle becomes an approved spec." },
        {
          handle: "R1.2",
          summary: "Nothing the import writes satisfies a human gate.",
        },
      ],
      decisions: [{ handle: "D1", summary: "Import is one-shot" }],
      questions: [{ handle: "Q1", summary: "Which external formats?" }],
      assumptions: [
        { handle: "A1", summary: "The external source already shipped." },
      ],
    },
    findings: [],
    blocking: 0,
  },
};

/** Every advisory-tier line the text output carries, in order. */
function hintLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.startsWith("hint: "));
}

interface RecordedRequest {
  url: string;
  init: FetchInit;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeHost(
  options: {
    file?: unknown;
    /** Raw file text, for the unparseable-document cases. */
    rawFile?: string;
    body?: unknown;
    status?: number;
  } = {},
): CliHost & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    async fetch(url, init) {
      requests.push({ url, init });
      return response(options.body ?? RECEIPT, options.status ?? 200);
    },
    async readTextFile(filePath) {
      if (filePath !== BUNDLE_FILE) return null;
      if (options.rawFile !== undefined) return options.rawFile;
      return JSON.stringify(options.file ?? bundle());
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

describe("cctl spec import", () => {
  it("posts the whole bundle to the project-scoped import action", async () => {
    const host = makeHost();

    const result = await runCli(
      ["spec", "import", "--file", BUNDLE_FILE, "--json"],
      env,
      host,
    );

    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request?.init.method).toBe("POST");
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/specs/demo/actions/import",
    );
    expect(request?.init.headers["x-cc-conversation-id"]).toBe(
      "conversation-1",
    );
    // The action parses the request body with the bundle schema itself, so the
    // document travels whole rather than as a subset the CLI re-assembled.
    const sent = importBundleSchema.parse(
      JSON.parse(request?.init.body ?? "null"),
    );
    expect(sent).toMatchObject({
      slug: "imported-feature",
      source: { label: SOURCE_LABEL },
      delivered: true,
      dryRun: false,
    });
    expect(sent.requirements[0]?.criteria).toHaveLength(2);
    expect(sent.decisions[0]?.traces).toEqual(["core"]);
  });

  it("renders the created slug, revision, handle summary, delivered state, and next step", async () => {
    const result = await runCli(
      ["spec", "import", "--file", BUNDLE_FILE],
      env,
      makeHost(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("imported spec imported-feature");
    expect(result.stdout).toContain(SOURCE_LABEL);
    // Approved on import provenance, never presented as a human approval.
    expect(result.stdout).toContain("import provenance");
    expect(result.stdout).toContain("revision 1");
    expect(result.stdout).toContain("requirements: 1 (R1)");
    expect(result.stdout).toContain("criteria: 2");
    expect(result.stdout).toContain("decisions: 1 (D1)");
    expect(result.stdout).toContain("questions: 1 (Q1)");
    expect(result.stdout).toContain("assumptions: 1 (A1)");
    expect(result.stdout).toContain("sections: 2");
    // External delivery is testimony; the receipt must not read as proof.
    expect(result.stdout).toContain("provenance, not proof");
    expect(result.stdout).toContain("next: cctl spec show imported-feature");
  });

  it("carries the receipt structurally in the --json envelope", async () => {
    const result = await runCli(
      ["spec", "import", "--file", BUNDLE_FILE, "--json"],
      env,
      makeHost(),
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      import: {
        spec: { slug: "imported-feature" },
        revision: {
          id: "revision-imported",
          state: "approved",
          externalDelivery: { source: { label: SOURCE_LABEL } },
        },
        counts: { requirements: 1, criteria: 2 },
      },
      tokens: { spec: "imported-feature", revision: "revision-imported" },
    });
  });

  it("points an undelivered import at delivery planning instead of a read", async () => {
    const host = makeHost({
      file: bundle({ delivered: false }),
      body: {
        ...RECEIPT,
        revision: { ...RECEIPT.revision, externalDelivery: null },
      },
    });

    const result = await runCli(
      ["spec", "import", "--file", BUNDLE_FILE],
      env,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no external delivery recorded");
    expect(result.stdout).toContain(
      "next: cctl spec plan open imported-feature",
    );
  });

  it("rehearses with --dry-run and renders the findings and the handles it would allocate", async () => {
    const host = makeHost({ body: PREVIEW });

    const result = await runCli(
      ["spec", "import", "--file", BUNDLE_FILE, "--dry-run"],
      env,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(host.requests[0]?.init.body ?? "null")).toMatchObject({
      dryRun: true,
    });
    expect(result.stdout).toContain("dry run — nothing was written");
    for (const handle of ["R1", "R1.1", "R1.2", "D1", "Q1", "A1"]) {
      expect(result.stdout, `dry run omits ${handle}`).toContain(handle);
    }
    expect(result.stdout).toContain("findings: 0, 0 blocking");
    expect(result.stdout).toContain(
      `hint: cctl spec import --file ${BUNDLE_FILE}`,
    );
    // The renderer owns the hint tier; a command that also prints it in its own
    // body says the same advisory thing twice (doc 04 §1.2).
    expect(hintLines(result.stdout)).toHaveLength(1);
  });

  it("names the blocking findings a rehearsal found and does not offer the import", async () => {
    const host = makeHost({
      body: {
        dryRun: true,
        preview: {
          ...PREVIEW.preview,
          findings: [
            {
              ruleId: "9.3.uncovered-criterion",
              severity: "blocks_propose",
              elementHandle: "R1.2",
              message: "R1.2 has no covering task.",
            },
            {
              ruleId: "9.9.thin-decision",
              severity: "advisory",
              elementHandle: "D1",
              message: "D1 rejects only one alternative.",
            },
          ],
          blocking: 1,
        },
      },
    });

    const result = await runCli(
      ["spec", "import", "--file", BUNDLE_FILE, "--dry-run"],
      env,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("findings: 2, 1 blocking");
    expect(result.stdout).toContain(
      "R1.2 [9.3.uncovered-criterion]: R1.2 has no covering task.",
    );
    expect(result.stdout).toContain("D1 [9.9.thin-decision]");
    expect(result.stdout).toContain("fix the 1 blocking finding");
    // The bare invocation is never offered while something would refuse it.
    expect(result.stdout).not.toContain(
      `hint: cctl spec import --file ${BUNDLE_FILE}`,
    );
  });

  it("carries the preview structurally in the --json envelope", async () => {
    const result = await runCli(
      ["spec", "import", "--file", BUNDLE_FILE, "--dry-run", "--json"],
      env,
      makeHost({ body: PREVIEW }),
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      dryRun: true,
      preview: {
        blocking: 0,
        counts: { requirements: 1 },
        handles: { criteria: [{ handle: "R1.1" }, { handle: "R1.2" }] },
      },
    });
  });

  /**
   * A bundle that asks to be rehearsed must not be performed because the flag
   * was left off: the flag and the document can each request a rehearsal, and
   * neither cancels the other's request.
   */
  it("honours a dryRun the document itself declares", async () => {
    const host = makeHost({ file: bundle({ dryRun: true }), body: PREVIEW });

    const result = await runCli(
      ["spec", "import", "--file", BUNDLE_FILE],
      env,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(host.requests[0]?.init.body ?? "null")).toMatchObject({
      dryRun: true,
    });
  });

  /**
   * A document-declared rehearsal survives every invocation of this command, so
   * the only step that ends it is an edit to the document. A hint that offered
   * the bare re-run would rehearse a third time and every time after.
   */
  it("tells a document-declared rehearsal to clear the field before importing", async () => {
    const host = makeHost({ file: bundle({ dryRun: true }), body: PREVIEW });

    const result = await runCli(
      ["spec", "import", "--file", BUNDLE_FILE],
      env,
      host,
    );

    expect(result.exitCode).toBe(0);
    const [hint, ...extra] = hintLines(result.stdout);
    expect(extra).toEqual([]);
    expect(hint).toContain('"dryRun": false');
    expect(hint).toContain(BUNDLE_FILE);
  });

  it("keeps naming the document field when a declared rehearsal also blocks", async () => {
    const host = makeHost({
      file: bundle({ dryRun: true }),
      body: {
        dryRun: true,
        preview: {
          ...PREVIEW.preview,
          findings: [
            {
              ruleId: "9.3.uncovered-criterion",
              severity: "blocks_propose",
              elementHandle: "R1.2",
              message: "R1.2 has no covering task.",
            },
          ],
          blocking: 1,
        },
      },
    });

    const result = await runCli(
      ["spec", "import", "--file", BUNDLE_FILE],
      env,
      host,
    );

    expect(result.exitCode).toBe(0);
    const [hint] = hintLines(result.stdout);
    expect(hint).toContain("fix the 1 blocking finding");
    expect(hint).toContain('"dryRun": false');
  });

  it("refuses a missing or malformed bundle before any request", async () => {
    const missing = makeHost();
    const noFlag = await runCli(["spec", "import"], env, missing);
    expect(noFlag.exitCode).toBe(2);
    expect(noFlag.stderr).toContain("--file");
    expect(missing.requests).toEqual([]);

    const unreadable = makeHost();
    const absent = await runCli(
      ["spec", "import", "--file", "/tmp/nope.json"],
      env,
      unreadable,
    );
    expect(absent.exitCode).toBe(2);
    expect(unreadable.requests).toEqual([]);

    const badJson = makeHost({ rawFile: "{" });
    const unparseable = await runCli(
      ["spec", "import", "--file", BUNDLE_FILE],
      env,
      badJson,
    );
    expect(unparseable.exitCode).toBe(2);
    expect(badJson.requests).toEqual([]);

    const offSchema = makeHost({
      file: bundle({ requirements: "not-an-array" }),
    });
    const invalid = await runCli(
      ["spec", "import", "--file", BUNDLE_FILE],
      env,
      offSchema,
    );
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stderr).toContain("requirements");
    expect(invalid.stderr).toContain("cctl spec schema import-bundle");
    expect(offSchema.requests).toEqual([]);
  });

  it("takes no positional argument — the slug is the bundle's", async () => {
    const host = makeHost();

    const result = await runCli(
      ["spec", "import", "imported-feature", "--file", BUNDLE_FILE],
      env,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(host.requests).toEqual([]);
  });

  it("renders the slug_taken refusal with the recovery it names", async () => {
    const host = makeHost({
      status: 409,
      body: {
        code: "slug_taken",
        unmetConditions: [
          'spec slug "imported-feature" already names "Imported Feature" (spec-1) in this project',
        ],
        instruction:
          "Import creates new specs only. Choose an unused slug, or read the existing spec with `cctl spec show <slug>` and amend it through ordinary authoring.",
        details: { existingSpecId: "spec-1", name: "Imported Feature" },
      },
    });

    const result = await runCli(
      ["spec", "import", "--file", BUNDLE_FILE],
      env,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already names");
    expect(result.stderr).toContain("Import creates new specs only");
  });

  it("renders the lint_blocked refusal's findings", async () => {
    const host = makeHost({
      status: 409,
      body: {
        code: "lint_blocked",
        unmetConditions: ["R1.2 has no covering task."],
        instruction:
          "Nothing was imported. Resolve every blocking finding in the bundle, then retry `cctl spec import`.",
        details: { findingCount: 1 },
        findings: [
          {
            ruleId: "9.3.uncovered-criterion",
            severity: "blocks_propose",
            elementHandle: "R1.2",
            message: "R1.2 has no covering task.",
          },
        ],
      },
    });

    const result = await runCli(
      ["spec", "import", "--file", BUNDLE_FILE, "--json"],
      env,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: "lint_blocked",
      details: { findings: [{ elementHandle: "R1.2" }] },
    });
  });
});
