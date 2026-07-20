import { describe, expect, it } from "vitest";

import {
  createSpecRouteHandlers,
  type SpecRouteDeps,
} from "@/lib/specs/route-handlers";
import { computeSpecMeasuresReport } from "@/lib/specs/measures";
import type {
  Spec,
  SpecApprovalRow,
  SpecAssumptionRow,
  SpecEvidenceRow,
  SpecExecutionRow,
  SpecGateAdmissionRow,
  SpecProofVerdictRow,
  SpecQuestionRow,
  SpecRevision,
  SpecRevisionSnapshot,
} from "@/lib/specs/schemas";
import { runCli } from "../../core";
import type { CliEnv, CliHost, FetchInit } from "../../shared";

const PROJECT_PATH = "/repos/demo";
const CREATED_AT = "2026-07-18T00:00:00.000Z";

const spec: Spec = {
  id: "spec-1",
  projectPath: PROJECT_PATH,
  slug: "native-sdd",
  name: "Native SDD",
  gatePolicy: { preset: "contract-bearing" },
  abandonedAt: null,
  abandonedReason: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const revision: SpecRevision = {
  id: "revision-1",
  specId: spec.id,
  number: 1,
  state: "draft",
  basedOnRevisionId: null,
  contentHash: null,
  proposedAt: null,
  approvedAt: null,
  createdAt: CREATED_AT,
};

const snapshot: SpecRevisionSnapshot = {
  revision,
  elements: [
    {
      element: {
        id: "requirement-1",
        specId: spec.id,
        kind: "requirement",
        number: 1,
        parentElementId: null,
        createdAt: CREATED_AT,
      },
      version: {
        revisionId: revision.id,
        elementId: "requirement-1",
        position: 0,
        payload: {
          kind: "requirement",
          statement: "Specs are durable product objects.",
          priority: "must",
          risk: "high",
        },
        payloadHash: "requirement-hash",
        elementVersion: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    },
    {
      element: {
        id: "criterion-1",
        specId: spec.id,
        kind: "criterion",
        number: 1,
        parentElementId: "requirement-1",
        createdAt: CREATED_AT,
      },
      version: {
        revisionId: revision.id,
        elementId: "criterion-1",
        position: 1,
        payload: {
          kind: "criterion",
          text: "The spec can be read through cctl.",
          validationStrategy: { kinds: ["test_run"] },
        },
        payloadHash: "criterion-hash",
        elementVersion: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    },
    {
      element: {
        id: "task-1",
        specId: spec.id,
        kind: "task",
        number: 1,
        parentElementId: null,
        createdAt: CREATED_AT,
      },
      version: {
        revisionId: revision.id,
        elementId: "task-1",
        position: 2,
        payload: {
          kind: "task",
          title: "Build the CLI reads",
          instructions: "Expose every approved read verb.",
          tracedRequirementElementIds: ["requirement-1"],
          tracedDecisionElementIds: [],
          coveredCriterionElementIds: ["criterion-1"],
          dependsOnTaskElementIds: [],
        },
        payloadHash: "task-hash",
        elementVersion: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    },
  ],
};

const question: SpecQuestionRow = {
  id: "question-1",
  spec_id: spec.id,
  number: 1,
  element_id: "requirement-1",
  text: "Which export format is canonical?",
  provenance_json: JSON.stringify({
    kind: "agent",
    conversationId: "conversation-1",
  }),
  status: "open",
  answer: null,
  answered_at: null,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

const assumption: SpecAssumptionRow = {
  id: "assumption-1",
  spec_id: spec.id,
  number: 1,
  element_id: "requirement-1",
  text: "SQLite remains authoritative.",
  proposed_by_json: JSON.stringify({
    kind: "agent",
    conversationId: "conversation-1",
  }),
  disposition: "proposed",
  disposed_at: null,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

const bundle = {
  markdownFiles: [
    {
      path: "revisions/0001-draft.md",
      content: "# Native SDD\n\n- Revision: 1\n",
    },
  ],
  manifest: '{"formatVersion":1,"spec":{"slug":"native-sdd"}}\n',
};

function createDeps(): SpecRouteDeps {
  return {
    async resolveProjectPath(name) {
      return name === "demo" ? PROJECT_PATH : null;
    },
    async listSpecs() {
      return [spec];
    },
    async resolveSpec(_projectPath, slug) {
      return slug === spec.slug ? spec : null;
    },
    async listAliases() {
      return [];
    },
    async listRevisions() {
      return [revision];
    },
    async getRevisionSnapshot(revisionId) {
      return revisionId === revision.id ? snapshot : null;
    },
    async lintDraft() {
      return [];
    },
    findApprovalsBySpecId() {
      return [] as SpecApprovalRow[];
    },
    findCommentsByRevision() {
      return [];
    },
    findGateAdmissionsByRevision() {
      return [] as SpecGateAdmissionRow[];
    },
    findLinksBySpecId() {
      return [];
    },
    async getLinkedTickets() {
      return [];
    },
    findQuestionsBySpecId() {
      return [question];
    },
    findAssumptionsBySpecId() {
      return [assumption];
    },
    findExecutionsBySpecId() {
      return [] as SpecExecutionRow[];
    },
    findTaskClaimsBySpecId() {
      return [];
    },
    findWorkflowEventsByExecution() {
      return [];
    },
    async reconcileExecution(_projectPath, execution) {
      return execution;
    },
    async ingestExecutionEvidenceBestEffort() {},
    findCriterionDispositionsByExecution() {
      return [];
    },
    findEvidenceByCriterionRevision() {
      return [] as SpecEvidenceRow[];
    },
    findProofVerdictsByCriterionRevision() {
      return [] as SpecProofVerdictRow[];
    },
    findWaiverForCriterionRevision() {
      return null;
    },
    async exportSpec() {
      return bundle;
    },
    async verifySpec() {
      return {
        ok: true,
        checkedRevisionIds: [revision.id],
        mismatches: [],
      };
    },
    async measureProject() {
      return computeSpecMeasuresReport([], []);
    },
  };
}

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:4999",
  CC_API_TOKEN: "contract-token",
  CC_PROJECT: "demo",
};

interface RecordedRequest {
  url: string;
  init: FetchInit;
}

function makeHost(
  options: {
    files?: Record<string, string>;
    tampered?: boolean;
    measuresSlug?: boolean;
  } = {},
): CliHost & {
  requests: RecordedRequest[];
  written: Map<string, string>;
} {
  const requests: RecordedRequest[] = [];
  const written = new Map<string, string>();
  const baseDeps = createDeps();
  const handlers = createSpecRouteHandlers({
    ...baseDeps,
    async resolveSpec(projectPath, slug) {
      if (options.measuresSlug && slug === "measures") {
        return { ...spec, slug: "measures" };
      }
      return baseDeps.resolveSpec(projectPath, slug);
    },
    async verifySpec() {
      return options.tampered
        ? {
            ok: false,
            checkedRevisionIds: [revision.id],
            mismatches: [
              {
                revisionId: revision.id,
                expectedContentHash: "expected-hash",
                actualContentHash: "tampered-hash",
                mismatchedElementIds: ["requirement-1"],
              },
            ],
          }
        : {
            ok: true,
            checkedRevisionIds: [revision.id],
            mismatches: [],
          };
    },
  });

  return {
    requests,
    written,
    async fetch(url, init) {
      requests.push({ url, init });
      const parsed = new URL(url);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const name = decodeURIComponent(segments[2] ?? "");
      if (segments[1] === "projects" && segments[3] === "spec-measures") {
        return handlers.getSpecMeasuresGET(new Request(url), {
          params: Promise.resolve({ name }),
        });
      }
      const slug = decodeURIComponent(segments[3] ?? "");
      const tail = segments[4];
      const request = new Request(url, {
        method: init.method,
        headers: init.headers,
      });
      const context = { params: Promise.resolve({ name, slug }) };

      if (slug === "") return handlers.listSpecsGET(request, context);
      if (tail === "summary")
        return handlers.getSpecSummaryGET(request, context);
      if (tail === "status") return handlers.getSpecStatusGET(request, context);
      if (tail === "elements") {
        return handlers.getSpecElementGET(request, {
          params: Promise.resolve({
            name,
            slug,
            element: decodeURIComponent(segments[5] ?? ""),
          }),
        });
      }
      if (tail === "search") return handlers.searchSpecGET(request, context);
      if (tail === "export") return handlers.getSpecExportGET(request, context);
      if (tail === "verify") return handlers.getSpecVerifyGET(request, context);
      return handlers.getSpecGET(request, context);
    },
    async readTextFile(filePath) {
      return options.files?.[filePath] ?? null;
    },
    async readFileBytes() {
      return null;
    },
    async writeTextFile(filePath, content) {
      written.set(filePath, content);
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

describe("cctl spec read verbs against seeded read routes", () => {
  it("lists the seeded inventory", async () => {
    const result = await runCli(
      ["spec", "list", "--json"],
      baseEnv,
      makeHost(),
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      specs: [{ spec: { slug: "native-sdd", name: "Native SDD" } }],
    });
  });

  it("shows full and summary views", async () => {
    const host = makeHost();
    const full = await runCli(
      ["spec", "show", "native-sdd", "--json"],
      baseEnv,
      host,
    );
    const summary = await runCli(
      ["spec", "show", "native-sdd", "--summary", "--json"],
      baseEnv,
      host,
    );

    expect(JSON.parse(full.stdout).spec).toMatchObject({
      spec: { slug: "native-sdd" },
      currentRevision: { revision: { id: revision.id } },
    });
    expect(JSON.parse(summary.stdout).spec).toMatchObject({
      spec: { slug: "native-sdd" },
      counts: { requirements: 1, criteria: 1, tasks: 1 },
    });
  });

  it("keeps the measures project endpoint distinct from a legal measures spec slug", async () => {
    const host = makeHost({ measuresSlug: true });
    const shown = await runCli(
      ["spec", "show", "measures", "--json"],
      baseEnv,
      host,
    );
    const measured = await runCli(
      ["spec", "measures", "--json"],
      baseEnv,
      host,
    );

    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.stdout).spec.spec.slug).toBe("measures");
    expect(measured.exitCode).toBe(0);
    expect(host.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/specs/demo/measures",
      "/api/projects/demo/spec-measures",
    ]);
  });

  it("shows phase, gates, pending approvals, open questions, and coverage", async () => {
    const result = await runCli(
      ["spec", "status", "native-sdd", "--json"],
      baseEnv,
      makeHost(),
    );
    const status = JSON.parse(result.stdout).status;

    expect(status.phase).toEqual({ primary: "draft" });
    expect(status.gates).toHaveLength(5);
    expect(status.pendingApprovals.length).toBeGreaterThan(0);
    expect(status.openQuestions).toEqual([
      expect.objectContaining({ handle: "Q1" }),
    ]);
    expect(status.coverage).toEqual({
      coveredCriteria: 1,
      totalCriteria: 1,
      percentage: 100,
    });
  });

  it("gets qualified and bare element handles", async () => {
    const host = makeHost();
    const qualified = await runCli(
      ["spec", "get", "native-sdd/R1", "--json"],
      baseEnv,
      host,
    );
    const bare = await runCli(
      ["spec", "get", "native-sdd", "R1", "--json"],
      baseEnv,
      host,
    );

    expect(JSON.parse(qualified.stdout).element.handle).toBe("R1");
    expect(JSON.parse(bare.stdout).element.handle).toBe("R1");
  });

  it("gets question and assumption handles as typed views", async () => {
    const host = makeHost();
    const questionResult = await runCli(
      ["spec", "get", "native-sdd/Q1", "--json"],
      baseEnv,
      host,
    );
    const assumptionResult = await runCli(
      ["spec", "get", "native-sdd", "A1", "--json"],
      baseEnv,
      host,
    );

    expect(questionResult.exitCode).toBe(0);
    expect(JSON.parse(questionResult.stdout).element).toMatchObject({
      kind: "question",
      handle: "Q1",
      question: {
        handle: "Q1",
        text: "Which export format is canonical?",
        status: "open",
        elementId: "requirement-1",
      },
    });
    expect(assumptionResult.exitCode).toBe(0);
    expect(JSON.parse(assumptionResult.stdout).element).toMatchObject({
      kind: "assumption",
      handle: "A1",
      assumption: {
        handle: "A1",
        text: "SQLite remains authoritative.",
        disposition: "proposed",
      },
    });
  });

  it("searches requirement text", async () => {
    const result = await runCli(
      ["spec", "search", "native-sdd", "durable", "--json"],
      baseEnv,
      makeHost(),
    );

    expect(JSON.parse(result.stdout).search.results).toEqual([
      expect.objectContaining({ handle: "R1", kind: "requirement" }),
    ]);
  });

  it("exports the canonical bundle and writes --out", async () => {
    const host = makeHost();
    const result = await runCli(
      [
        "spec",
        "export",
        "native-sdd",
        "--out",
        "/tmp/native-sdd.json",
        "--json",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      out: "/tmp/native-sdd.json",
      bundle,
    });
    expect(
      JSON.parse(host.written.get("/tmp/native-sdd.json") ?? "null"),
    ).toEqual(bundle);
  });

  it("verifies current integrity and an exported representation", async () => {
    const against = "/tmp/native-sdd.json";
    const host = makeHost({ files: { [against]: JSON.stringify(bundle) } });
    const result = await runCli(
      ["spec", "verify", "native-sdd", "--against", against, "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      report: { ok: true, checkedRevisionIds: [revision.id] },
      against,
    });
  });

  it("exits 1 with integrity_mismatch for a tampered spec", async () => {
    const result = await runCli(
      ["spec", "verify", "native-sdd", "--json"],
      baseEnv,
      makeHost({ tampered: true }),
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      details: { report: { ok: false } },
    });
  });

  it("rejects malformed slugs, handles, and --against files before network", async () => {
    const host = makeHost({ files: { "/tmp/bad.json": "not json" } });
    for (const argv of [
      ["spec", "show", "Native-SDD"],
      ["spec", "get", "native-sdd/R0"],
      ["spec", "verify", "native-sdd", "--against", "/tmp/bad.json"],
    ]) {
      const result = await runCli(argv, baseEnv, host);
      expect(result.exitCode).toBe(2);
    }
    expect(host.requests).toHaveLength(0);
  });

  it("renders the spec family and leaf help from the registry", async () => {
    const host = makeHost();
    const group = await runCli(["spec", "--help"], baseEnv, host);
    const leaf = await runCli(["spec", "get", "--help"], baseEnv, host);

    expect(group.exitCode).toBe(0);
    expect(group.stdout).toContain("spec get");
    expect(leaf.stdout).toContain("cctl spec get <slug>/<handle>");
    expect(host.requests).toHaveLength(0);
  });
});
