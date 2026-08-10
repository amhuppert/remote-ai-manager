import { describe, expect, it } from "vitest";

import { emptyDeliveryPlanDocument } from "@/lib/specs/delivery-plan";
import {
  deliveryPlanMutationViewSchema,
  deliveryPlanPreviewViewSchema,
  deliveryPlanViewSchema,
  type DeliveryPlanMutationView,
  type DeliveryPlanPreviewView,
  type DeliveryPlanView,
} from "@/lib/specs/delivery-plan-views";
import { runCli } from "../../core";
import type { CliEnv, CliHost, FetchInit } from "../../shared";

const PLAN_FILE = "/tmp/plan.json";

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:4999",
  CC_API_TOKEN: "contract-token",
  CC_PROJECT: "demo",
  CC_SESSION: "feature-session",
  CC_CONVERSATION_ID: "conversation-1",
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

/**
 * `count` findings and `count` unresolved dispositions, so the bounded
 * sections can be driven past their cap from one knob.
 */
function planView(
  overrides: {
    findingCount?: number;
    unresolvedCount?: number;
    contextCount?: number;
    status?: DeliveryPlanView["attempt"]["status"];
    blocking?: number;
  } = {},
): DeliveryPlanView {
  const findingCount = overrides.findingCount ?? 0;
  const unresolvedCount = overrides.unresolvedCount ?? 0;
  const contextCount = overrides.contextCount ?? 0;
  const findings = Array.from({ length: findingCount }, (_unused, index) => ({
    ruleId: "plan/pending-reaffirmation",
    severity: "blocks_propose" as const,
    elementHandle: `R1.${index + 1}`,
    message: `R1.${index + 1} is still pending_reaffirmation.`,
  }));
  return deliveryPlanViewSchema.parse({
    attempt: {
      id: "attempt-1",
      specSlug: "native-sdd",
      status: overrides.status ?? "draft",
      draftRevision: 3,
      pinnedRevisionId: "revision-approved",
      deltaBasisExecutionId: "execution-earlier",
      proposedSnapshotId: null,
      planHash: null,
      compiledDefinitionHash: null,
      candidateId: null,
      launchedExecutionId: null,
      createdAt: "2026-08-08T09:00:00.000Z",
      updatedAt: "2026-08-08T09:05:00.000Z",
    },
    approval: null,
    prelaunch: null,
    document: {
      ...emptyDeliveryPlanDocument(),
      contexts: Array.from({ length: contextCount }, (_unused, index) => ({
        contextId: `ctx-${index + 1}`,
        title: `Context ${index + 1}`,
        contextType: "delivery",
        criterionElementIds: [`criterion-${index + 1}`],
        acceptanceContract: ["It is observable."],
        proofPlan: [],
      })),
    },
    health: {
      total: findingCount,
      blocking: overrides.blocking ?? findingCount,
      counts:
        findingCount === 0
          ? []
          : [{ severity: "blocks_propose", count: findingCount }],
      findings,
    },
    dispositionCounts: [{ disposition: "selected", count: 2 }],
    unresolved: Array.from({ length: unresolvedCount }, (_unused, index) => ({
      criterionElementId: `criterion-${index + 1}`,
      handle: `R1.${index + 1}`,
      disposition: "pending_reaffirmation",
      resolution: "Reaffirm it in Spec Studio, or select it to re-deliver it.",
    })),
    snapshots: [],
    nextAct: {
      actor: "agent",
      command: "cctl spec plan edit native-sdd --file <plan.json>",
      reason: "Findings refuse propose.",
    },
    wiringByContext: [],
  });
}

function mutationView(
  overrides: Parameters<typeof planView>[0] & {
    previousBlocking?: number;
    invalidatedApproval?: { snapshotId: string; planHash: string } | null;
    legacyImport?: DeliveryPlanMutationView["legacyImport"];
    prelaunch?: DeliveryPlanMutationView["prelaunch"];
  } = {},
): DeliveryPlanMutationView {
  const view = planView(overrides);
  return deliveryPlanMutationViewSchema.parse({
    ...view,
    ...(overrides.prelaunch === undefined
      ? {}
      : { prelaunch: overrides.prelaunch }),
    previousHealth:
      overrides.previousBlocking === undefined
        ? null
        : {
            total: overrides.previousBlocking,
            blocking: overrides.previousBlocking,
          },
    invalidatedApproval: overrides.invalidatedApproval ?? null,
    legacyImport: overrides.legacyImport ?? null,
    executionStartAdmission: null,
  });
}

