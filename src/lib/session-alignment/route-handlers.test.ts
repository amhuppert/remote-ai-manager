import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withTracing } from "@/lib/logging";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import type { PersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import {
  createSessionAlignmentRepo,
  type SessionAlignmentRepo,
} from "@/lib/session-alignment/repo";
import {
  SCAFFOLD_TEMPLATE,
  computeAlignmentHash,
  renderAlignmentPromptSection,
  usesDigestPointer,
} from "@/lib/session-alignment/render";
import {
  alignmentDiffSchema,
  alignmentStateSchema,
  alignmentVersionSchema,
  type SessionAlignmentUpdatedEvent,
} from "@/lib/session-alignment/schemas";
import {
  AlignmentDraftNotFoundError,
  AlignmentNotSupportedError,
  AlignmentProposalBatchNotFoundError,
  AlignmentVersionNotFoundError,
  createSessionAlignmentService,
  type CharterMirrorCall,
  type SessionAlignmentService,
  type SessionAlignmentServiceDeps,
} from "@/lib/session-alignment/service";
import type { CharterMirrorWriteResult } from "@/lib/session-alignment/mirror";
import {
  createSessionAlignmentRouteHandlers,
  type SessionAlignmentRouteHandlers,
} from "@/lib/session-alignment/route-handlers";

const PROJECT_NAME = "p1";
const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";
const WORKTREE_PATH = "/p1/.worktrees/s1";
const CONVERSATION_ID = "conv-1";

function makeContext(): { params: Promise<Record<string, string>> } {
  return {
    params: Promise.resolve({ name: PROJECT_NAME, session: SESSION_NAME }),
  };
}

function makeRequest(url: string, body?: unknown): Request {
  return new Request(url, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });
}

// ============================================================
// Real-service harness (happy-path state transitions)
// ============================================================

interface RealHarness {
  fixture: PersistenceFixture;
  repo: SessionAlignmentRepo;
  service: SessionAlignmentService;
  handlers: SessionAlignmentRouteHandlers;
  mirrorCalls: CharterMirrorCall[];
  broadcasts: SessionAlignmentUpdatedEvent[];
}

function makeRealService(fixture: PersistenceFixture): {
  service: SessionAlignmentService;
  repo: SessionAlignmentRepo;
  mirrorCalls: CharterMirrorCall[];
  broadcasts: SessionAlignmentUpdatedEvent[];
} {
  const repo = createSessionAlignmentRepo(fixture.db);
  const mirrorCalls: CharterMirrorCall[] = [];
  const broadcasts: SessionAlignmentUpdatedEvent[] = [];

  let idCounter = 0;
  let clock = 0;

  const deps: SessionAlignmentServiceDeps = {
    repo,
    render: {
      renderAlignmentPromptSection,
      computeAlignmentHash,
      usesDigestPointer,
      scaffoldTemplate: SCAFFOLD_TEMPLATE,
    },
    mirror: {
      async write(input): Promise<CharterMirrorWriteResult> {
        mirrorCalls.push({ ...input });
        return { ok: true, filePath: ".cc/session-alignment/charter.md" };
      },
    },
    snapshot: {
      write() {
        return Promise.resolve({
          filePath: ".cc/session-alignment/snapshots/frozen.md",
          created: true,
        });
      },
    },
    broadcast(event) {
      if (event.type === "session-alignment-updated") {
        broadcasts.push(event);
      }
      return { delivered: true };
    },
    promptQueue: {
      async enqueue() {
        /* no-op */
      },
    },
    loadSession(projectPath, sessionName) {
      return Promise.resolve(
        projectPath === PROJECT_PATH && sessionName === SESSION_NAME
          ? { worktreePath: WORKTREE_PATH, creationMode: "normal" as const }
          : null,
      );
    },
    now: () => {
      clock += 1000;
      return new Date(clock).toISOString();
    },
    newId: () => {
      idCounter += 1;
      return `id-${idCounter}`;
    },
  };

  return {
    service: createSessionAlignmentService(deps),
    repo,
    mirrorCalls,
    broadcasts,
  };
}

function setupReal(): RealHarness {
  const fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME, { creationMode: "normal" });
  const { service, repo, mirrorCalls, broadcasts } = makeRealService(fixture);
  const handlers = createSessionAlignmentRouteHandlers({
    resolveProjectPath: (name) =>
      Promise.resolve(name === PROJECT_NAME ? PROJECT_PATH : null),
    service,
  });
  return { fixture, repo, service, handlers, mirrorCalls, broadcasts };
}

