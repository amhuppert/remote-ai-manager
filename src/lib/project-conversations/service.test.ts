import { afterEach, describe, it, expect, beforeEach } from "vitest";
import {
  createProjectConversationService,
  type ProjectConversationServiceDeps,
} from "./service";
import type { ConversationState } from "@/lib/conversations/schemas";
import { BackgroundWorkUnstoppedError } from "@/lib/conversation-core/background-work";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

/**
 * In-memory persistence fake so the service's real orchestration (title
 * generation, backend default, lifecycle transitions, open-count) is exercised
 * against genuine read/write behavior — not mock call-counting.
 */
function makeDeps(
  overrides: Partial<ProjectConversationServiceDeps> = {},
): ProjectConversationServiceDeps {
  const rows = new Map<string, ConversationState>();
  const key = (p: string, id: string) => `${p}::${id}`;
  let n = 0;
  return {
    async createProjectConversationRecord(projectPath, conversation) {
      rows.set(key(projectPath, conversation.id), conversation);
    },
    async getProjectConversation(projectPath, id) {
      return rows.get(key(projectPath, id)) ?? null;
    },
    async getProjectConversations(projectPath) {
      const prefix = `${projectPath}::`;
      return [...rows.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
    },
    async mutateProjectConversation(projectPath, id, _label, mutate) {
      const c = rows.get(key(projectPath, id));
      if (!c) throw new Error("not found");
      const result = await mutate(c);
      c.lastActivityAt = "mutated";
      rows.set(key(projectPath, id), c);
      return result;
    },
    async setProjectConversationArchived(projectPath, id, archived) {
      const c = rows.get(key(projectPath, id));
      if (!c) throw new Error("not found");
      c.archived = archived;
    },
    async setProjectConversationOpen(projectPath, id, open) {
      const c = rows.get(key(projectPath, id));
      if (!c) throw new Error("not found");
      c.open = open;
    },
    async markProjectConversationRead(projectPath, id) {
      const c = rows.get(key(projectPath, id));
      if (!c) throw new Error("not found");
      c.unread = false;
    },
    async readConfig() {
      return { defaultAgentBackend: "claude" as const };
    },
    getProjectDisplayName() {
      return "my-project";
    },
    newId: () => `id-${++n}`,
    now: () => "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ProjectConversationService", () => {
  let deps: ProjectConversationServiceDeps;
  let service: ReturnType<typeof createProjectConversationService>;

  beforeEach(() => {
    deps = makeDeps();
    service = createProjectConversationService(deps);
  });

  it("creates a persisted project conversation with scope:project, open:true, and a human-readable title", async () => {
    const created = await service.createProjectConversation("/repo");
    expect(created.scope).toBe("project");
    expect(created.open).toBe(true);
    expect(created.archived).toBe(false);
    expect(created.status).toBe("new");
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("my-project chat 1");

    const fetched = await service.getProjectConversation("/repo", created.id);
    expect(fetched?.id).toBe(created.id);
  });

  it("records the creating submission's token on the conversation, and nothing when there is none", async () => {
    // The token is how the client that posted a create-and-send turn recognises
    // the conversation created for it in the project conversation list, which
    // otherwise says only which conversations exist.
    const forSubmission = await service.createProjectConversation("/repo", {
      creationRequestId: "req-abc",
    });
    expect(forSubmission.creationRequestId).toBe("req-abc");
    expect(
      (await service.getProjectConversation("/repo", forSubmission.id))
        ?.creationRequestId,
    ).toBe("req-abc");

    // Created through the explicit create route: the caller already has the id
    // in the response, so there is nothing to correlate and no token to record.
    const explicit = await service.createProjectConversation("/repo");
    expect(explicit.creationRequestId).toBeUndefined();
  });

  it("assigns a stable, incrementing default title per project", async () => {
    const a = await service.createProjectConversation("/repo");
    const b = await service.createProjectConversation("/repo");
    expect(a.name).toBe("my-project chat 1");
    expect(b.name).toBe("my-project chat 2");
    expect(a.id).not.toBe(b.id);
  });

  it("uses the config default backend and honors an explicit override", async () => {
    const def = await service.createProjectConversation("/repo");
    expect(def.agentBackend).toBe("claude");
    const codex = await service.createProjectConversation("/repo", {
      agentBackend: "codex",
    });
    expect(codex.agentBackend).toBe("codex");
  });

  it("uses an explicit name when provided", async () => {
    const created = await service.createProjectConversation("/repo", {
      name: "Refactor auth",
    });
    expect(created.name).toBe("Refactor auth");
  });

  it("closing sets open:false without archiving; archiving sets archived:true", async () => {
    const c = await service.createProjectConversation("/repo");
    await service.setProjectConversationOpen("/repo", c.id, false);
    let fetched = await service.getProjectConversation("/repo", c.id);
    expect(fetched?.open).toBe(false);
    expect(fetched?.archived).toBe(false);

    await service.setProjectConversationArchived("/repo", c.id, true);
    fetched = await service.getProjectConversation("/repo", c.id);
    expect(fetched?.archived).toBe(true);
  });

  it("renames a project conversation", async () => {
    const c = await service.createProjectConversation("/repo");
    await service.renameProjectConversation("/repo", c.id, "Renamed");
    const fetched = await service.getProjectConversation("/repo", c.id);
    expect(fetched?.name).toBe("Renamed");
  });

  it("getOpenProjectConversationCount counts open && !archived", async () => {
    const a = await service.createProjectConversation("/repo");
    const b = await service.createProjectConversation("/repo");
    await service.createProjectConversation("/repo"); // stays open
    await service.setProjectConversationOpen("/repo", a.id, false); // closed
    await service.setProjectConversationArchived("/repo", b.id, true); // archived
    expect(await service.getOpenProjectConversationCount("/repo")).toBe(1);
  });
});

describe("archiving a project conversation that keeps background work (design C5b §5)", () => {
  it("archives inside a closing of the conversation, and closes nothing to unarchive", async () => {
    const log: string[] = [];
    const deps = makeDeps({
      async closeBackgroundWork(scope, commit, options) {
        log.push(
          `close ${JSON.stringify(scope)} ${options.end} stop=${options.stop}`,
        );
        const value = await commit();
        log.push("closed");
        return value;
      },
    });
    const service = createProjectConversationService(deps);
    const c = await service.createProjectConversation("/repo");

    await service.setProjectConversationArchived("/repo", c.id, true);
    expect(log).toEqual([
      `close ${JSON.stringify({ projectPath: "/repo", conversationId: c.id })} archived stop=true`,
      "closed",
    ]);
    expect(
      (await service.getProjectConversation("/repo", c.id))?.archived,
    ).toBe(true);

    await service.setProjectConversationArchived("/repo", c.id, false);
    expect(log).toHaveLength(2);
  });

  it("refuses the archive, leaving it unarchived, when its background work cannot be confirmed stopped", async () => {
    const deps = makeDeps({
      async closeBackgroundWork(scope) {
        throw new BackgroundWorkUnstoppedError(
          scope.conversationId ?? "",
          "the CLI did not exit",
        );
      },
    });
    const service = createProjectConversationService(deps);
    const c = await service.createProjectConversation("/repo");

    await expect(
      service.setProjectConversationArchived("/repo", c.id, true),
    ).rejects.toBeInstanceOf(BackgroundWorkUnstoppedError);
    expect(
      (await service.getProjectConversation("/repo", c.id))?.archived,
    ).toBe(false);
  });
});

describe("marking a project conversation read", () => {
  const PROJECT_PATH = "/repo-mark-read";
  let fixture: PersistenceFixture;

  beforeEach(() => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
  });

  afterEach(() => {
    fixture.close();
  });

  function storeBackedService() {
    const { store } = fixture;
    return createProjectConversationService(
      makeDeps({
        createProjectConversationRecord: store.createProjectConversation,
        getProjectConversation: store.getProjectConversation,
        getProjectConversations: store.getProjectConversations,
        mutateProjectConversation: store.mutateProjectConversation,
        setProjectConversationArchived: store.setProjectConversationArchived,
        setProjectConversationOpen: store.setProjectConversationOpen,
        markProjectConversationRead: store.markProjectConversationRead,
      }),
    );
  }

  it("clears unread without changing the conversation's last activity", async () => {
    await fixture.seedProjectConversation(
      PROJECT_PATH,
      makeConversationState({
        id: "older",
        scope: "project",
        unread: true,
        lastActivityAt: "2026-01-01T00:01:00.000Z",
      }),
    );
    const before = await fixture.store.getProjectConversation(
      PROJECT_PATH,
      "older",
    );

    await storeBackedService().markProjectConversationRead(
      PROJECT_PATH,
      "older",
    );

    const reloaded = await fixture.store.getProjectConversation(
      PROJECT_PATH,
      "older",
    );
    expect(reloaded?.unread).toBe(false);
    expect(reloaded?.lastActivityAt).toBe(before?.lastActivityAt);
  });
});
