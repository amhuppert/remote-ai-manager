import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { createSessionAlignmentRepo } from "@/lib/session-alignment/repo";
import {
  createSessionAlignmentService,
  type SessionAlignmentService,
} from "@/lib/session-alignment/service";
import {
  renderAlignmentPromptSection,
  computeAlignmentHash,
  SCAFFOLD_TEMPLATE,
} from "@/lib/session-alignment/render";
import {
  createConversationCommandService,
  type ConversationCommandDeps,
  type RunCommandInput,
} from "@/lib/conversation-commands/service";

// End-to-end verification (8.2) of the `/align` authoring and approval flow:
// the real conversation-command service drives `/align` (scaffold on first run,
// existing charter on rerun, never archiving the conversation), and the real
// alignment service over a shared SQLite store fills/approves drafts. The
// load-bearing assertions are at the injection seam (`getActiveInjection`) —
// the exact governing section agents receive — proving a draft stays
// non-governing until approval and that approval activates and supersedes
// (R3.2, R3.4, R3.5, R4.2, R4.3, R4.5).

const PROJECT = "/p-align-e2e";
const SESSION = "align-e2e";
const CONVERSATION = "conv-e2e";

interface Harness {
  fixture: PersistenceFixture;
  service: SessionAlignmentService;
  commandService: ReturnType<typeof createConversationCommandService>;
  commandDeps: ConversationCommandDeps;
  enqueuedAuthoringTurns: Array<{ message: string }>;
  openDraftId: () => string;
}

function setup(): Harness {
  const fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT);
  fixture.seedSession(PROJECT, SESSION, { creationMode: "normal" });

  const repo = createSessionAlignmentRepo(fixture.db);
  const service = createSessionAlignmentService({
    repo,
    render: {
      renderAlignmentPromptSection,
      computeAlignmentHash,
      scaffoldTemplate: SCAFFOLD_TEMPLATE,
    },
    mirror: {
      async write() {
        return { ok: true, filePath: ".cc/session-alignment/charter.md" };
      },
    },
    broadcast() {},
    promptQueue: { async enqueue() {} },
    loadSession(projectPath, sessionName) {
      return Promise.resolve(
        projectPath === PROJECT && sessionName === SESSION
          ? {
              worktreePath: `${PROJECT}/.worktrees/${SESSION}`,
              creationMode: "normal" as const,
            }
          : null,
      );
    },
  });

  const enqueuedAuthoringTurns: Harness["enqueuedAuthoringTurns"] = [];
  const commandDeps: ConversationCommandDeps = {
    getSession: vi.fn(async (projectPath: string, sessionName: string) =>
      projectPath === PROJECT && sessionName === SESSION
        ? sessionStateSchema.parse({
            sessionName: SESSION,
            worktreePath: `${PROJECT}/.worktrees/${SESSION}`,
            branchName: `csm/${SESSION}`,
            createdAt: "2026-01-01T00:00:00.000Z",
            lastActivityAt: "2026-01-01T00:00:00.000Z",
            creationMode: "normal",
          })
        : null,
    ),
    hasActiveJob: vi.fn(() => false),
    hasUncommittedChanges: vi.fn(async () => true),
    collectChangeSummary: vi.fn(async () => ""),
    resolveMergeTarget: vi.fn(async () => ({
      targetBranch: "main",
      targetWorktreePath: null,
    })),
    executeWorkflowTaskRun: vi.fn(async () => {
      throw new Error("the /align path must not run a generation turn");
    }),
    dispatchCommitJob: vi.fn(() => ({
      ok: true as const,
      value: { jobId: "job-commit" },
    })),
    dispatchMergeJob: vi.fn(() => ({
      ok: true as const,
      value: { jobId: "job-merge" },
    })),
    appendNotice: vi.fn(async () => {}),
    beginAlignmentDraft: (input) =>
      service.beginDraft({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
      }),
    enqueueAuthoringTurn: async (input) => {
      enqueuedAuthoringTurns.push({ message: input.message });
    },
    runTicketCommand: async () => {
      throw new Error("the /align flow must not run the ticket command");
    },
    getConversationRole: async () => null,
  };

  return {
    fixture,
    service,
    commandService: createConversationCommandService(commandDeps),
    commandDeps,
    enqueuedAuthoringTurns,
    openDraftId: () => {
      const draft = repo.findDraftVersion(PROJECT, SESSION);
      if (!draft) throw new Error("expected an open draft");
      return draft.id;
    },
  };
}

function alignInput(): RunCommandInput {
  return {
    projectPath: PROJECT,
    projectName: "p-align-e2e",
    sessionName: SESSION,
    conversationId: CONVERSATION,
    parsed: { command: "align", hint: "" },
  };
}