/** Seed and activate a charter through the real service; returns the version. */
async function activateCharter(
  service: SessionAlignmentService,
  content: string,
): Promise<number> {
  const begin = await service.beginDraft({
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    conversationId: CONVERSATION_ID,
  });
  await service.fillDraft({
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    conversationId: CONVERSATION_ID,
    content,
  });
  const active = await service.approveDraft({
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    draftId: begin.draftId,
  });
  if (active.version === null) throw new Error("no version assigned");
  return active.version;
}

let real: RealHarness;

beforeEach(() => {
  real = setupReal();
});

afterEach(() => {
  real.fixture.close();
});

describe("getAlignmentState", () => {
  it("returns 200 with a schema-valid aggregate including a preview when a charter is active", async () => {
    await activateCharter(real.service, "# Mission\nDeliver alignment.");

    const response = await real.handlers.getAlignmentState(
      makeRequest(
        `http://t/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/alignment`,
      ),
      makeContext(),
    );

    expect(response.status).toBe(200);
    const body = alignmentStateSchema.parse(await response.json());
    expect(body.active?.version).toBe(1);
    expect(body.draft).toBeNull();
    expect(body.history.map((v) => v.version)).toEqual([1]);
    expect(body.decisions).toEqual([]);
    expect(body.pendingProposals).toEqual([]);
    expect(body.preview).toBe(
      renderAlignmentPromptSection({
        content: "# Mission\nDeliver alignment.",
      }),
    );
  });

  /**
   * R1.2: alignment resolves the project itself rather than going through the
   * session resolution seam, so the sentinel used to be carried into the service
   * as a session name and answered with a domain error about a session that does
   * not exist. Run through `withTracing` because that is what puts the request
   * path on the trace context the refusal names its replacement from.
   */
  it("refuses the internal project sentinel in the public session position", async () => {
    const traced = withTracing(real.handlers.getAlignmentState);

    const response = await traced(
      makeRequest(
        `http://t/api/projects/${PROJECT_NAME}/sessions/${PROJECT_CONVERSATION_SESSION_SENTINEL}/alignment`,
      ),
      {
        params: Promise.resolve({
          name: PROJECT_NAME,
          session: PROJECT_CONVERSATION_SESSION_SENTINEL,
        }),
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    // Alignment is session-only by spec non-goal, so the refusal says so rather
    // than naming a project route that would 404.
    expect(body.error).toContain("alignment");
    expect(body.error).toContain("session-only");
    expect(body.error).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
  });

  it("returns 404 for an unknown project", async () => {
    const handlers = createSessionAlignmentRouteHandlers({
      resolveProjectPath: () => Promise.resolve(null),
      service: real.service,
    });
    const response = await handlers.getAlignmentState(
      makeRequest("http://t/api/projects/missing/sessions/s1/alignment"),
      { params: Promise.resolve({ name: "missing", session: SESSION_NAME }) },
    );
    expect(response.status).toBe(404);
  });

  it("returns 200 with an empty aggregate and null preview when no charter exists", async () => {
    const response = await real.handlers.getAlignmentState(
      makeRequest(
        `http://t/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/alignment`,
      ),
      makeContext(),
    );
    expect(response.status).toBe(200);
    const state = alignmentStateSchema.parse(await response.json());
    expect(state.active).toBeNull();
    expect(state.draft).toBeNull();
    expect(state.history).toEqual([]);
    expect(state.preview).toBeNull();
  });
});

describe("approveCharterDraft", () => {
  it("activates a filled draft and returns 200 with the new active version; the store shows it active", async () => {
    const begin = await real.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });
    await real.service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content: "# Mission\nVersion one.",
    });

    const response = await real.handlers.approveCharterDraft(
      makeRequest(
        `http://t/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/alignment/charter/approve`,
        { draftId: begin.draftId, approver: "alex" },
      ),
      makeContext(),
    );

    expect(response.status).toBe(200);
    const version = alignmentVersionSchema.parse(await response.json());
    expect(version.status).toBe("active");
    expect(version.version).toBe(1);
    expect(version.approver).toBe("alex");

    const active = real.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME);
    expect(active?.version).toBe(1);
    expect(active?.content).toBe("# Mission\nVersion one.");
    expect(real.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
  });

  it("returns 400 for an invalid body", async () => {
    const response = await real.handlers.approveCharterDraft(
      makeRequest(
        `http://t/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/alignment/charter/approve`,
        { draftId: "" },
      ),
      makeContext(),
    );
    expect(response.status).toBe(400);
  });
});

