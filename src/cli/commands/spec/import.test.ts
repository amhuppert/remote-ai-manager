import { describe, expect, it } from "vitest";

import { renderCanonicalBundle } from "@/lib/specs/export";
import {
  importBundleSchema,
  type Spec,
  type SpecRevision,
  type SpecRevisionSnapshot,
} from "@/lib/specs/schemas";
import {
  computeSpecElementPayloadHash,
  computeSpecRevisionCitationHash,
} from "@/lib/state-store/specs-repo";
import { inlineDataOf, runCcWithHost } from "../../testing/domain-runtime";
import type { CliEnv, CliHost, FetchInit } from "../../transport";

const BUNDLE_FILE = "/tmp/import-bundle.json";
const CREATED_AT = "2026-08-11T00:00:00.000Z";
const SOURCE_LABEL = "kiro:.kiro/specs/imported-feature";

function canonicalExportBundle() {
  const canonicalSpec: Spec = {
    id: "canonical-spec",
    projectPath: "/repos/demo",
    slug: "canonical-export",
    name: "Canonical Export",
    gatePolicy: { preset: "contract-bearing" },
    abandonedAt: null,
    abandonedReason: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  const canonicalRevision: SpecRevision = {
    id: "canonical-revision-1",
    specId: canonicalSpec.id,
    number: 1,
    state: "draft",
    authoringStage: "requirements",
    basedOnRevisionId: null,
    contentHash: null,
    citationContractVersion: 2,
    citationVersion: 1,
    citationHash: computeSpecRevisionCitationHash(2, []),
    proposedAt: null,
    approvedAt: null,
    externalDelivery: null,
    createdAt: CREATED_AT,
  };
  const requirementPayload = {
    kind: "requirement" as const,
    statement: "Canonical exports are read-only verification artifacts.",
    priority: "must" as const,
    risk: "high" as const,
  };
  const canonicalSnapshot: SpecRevisionSnapshot = {
    revision: canonicalRevision,
    assumptionCitations: [],
    elements: [
      {
        element: {
          id: "canonical-requirement-1",
          specId: canonicalSpec.id,
          kind: "requirement",
          number: 1,
          parentElementId: null,
          createdAt: CREATED_AT,
        },
        version: {
          revisionId: canonicalRevision.id,
          elementId: "canonical-requirement-1",
          position: 0,
          payload: requirementPayload,
          payloadHash: computeSpecElementPayloadHash(requirementPayload),
          elementVersion: 1,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
      },
    ],
  };

  return renderCanonicalBundle({
    spec: canonicalSpec,
    revisions: [{ snapshot: canonicalSnapshot }],
    approvals: [],
    gateAdmissions: [],
    questions: [],
    assumptions: [],
    executions: [],
    attentionAuditEvents: [],
  });
}

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
    citationContractVersion: 2,
    citationVersion: 1,
    citationHash: "a".repeat(64),
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
    body?: unknown;
    status?: number;
  } = {},
): CliHost & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    async fetch(url, init) {
      requests.push({ url, init });
      const body = JSON.parse(init.body ?? "{}");
      return response(
        options.body ?? (body.dryRun ? PREVIEW : RECEIPT),
        options.status ?? 200,
      );
    },
    async readTextFile(filePath) {
      if (filePath !== BUNDLE_FILE) return null;
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
  it("previews admission, then commits the complete project-scoped bundle", async () => {
    const host = makeHost();
    const result = await runCcWithHost(
      ["spec", "import", "--file", BUNDLE_FILE, "--json"],
      env,
      host,
    );
    expect(result.exitCode, result.stdout).toBe(0);
    expect(host.requests).toHaveLength(2);
    for (const [index, request] of host.requests.entries()) {
      expect(request.init.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe(
        "/api/specs/demo/actions/import",
      );
      expect(request.init.headers["x-cc-conversation-id"]).toBe(
        "conversation-1",
      );
      const sent = importBundleSchema.parse(
        JSON.parse(request.init.body ?? "null"),
      );
      expect(sent).toMatchObject({
        slug: "imported-feature",
        source: { label: SOURCE_LABEL },
        delivered: true,
        dryRun: index === 0,
      });
      expect(sent.requirements[0]?.criteria).toHaveLength(2);
      expect(sent.decisions[0]?.traces).toEqual(["core"]);
    }
    expect(inlineDataOf(result)).toMatchObject(RECEIPT);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      recovery: {
        kind: "reported",
        references: [
          { kind: "spec", id: "spec-imported" },
          { kind: "spec-revision", id: "revision-imported" },
        ],
      },
    });
  });

  it("retains the provenance and delivery testimony in the native receipt", async () => {
    const result = await runCcWithHost(
      ["spec", "import", "--file", BUNDLE_FILE, "--json"],
      env,
      makeHost(),
    );
    expect(result.exitCode).toBe(0);
    expect(inlineDataOf(result)).toMatchObject({
      revision: {
        state: "approved",
        externalDelivery: {
          actor: { kind: "agent" },
          source: { label: SOURCE_LABEL },
        },
      },
      counts: RECEIPT.counts,
    });
  });

  it("keeps an undelivered import distinct from an external-delivery testimony", async () => {
    const host = makeHost({ file: bundle({ delivered: false }) });
    const originalFetch = host.fetch;
    host.fetch = async (url, init) =>
      JSON.parse(init.body ?? "{}").dryRun
        ? originalFetch(url, init)
        : response({
            ...RECEIPT,
            revision: { ...RECEIPT.revision, externalDelivery: null },
          });
    const result = await runCcWithHost(
      ["spec", "import", "--file", BUNDLE_FILE, "--json"],
      env,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(inlineDataOf(result)).toMatchObject({
      revision: { externalDelivery: null },
    });
  });

  it("rehearses without a commit and retains counts and prospective stable handles", async () => {
    const host = makeHost();
    const result = await runCcWithHost(
      ["spec", "import-preview", "--file", BUNDLE_FILE, "--json"],
      env,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(host.requests).toHaveLength(1);
    expect(JSON.parse(host.requests[0]?.init.body ?? "null")).toMatchObject({
      dryRun: true,
    });
    expect(inlineDataOf(result)).toEqual(PREVIEW);
    expect(JSON.parse(result.stdout).effect).toBe("read");
  });

  it("retains complete blocking and advisory findings in a preview and refuses the write", async () => {
    const findings = [
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
    ];
    const body = {
      dryRun: true,
      preview: { ...PREVIEW.preview, findings, blocking: 1 },
    };
    const previewHost = makeHost({ body });
    const preview = await runCcWithHost(
      ["spec", "import-preview", "--file", BUNDLE_FILE, "--json"],
      env,
      previewHost,
    );
    expect(preview.exitCode).toBe(0);
    expect(inlineDataOf(preview)).toEqual(body);
    const writeHost = makeHost({ body });
    const write = await runCcWithHost(
      ["spec", "import", "--file", BUNDLE_FILE, "--json"],
      env,
      writeHost,
    );
    expect(write.exitCode).toBe(1);
    expect(JSON.parse(write.stdout)).toMatchObject({
      effect: "not_applied",
      error: { details: body },
    });
    expect(writeHost.requests).toHaveLength(1);
  });

  it("allows a document-declared rehearsal only through import-preview", async () => {
    const host = makeHost({ file: bundle({ dryRun: true }) });
    const preview = await runCcWithHost(
      ["spec", "import-preview", "--file", BUNDLE_FILE, "--json"],
      env,
      host,
    );
    expect(preview.exitCode).toBe(0);
    expect(inlineDataOf(preview)).toEqual(PREVIEW);
    const refusedHost = makeHost({ file: bundle({ dryRun: true }) });
    const refused = await runCcWithHost(
      ["spec", "import", "--file", BUNDLE_FILE, "--json"],
      env,
      refusedHost,
    );
    expect(refused.exitCode).toBe(2);
    expect(JSON.parse(refused.stdout).error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["dryRun"],
          message: expect.stringContaining("import-preview"),
        }),
      ]),
    );
    expect(refusedHost.requests).toHaveLength(0);
  });

  it("refuses an import whose requirements violate the bundle schema", async () => {
    const host = makeHost({ file: bundle({ requirements: "not-an-array" }) });
    const result = await runCcWithHost(
      ["spec", "import", "--file", BUNDLE_FILE, "--json"],
      env,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["requirements"] }),
      ]),
    );
    expect(host.requests).toHaveLength(0);
  });

  it("rejects canonical export restoration at the located import-schema boundary", async () => {
    const host = makeHost({ file: canonicalExportBundle() });
    const result = await runCcWithHost(
      ["spec", "import", "--file", BUNDLE_FILE, "--json"],
      env,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        issues: expect.arrayContaining([
          { code: "schema", path: ["slug"], message: expect.any(String) },
        ]),
      },
    });
    expect(host.requests).toHaveLength(0);
  });

  it.each(["slug_taken", "lint_blocked"])(
    "retains the server's %s refusal, detail and recovery instruction",
    async (code) => {
      const host = makeHost({
        status: 409,
        body: {
          code,
          unmetConditions: ["The bundle cannot be imported."],
          instruction:
            "Nothing was imported. Resolve the bundle findings before retrying.",
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
      const result = await runCcWithHost(
        ["spec", "import", "--file", BUNDLE_FILE, "--json"],
        env,
        host,
      );
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        effect: "not_applied",
        error: {
          details: {
            serverCode: code,
            serverDetails:
              code === "lint_blocked"
                ? { findings: [{ elementHandle: "R1.2" }] }
                : { findingCount: 1 },
          },
        },
        instruction: expect.stringContaining("Nothing was imported"),
      });
      expect(host.requests).toHaveLength(1);
    },
  );
});