function expectNoGitMachinery(deps: ConversationCommandDeps): void {
  expect(deps.executeWorkflowTaskRun).not.toHaveBeenCalled();
  expect(deps.dispatchCommitJob).not.toHaveBeenCalled();
  expect(deps.dispatchMergeJob).not.toHaveBeenCalled();
  expect(deps.appendNotice).not.toHaveBeenCalled();
}

let fixtures: PersistenceFixture[] = [];
afterEach(() => {
  for (const f of fixtures) f.close();
  fixtures = [];
});

describe("/align authoring and approval flow (end-to-end)", () => {
  it("scaffolds a non-governing first draft, activates on approval, redrafts from the charter, supersedes, and rejects without change", async () => {
    const h = setup();
    fixtures.push(h.fixture);

    const lastTurn = () =>
      h.enqueuedAuthoringTurns[h.enqueuedAuthoringTurns.length - 1]!.message;

    // --- First run: /align with no charter seeds the scaffold (R3.2) and does
    // not archive the conversation or run any git machinery.
    const first = await h.commandService.run(alignInput());
    expect(first.status).toBe("alignment_draft_started");
    expect(lastTurn()).toContain(SCAFFOLD_TEMPLATE);
    expectNoGitMachinery(h.commandDeps);

    // The draft is non-governing: nothing is injected into turns yet (R3.5/R4.4).
    expect(await h.service.getActiveVersion(PROJECT, SESSION)).toBeNull();
    expect(await h.service.getActiveInjection(PROJECT, SESSION)).toBeNull();

    // Filling the draft still does not change the governing context (R4.3).
    await h.service.fillDraft({
      projectPath: PROJECT,
      sessionName: SESSION,
      conversationId: CONVERSATION,
      content: "# Mission\nShip the alignment feature. v1 governing content.",
    });
    expect(await h.service.getActiveInjection(PROJECT, SESSION)).toBeNull();

    // --- Approval activates v1 (R4.2): the governing injection now exists and
    // carries the v1 content.
    const v1 = await h.service.approveDraft({
      projectPath: PROJECT,
      sessionName: SESSION,
      draftId: h.openDraftId(),
    });
    expect(v1.version).toBe(1);
    const injectedV1 = await h.service.getActiveInjection(PROJECT, SESSION);
    expect(injectedV1?.version).toBe(1);
    expect(injectedV1?.text).toContain("v1 governing content.");

    // --- Rerun: /align with an active charter redrafts FROM the charter, not
    // the scaffold (R3.4), and the active charter keeps governing (R3.5/R4.3).
    h.enqueuedAuthoringTurns.length = 0;
    const rerun = await h.commandService.run(alignInput());
    expect(rerun.status).toBe("alignment_draft_started");
    expect(lastTurn()).toContain("v1 governing content.");
    expect(lastTurn()).not.toContain(SCAFFOLD_TEMPLATE);
    // The open redraft is still non-governing: agents keep receiving v1.
    expect(
      (await h.service.getActiveInjection(PROJECT, SESSION))?.version,
    ).toBe(1);

    await h.service.fillDraft({
      projectPath: PROJECT,
      sessionName: SESSION,
      conversationId: CONVERSATION,
      content: "# Mission\nShip it. v2 governing content after redraft.",
    });
    // Still v1 until the redraft is approved.
    expect(
      (await h.service.getActiveInjection(PROJECT, SESSION))?.version,
    ).toBe(1);

    // --- Approving the rerun activates v2 and supersedes v1 (R4.5).
    const v2 = await h.service.approveDraft({
      projectPath: PROJECT,
      sessionName: SESSION,
      draftId: h.openDraftId(),
    });
    expect(v2.version).toBe(2);
    const injectedV2 = await h.service.getActiveInjection(PROJECT, SESSION);
    expect(injectedV2?.version).toBe(2);
    expect(injectedV2?.text).toContain("v2 governing content after redraft.");

    const state = await h.service.getState(PROJECT, SESSION);
    expect(state.active?.version).toBe(2);
    const v1Row = state.history.find((v) => v.version === 1);
    expect(v1Row?.status).toBe("superseded");

    // --- Reject branch: a new /align draft that is rejected leaves the active
    // charter unchanged (R4.5).
    h.enqueuedAuthoringTurns.length = 0;
    await h.commandService.run(alignInput());
    await h.service.rejectDraft({
      projectPath: PROJECT,
      sessionName: SESSION,
      draftId: h.openDraftId(),
    });
    const afterReject = await h.service.getActiveInjection(PROJECT, SESSION);
    expect(afterReject?.version).toBe(2);
    expect(afterReject?.text).toContain("v2 governing content after redraft.");

    // Across all three `/align` runs (first, rerun, reject) the conversation is
    // never archived: no commit/merge job machinery ran and no notice was
    // appended (the deps accumulate calls, so this proves it cumulatively).
    expectNoGitMachinery(h.commandDeps);
  });
});