describe("rejectCharterDraft", () => {
  it("returns 200 and leaves the active charter unchanged in the store", async () => {
    await activateCharter(real.service, "# Mission\nGoverning charter.");
    const redraft = await real.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });
    await real.service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content: "# Mission\nRejected rewrite.",
    });

    const response = await real.handlers.rejectCharterDraft(
      makeRequest(
        `http://t/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/alignment/charter/reject`,
        { draftId: redraft.draftId },
      ),
      makeContext(),
    );

    expect(response.status).toBe(200);
    const active = real.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME);
    expect(active?.version).toBe(1);
    expect(active?.content).toBe("# Mission\nGoverning charter.");
    expect(real.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
  });

  it("returns 400 for an invalid body", async () => {
    const response = await real.handlers.rejectCharterDraft(
      makeRequest(
        `http://t/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/alignment/charter/reject`,
        { draftId: "" },
      ),
      makeContext(),
    );
    expect(response.status).toBe(400);
  });
});

describe("resolveDecisionProposals", () => {
  it("returns 200 with {approved,rejected} and creates an auto-activating draft", async () => {
    const { batchId } = await real.service.proposeDecisions({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      decisions: [{ statement: "keep" }, { statement: "drop" }],
    });
    const proposalIds = real.repo
      .findProposalsByBatch(PROJECT_PATH, SESSION_NAME, batchId)
      .map((p) => p.id);

    const response = await real.handlers.resolveDecisionProposals(
      makeRequest(
        `http://t/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/alignment/decisions/resolve`,
        {
          batchId,
          resolutions: [
            { proposalId: proposalIds[0]!, approve: true },
            { proposalId: proposalIds[1]!, approve: false },
          ],
        },
      ),
      makeContext(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      approved: number;
      rejected: number;
    };
    expect(body).toEqual({ approved: 1, rejected: 1 });

    // One approved decision logged + an auto-activate draft created. The final
    // activated version is downstream (agent-driven, task 8.3): assert counts.
    expect(
      real.repo.findDecisionsReverseChron(PROJECT_PATH, SESSION_NAME),
    ).toHaveLength(1);
    const draft = real.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME);
    expect(draft?.autoActivate).toBe(true);
    expect(draft?.source).toBe("decision");
  });

  it("returns 400 for an invalid body", async () => {
    const response = await real.handlers.resolveDecisionProposals(
      makeRequest(
        `http://t/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/alignment/decisions/resolve`,
        { batchId: "", resolutions: [] },
      ),
      makeContext(),
    );
    expect(response.status).toBe(400);
  });
});

describe("getAlignmentDiff", () => {
  it("returns 200 with from/to content for valid query params", async () => {
    await activateCharter(real.service, "v1 content");
    // Activate a second version on top.
    const begin = await real.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });
    await real.service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content: "v2 content",
    });
    await real.service.approveDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      draftId: begin.draftId,
    });

    const response = await real.handlers.getAlignmentDiff(
      makeRequest(
        `http://t/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/alignment/diff?from=1&to=2`,
      ),
      makeContext(),
    );

    expect(response.status).toBe(200);
    const diff = alignmentDiffSchema.parse(await response.json());
    expect(diff).toEqual({
      from: 1,
      to: 2,
      fromContent: "v1 content",
      toContent: "v2 content",
    });
  });

  it("returns 404 when a requested version does not exist", async () => {
    await activateCharter(real.service, "only");
    const response = await real.handlers.getAlignmentDiff(
      makeRequest(
        `http://t/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/alignment/diff?from=1&to=99`,
      ),
      makeContext(),
    );
    expect(response.status).toBe(404);
  });

  it("returns 400 when query params are missing", async () => {
    const response = await real.handlers.getAlignmentDiff(
      makeRequest(
        `http://t/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/alignment/diff`,
      ),
      makeContext(),
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when query params are non-integer", async () => {
    const response = await real.handlers.getAlignmentDiff(
      makeRequest(
        `http://t/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/alignment/diff?from=abc&to=2`,
      ),
      makeContext(),
    );
    expect(response.status).toBe(400);
  });
});

