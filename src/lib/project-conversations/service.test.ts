import { describe, it, expect, beforeEach } from "vitest";
import {
  createProjectConversationService,
  type ProjectConversationServiceDeps,
} from "./service";
import type { ConversationState } from "@/lib/conversations/schemas";

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
