import { afterEach, describe, expect, it } from "vitest";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { createStateStore } from "./store";
import { _createTestDb } from "./state-db";
import { createSessionsRepo } from "./sessions-repo";

describe("session Markdown document state-store methods", () => {
  const db = _createTestDb({ inMemory: true });

  afterEach(() => {
    db.close();
  });

  it("writes through the queue and reads exact session membership", async () => {
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run("/project");
    createSessionsRepo(db).upsert(
      "/project",
      sessionStateSchema.parse({
        sessionName: "session",
        worktreePath: "/worktree",
        branchName: "csm/session",
        createdAt: "2026-07-11T09:00:00.000Z",
        lastActivityAt: "2026-07-11T09:00:00.000Z",
      }),
    );
    const store = createStateStore({ db });
    const document = {
      docPath: "/shared/runbook.md",
      origin: "read" as const,
      firstSeenAt: "2026-07-11T10:00:00.000Z",
      lastSeenAt: "2026-07-11T10:00:00.000Z",
    };

    await store.upsertSessionMarkdownDocuments("/project", "session", [
      document,
    ]);

    expect(
      await store.getSessionMarkdownDocuments("/project", "session"),
    ).toEqual([document]);
    expect(
      await store.isSessionMarkdownDocumentIndexed(
        "/project",
        "session",
        "/shared/runbook.md",
      ),
    ).toBe(true);
  });
});