function makeHost(options: {
  read?: DeliveryPlanView;
  write?: DeliveryPlanMutationView;
  files?: Record<string, string>;
  refusal?: { status: number; body: unknown };
}): { host: CliHost; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const host: CliHost = {
    async fetch(url, init) {
      requests.push({ url, init });
      if (options.refusal !== undefined) {
        return response(options.refusal.body, options.refusal.status);
      }
      if (init.method === "GET") {
        return response(options.read ?? planView());
      }
      return response(options.write ?? mutationView());
    },
    async readTextFile(filePath) {
      return options.files?.[filePath] ?? null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
  return { host, requests };
}

describe("cctl spec plan — registration", () => {
  it("registers every attempt verb in the typed help registry", async () => {
    for (const verb of [
      "open",
      "edit",
      "propose",
      "reopen",
      "sign-off",
      "get",
      "status",
    ]) {
      const result = await runCli(
        ["spec", "plan", verb, "--help"],
        {},
        makeHost({}).host,
      );
      expect(result.exitCode, `spec plan ${verb} has no help node`).toBe(0);
      expect(result.stdout).toContain(`cctl spec plan ${verb}`);
    }
  });

  it("lists the plan verbs when the group is invoked without one", async () => {
    const result = await runCli(["spec", "plan"], {}, makeHost({}).host);

    expect(result.exitCode).toBe(2);
    for (const verb of [
      "open",
      "edit",
      "propose",
      "reopen",
      "sign-off",
      "get",
      "status",
    ]) {
      expect(result.stderr).toContain(verb);
    }
  });
});

describe("cctl spec plan open", () => {
  it("seeds from the last delivery and reports the disposition it gave every criterion", async () => {
    const seeded = mutationView();
    const withDispositions = deliveryPlanMutationViewSchema.parse({
      ...seeded,
      document: {
        ...seeded.document,
        dispositions: [
          {
            criterionElementId: "criterion-1",
            disposition: "delivered_elsewhere",
            deliveredByExecutionId: "execution-earlier",
            reaffirmation: null,
            note: null,
          },
          {
            criterionElementId: "criterion-2",
            disposition: "pending_reaffirmation",
            deliveredByExecutionId: null,
            reaffirmation: null,
            note: null,
          },
        ],
      },
    });
    const { host, requests } = makeHost({ write: withDispositions });

    const result = await runCli(
      ["spec", "plan", "open", "native-sdd", "--seed-from", "last"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(requests[0]?.url).toContain("/actions/plan-open");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      seedFromLast: true,
    });
    expect(result.stdout).toContain("2 criteria");
    expect(result.stdout).toContain("exactly one disposition");
    expect(result.stdout).toContain("acts next: agent");
  });

  it("names every criterion a legacy import could not place, with the act that places it", async () => {
    const { host } = makeHost({
      write: mutationView({
        legacyImport: {
          sourceExecutionId: "execution-legacy",
          sourceRevisionId: "revision-legacy",
          contextCount: 23,
          taskCount: 23,
          requiresHumanSplit: [
            {
              criterionElementId: "criterion-9",
              handle: "native-sdd/R3.1",
              contextIds: ["t4", "t9"],
              resolution:
                "Split native-sdd/R3.1 into one criterion per context, or give one of t4, t9 sole ownership, then re-run `cctl spec plan edit native-sdd --file <plan.json>`.",
            },
          ],
          notes: ["Constraint section sec-1 was not imported."],
        },
      }),
    });

    const result = await runCli(
      ["spec", "plan", "open", "native-sdd", "--seed-from", "last"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("execution-legacy");
    expect(result.stdout).toContain("23 contexts");
    expect(result.stdout).toContain("native-sdd/R3.1");
    expect(result.stdout).toContain("cctl spec plan edit native-sdd");
    expect(result.stdout).toContain(
      "Constraint section sec-1 was not imported.",
    );
  });

  it("opens an empty attempt when no seed is asked for", async () => {
    const { host, requests } = makeHost({});

    const result = await runCli(
      ["spec", "plan", "open", "native-sdd"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      seedFromLast: false,
    });
  });

  it("refuses a --seed-from value it cannot honour, naming the one it takes", async () => {
    const result = await runCli(
      ["spec", "plan", "open", "native-sdd", "--seed-from", "approved"],
      baseEnv,
      makeHost({}).host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('takes "last"');
  });
});

describe("cctl spec plan edit", () => {
  const editFile = JSON.stringify({
    expectedDraftRevision: 3,
    document: emptyDeliveryPlanDocument(),
  });

  it("sends the compare-and-swap token from the file and reports the blocking delta", async () => {
    const { host, requests } = makeHost({
      files: { [PLAN_FILE]: editFile },
      write: mutationView({ findingCount: 1, previousBlocking: 4 }),
    });

    const result = await runCli(
      ["spec", "plan", "edit", "native-sdd", "--file", PLAN_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({
      expectedDraftRevision: 3,
    });
    expect(result.stdout).toContain("lint: 4 -> 1 blocking");
  });

  it("carries the CAS refusal's current revision through to the caller", async () => {
    const { host } = makeHost({
      files: { [PLAN_FILE]: editFile },
      refusal: {
        status: 409,
        body: {
          code: "stale_plan_draft",
          unmetConditions: [
            "delivery plan attempt attempt-1 is at draft revision 5, not 3.",
          ],
          instruction:
            "Re-read the attempt with `cctl spec plan get` and re-apply the edit at draft revision 5.",
        },
      },
    });

    const result = await runCli(
      ["spec", "plan", "edit", "native-sdd", "--file", PLAN_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("draft revision 5");
  });

  it("refuses a file that is not a plan edit document, naming the failing path", async () => {
    const { host } = makeHost({
      files: { [PLAN_FILE]: JSON.stringify({ document: {} }) },
    });

    const result = await runCli(
      ["spec", "plan", "edit", "native-sdd", "--file", PLAN_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("expectedDraftRevision");
    expect(result.stderr).toContain("cctl spec schema");
  });

  it("advises writing the payload under .cc/temp", async () => {
    const { host } = makeHost({ files: { "plan.json": editFile } });

    const result = await runCli(
      ["spec", "plan", "edit", "native-sdd", "--file", "plan.json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(".cc/temp/");
  });
});

describe("cctl spec plan propose and reopen", () => {
  it("names the reopen that takes a freeze back", async () => {
    const proposed = deliveryPlanMutationViewSchema.parse({
      ...mutationView({ status: "proposed", previousBlocking: 0 }),
      attempt: {
        ...planView({ status: "proposed" }).attempt,
        proposedSnapshotId: "snapshot-1",
        planHash: "sha256:abc",
        compiledDefinitionHash: "sha256:def",
      },
    });
    const { host } = makeHost({ write: proposed });

    const result = await runCli(
      ["spec", "plan", "propose", "native-sdd"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sha256:abc");
    expect(result.stdout).toContain("recovery: cctl spec plan reopen");
  });

  it("requires a reason on reopen, because it lands in the audit row", async () => {
    const result = await runCli(
      ["spec", "plan", "reopen", "native-sdd"],
      baseEnv,
      makeHost({}).host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--reason");
  });

  it("reports the approval a reopen invalidated", async () => {
    const { host, requests } = makeHost({
      write: mutationView({
        previousBlocking: 0,
        invalidatedApproval: {
          snapshotId: "snapshot-1",
          planHash: "sha256:abc",
        },
      }),
    });

    const result = await runCli(
      ["spec", "plan", "reopen", "native-sdd", "--reason", "missing closeout"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      reason: "missing closeout",
    });
    expect(result.stdout).toContain("snapshot-1");
    expect(result.stdout).toContain("needs a new one");
  });

  it("prints the parked and current compiled hashes once tuning moved the candidate", async () => {
    const { host } = makeHost({
      write: mutationView({
        previousBlocking: 0,
        prelaunch: {
          parkedAt: "2026-08-08T09:10:00.000Z",
          parkedBy: { kind: "human" },
          reason: null,
          approvedAtPark: true,
          parkedCandidateId: "candidate-parked",
          parkedPlanHash: "sha256:plan-parked",
          parkedCompiledDefinitionHash: "sha256:compiled-parked",
          currentCompiledDefinitionHash: "sha256:compiled-tuned",
          candidateChanged: true,
        },
      }),
    });

    const result = await runCli(
      ["spec", "plan", "reopen", "native-sdd", "--reason", "missing closeout"],
      baseEnv,
      host,
    );

    // The text receipt is the inventory a CLI caller reads; carrying the two
    // hashes only in the JSON view would leave the re-approval unexplained.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sha256:compiled-parked");
    expect(result.stdout).toContain("sha256:compiled-tuned");
    expect(result.stdout).toContain("cctl spec plan sign-off native-sdd");
  });
});

describe("cctl spec plan get and status", () => {
  it("bounds every enumerated section to ten with total, shown, and omitted counts", async () => {
    const { host } = makeHost({
      read: planView({ findingCount: 14, unresolvedCount: 12 }),
    });

    const status = await runCli(
      ["spec", "plan", "status", "native-sdd"],
      baseEnv,
      host,
    );

    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(
      "blocking findings: 14 total, 10 shown, 4 omitted",
    );
    expect(status.stdout).toContain(
      "unresolved dispositions: 12 total, 10 shown, 2 omitted",
    );
  });

  it("bounds the plan document's sections the same way", async () => {
    const { host } = makeHost({ read: planView({ contextCount: 13 }) });

    const result = await runCli(
      ["spec", "plan", "get", "native-sdd"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("contexts: 13 total, 10 shown, 3 omitted");
    expect(result.stdout).toContain("full document: cctl spec plan get");
  });

  it("bounds the wiring nested inside a context, not just the context list", async () => {
    const view = planView({ contextCount: 1 });
    const withWiring = deliveryPlanViewSchema.parse({
      ...view,
      wiringByContext: [
        {
          contextId: "ctx-1",
          entries: Array.from(
            { length: 14 },
            (_unused, index) => `cap-${index + 1} — reached from src/a.ts`,
          ),
        },
      ],
    });
    const { host } = makeHost({ read: withWiring });

    const result = await runCli(
      ["spec", "plan", "get", "native-sdd"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("wiring: 14 total, 10 shown, 4 omitted");
    expect(result.stdout).toContain("cap-10");
    expect(result.stdout).not.toContain("cap-11");
  });

  it("shows the same first ten rows on a second read", async () => {
    const view = planView({ findingCount: 14 });
    const first = await runCli(
      ["spec", "plan", "status", "native-sdd"],
      baseEnv,
      makeHost({ read: view }).host,
    );
    const second = await runCli(
      ["spec", "plan", "status", "native-sdd"],
      baseEnv,
      makeHost({ read: view }).host,
    );

    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout).toContain("R1.10");
    expect(first.stdout).not.toContain("R1.11");
  });

  it("names the act the attempt owes and who performs it", async () => {
    const { host } = makeHost({ read: planView({ findingCount: 2 }) });

    const result = await runCli(
      ["spec", "plan", "status", "native-sdd"],
      baseEnv,
      host,
    );

    expect(result.stdout).toContain(
      "acts next: agent — cctl spec plan edit native-sdd",
    );
    expect(result.stdout).toContain("why: Findings refuse propose.");
  });

  it("carries every row into --json even when the text rendering truncated", async () => {
    const { host } = makeHost({ read: planView({ findingCount: 14 }) });

    const result = await runCli(
      ["spec", "plan", "status", "native-sdd", "--json"],
      baseEnv,
      host,
    );

    const payload = JSON.parse(result.stdout) as {
      plan: { health: { findings: unknown[] } };
    };
    expect(payload.plan.health.findings).toHaveLength(14);
  });

  it("reads the plan through the attempt route, not the spec status route", async () => {
    const { host, requests } = makeHost({});

    await runCli(["spec", "plan", "get", "native-sdd"], baseEnv, host);

    expect(requests[0]?.url).toContain("/api/specs/demo/native-sdd/plan");
    expect(requests[0]?.init.method).toBe("GET");
  });
});

/**
 * The compiled-shape read. What matters is not the rendering but which bytes
 * the two stages promise: a draft preview is explicitly not approvable, and a
 * proposed preview reports the stored candidate hash a launch will run.
 */
describe("cctl spec plan preview --stage", () => {
  function previewView(
    overrides: Partial<DeliveryPlanPreviewView> = {},
  ): DeliveryPlanPreviewView {
    return deliveryPlanPreviewViewSchema.parse({
      stage: "proposed",
      attemptId: "attempt-1",
      specSlug: "native-sdd",
      draftRevision: 3,
      pinnedRevisionId: "revision-approved",
      planHash: "sha256:plan",
      snapshotId: "snapshot-1",
      candidateId: "candidate-1",
      compiledDefinitionHash: "sha256:compiled",
      approvable: true,
      approvability: "Approving the plan approves exactly these bytes.",
      definition: {
        schemaVersion: 1,
        workflowConfig: {},
        charter: {
          mission: "Materialize exactly.",
          invariants: [{ id: "exact-approval", statement: "Launch runs it." }],
          sourcesOfTruth: [
            {
              rank: 1,
              id: "final-design",
              label: "Design",
              type: "document",
              locator: "#47",
              description: "the design",
              accessPolicy: "external-readonly",
            },
          ],
        },
        parameters: [],
        prerequisites: [],
        executionContexts: [
          {
            id: "ctx-only",
            title: "Everything",
            acceptanceCriteria: "It is observable.",
            placement: { lane: "ctx-only", mode: "full" },
          },
        ],
        tasks: [
          {
            id: "task-only",
            contextId: "ctx-only",
            order: 1,
            title: "Do it",
            instructions: "Make it observable.",
            source: "user",
          },
        ],
        edges: [],
      },
      packManifests: [
        { contextId: "ctx-only", total: 3, included: 2, omitted: 1 },
      ],
      ...overrides,
    });
  }

  function previewHost(view: DeliveryPlanPreviewView): {
    host: CliHost;
    requests: RecordedRequest[];
    readPaths: string[];
  } {
    const requests: RecordedRequest[] = [];
    const readPaths: string[] = [];
    return {
      requests,
      readPaths,
      host: {
        async fetch(url, init) {
          requests.push({ url, init });
          return response(view);
        },
        async readTextFile(path) {
          readPaths.push(path);
          return null;
        },
        async readFileBytes() {
          return null;
        },
        async sleep() {},
        platform: "darwin",
        homedir: "/Users/test",
      },
    };
  }

  it.each([
    { label: "without --stage", args: [] },
    {
      label: "with retired --scope",
      args: ["--stage", "draft", "--scope", "/tmp/scope.json"],
    },
    {
      label: "with retired --context",
      args: ["--stage", "draft", "--context", "context-old"],
    },
    {
      label: "with retired --revision",
      args: ["--stage", "proposed", "--revision", "revision-old"],
    },
  ])("refuses locally $label and names the DPA migration", async ({ args }) => {
    const { host, requests, readPaths } = previewHost(previewView());

    const result = await runCli(
      ["spec", "plan", "preview", "native-sdd", ...args],
      baseEnv,
      host,
    );

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "cctl spec plan open native-sdd --seed-from last",
    );
    expect(`${result.stdout}${result.stderr}`).toContain(
      "cctl spec plan preview native-sdd --stage draft",
    );
    expect(readPaths).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it("reads the frozen candidate and reports the hash a launch will run", async () => {
    const { host, requests } = previewHost(previewView());

    const result = await runCli(
      ["spec", "plan", "preview", "native-sdd", "--stage", "proposed"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(requests[0]?.init.method).toBe("GET");
    expect(requests[0]?.url).toContain("/plan-preview?stage=proposed");
    expect(result.stdout).toContain("sha256:compiled");
    expect(result.stdout).toContain("approvable: yes");
    expect(result.stdout).toContain("2 of 3 criteria included, 1 omitted");
  });

  it("carries the compare-and-swap token on a draft preview and says it is not approvable", async () => {
    const { host, requests } = previewHost(
      previewView({
        stage: "draft",
        snapshotId: null,
        candidateId: null,
        approvable: false,
        approvability:
          "Run cctl spec plan propose native-sdd to freeze these bytes.",
      }),
    );

    const result = await runCli(
      [
        "spec",
        "plan",
        "preview",
        "native-sdd",
        "--stage",
        "draft",
        "--expected-draft-revision",
        "3",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(requests[0]?.url).toContain("stage=draft");
    expect(requests[0]?.url).toContain("expectedDraftRevision=3");
    expect(result.stdout).toContain("approvable: no");
  });

  it("refuses an unknown stage rather than silently previewing the revision", async () => {
    const { host, requests } = previewHost(previewView());

    const result = await runCli(
      ["spec", "plan", "preview", "native-sdd", "--stage", "frozen"],
      baseEnv,
      host,
    );

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("draft or proposed");
    expect(requests).toHaveLength(0);
  });

  it("refuses the draft compare-and-swap token on a proposed preview", async () => {
    const { host, requests } = previewHost(previewView());

    const result = await runCli(
      [
        "spec",
        "plan",
        "preview",
        "native-sdd",
        "--stage",
        "proposed",
        "--expected-draft-revision",
        "3",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("--stage draft");
    expect(requests).toHaveLength(0);
  });
});

describe("cctl spec plan sign-off", () => {
  const CANDIDATE = {
    candidateId: "candidate-1",
    planHash: "sha256:plan",
    compiledDefinitionHash: "sha256:compiled",
  };

  function signOffView(
    admission: DeliveryPlanMutationView["executionStartAdmission"],
  ): DeliveryPlanMutationView {
    const base = mutationView({ status: "approved" });
    return deliveryPlanMutationViewSchema.parse({
      ...base,
      approval: {
        snapshotId: "snapshot-1",
        ...CANDIDATE,
        approvedAt: "2026-08-08T10:00:00.000Z",
        approvedBy: { kind: "human" },
      },
      executionStartAdmission: admission,
    });
  }

  /** Answers the preview read the verb makes, then the sign-off write. */
  function signOffHost(view: DeliveryPlanMutationView): {
    host: CliHost;
    requests: RecordedRequest[];
  } {
    const requests: RecordedRequest[] = [];
    return {
      requests,
      host: {
        async fetch(url, init) {
          requests.push({ url, init });
          if (init.method === "GET") {
            return response(
              deliveryPlanPreviewViewSchema.parse({
                stage: "proposed",
                attemptId: "attempt-1",
                specSlug: "native-sdd",
                draftRevision: 3,
                pinnedRevisionId: "revision-approved",
                planHash: CANDIDATE.planHash,
                snapshotId: "snapshot-1",
                candidateId: CANDIDATE.candidateId,
                compiledDefinitionHash: CANDIDATE.compiledDefinitionHash,
                approvable: true,
                approvability: "These are the bytes a launch runs.",
                definition: {
                  schemaVersion: 1,
                  workflowConfig: {},
                  charter: {
                    mission: "Ship it.",
                    invariants: [
                      { id: "exact-approval", statement: "Launch runs it." },
                    ],
                    sourcesOfTruth: [
                      {
                        rank: 1,
                        id: "final-design",
                        label: "Design",
                        type: "document",
                        locator: "#47",
                        description: "the design",
                        accessPolicy: "external-readonly",
                      },
                    ],
                  },
                  parameters: [],
                  prerequisites: [],
                  executionContexts: [],
                  tasks: [],
                  edges: [],
                },
                packManifests: [],
              }),
            );
          }
          return response(view);
        },
        async readTextFile() {
          return null;
        },
        async readFileBytes() {
          return null;
        },
        async sleep() {},
        platform: "darwin",
        homedir: "/Users/test",
      },
    };
  }

  it("reads the stored candidate and signs off exactly the identity it names", async () => {
    const { host, requests } = signOffHost(
      signOffView({
        dial: "gate",
        basis: "human_approval",
        admissionId: "admission-1",
        approvalId: "approval-1",
      }),
    );

    const result = await runCli(
      ["spec", "plan", "sign-off", "native-sdd"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(requests[0]?.init.method).toBe("GET");
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual(CANDIDATE);
    expect(result.stdout).toContain("sha256:compiled");
    expect(result.stdout).toContain("admitted the execution_start gate");
  });

  it("states the policy basis when the dial admits without a human", async () => {
    const { host } = signOffHost(
      signOffView({
        dial: "notify",
        basis: "notify_policy",
        admissionId: "admission-2",
        approvalId: null,
      }),
    );

    const result = await runCli(
      ["spec", "plan", "sign-off", "native-sdd"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("notify_policy");
    expect(result.stdout).toContain("admission-2");
  });

  it("refuses a partial candidate identity rather than binding to bytes nobody named", async () => {
    const { host, requests } = signOffHost(
      signOffView({
        dial: "gate",
        basis: "human_approval",
        admissionId: "admission-1",
        approvalId: "approval-1",
      }),
    );

    const result = await runCli(
      ["spec", "plan", "sign-off", "native-sdd", "--candidate", "candidate-1"],
      baseEnv,
      host,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--plan-hash");
    expect(result.stderr).toContain("--compiled-hash");
    expect(requests).toHaveLength(0);
  });
});