describe("rollbackAlignment", () => {
  it("returns 200 with a new active version whose content equals the target", async () => {
    await activateCharter(real.service, "v1 content");
    const begin = await real.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });
    await real.service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content: "v2 content",
    });
    await real.service.approveDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      draftId: begin.draftId,
    });

    const response = await real.handlers.rollbackAlignment(
      makeRequest(
        `http://t/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/alignment/rollback`,
        { version: 1 },
      ),
      makeContext(),
    );

    expect(response.status).toBe(200);
    const version = alignmentVersionSchema.parse(await response.json());
    expect(version.status).toBe("active");
    expect(version.version).toBe(3);
    expect(version.content).toBe("v1 content");

    const active = real.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME);
    expect(active?.version).toBe(3);
    expect(active?.content).toBe("v1 content");
  });

  it("returns 400 for an invalid body", async () => {
    const response = await real.handlers.rollbackAlignment(
      makeRequest(
        `http://t/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/alignment/rollback`,
        { version: "one" },
      ),
      makeContext(),
    );
    expect(response.status).toBe(400);
  });
});

// ============================================================
// Error-mapping (tiny fake service throwing domain errors)
// ============================================================

type ServiceOverrides = Partial<SessionAlignmentService>;

function makeFakeHandlers(
  overrides: ServiceOverrides,
): SessionAlignmentRouteHandlers {
  const throwing = (): never => {
    throw new Error("not implemented in this fake");
  };
  const service: SessionAlignmentService = {
    beginDraft: throwing,
    fillDraft: throwing,
    approveDraft: throwing,
    rejectDraft: throwing,
    proposeDecisions: throwing,
    resolveProposals: throwing,
    getState: throwing,
    getActiveVersion: throwing,
    getActiveInjection: throwing,
    captureActiveCharterForRun: throwing,
    diff: throwing,
    rollback: throwing,
    copyActiveCharter: throwing,
    createAndActivateTicketCharter: throwing,
    ...overrides,
  };
  return createSessionAlignmentRouteHandlers({
    resolveProjectPath: () => Promise.resolve(PROJECT_PATH),
    service,
  });
}

describe("domain-error → status mapping", () => {
  it("maps AlignmentNotSupportedError (optimistic session) to 409", async () => {
    const handlers = makeFakeHandlers({
      getState() {
        throw new AlignmentNotSupportedError(
          "alignment is unavailable for optimistic sessions",
        );
      },
    });
    const response = await handlers.getAlignmentState(
      makeRequest(
        `http://t/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/alignment`,
      ),
      makeContext(),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("optimistic");
  });

  it("maps AlignmentDraftNotFoundError to 404", async () => {
    const handlers = makeFakeHandlers({
      approveDraft() {
        throw new AlignmentDraftNotFoundError("no open draft missing");
      },
    });
    const response = await handlers.approveCharterDraft(
      makeRequest(
        `http://t/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/alignment/charter/approve`,
        { draftId: "missing" },
      ),
      makeContext(),
    );
    expect(response.status).toBe(404);
  });

  it("maps AlignmentProposalBatchNotFoundError (stale batch) to 409", async () => {
    const handlers = makeFakeHandlers({
      resolveProposals() {
        throw new AlignmentProposalBatchNotFoundError("no pending batch stale");
      },
    });
    const response = await handlers.resolveDecisionProposals(
      makeRequest(
        `http://t/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/alignment/decisions/resolve`,
        { batchId: "stale", resolutions: [{ proposalId: "x", approve: true }] },
      ),
      makeContext(),
    );
    expect(response.status).toBe(409);
  });

  it("maps AlignmentVersionNotFoundError (rollback to unknown version) to 404", async () => {
    const handlers = makeFakeHandlers({
      rollback() {
        throw new AlignmentVersionNotFoundError("version 42 not found");
      },
    });
    const response = await handlers.rollbackAlignment(
      makeRequest(
        `http://t/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/alignment/rollback`,
        { version: 42 },
      ),
      makeContext(),
    );
    expect(response.status).toBe(404);
  });

  it("maps an unexpected error to 500", async () => {
    const handlers = makeFakeHandlers({
      getState() {
        throw new Error("boom");
      },
    });
    const response = await handlers.getAlignmentState(
      makeRequest(
        `http://t/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/alignment`,
      ),
      makeContext(),
    );
    expect(response.status).toBe(500);
  });
});
