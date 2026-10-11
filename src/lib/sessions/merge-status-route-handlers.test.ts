import { expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createStateStore } from "@/lib/state-store/store";
import { sessionStateSchema } from "./schemas";
import { createMergeStatusHandler } from "./merge-status-route-handlers";

it.each([false, true])(
  "marks and unmarks without changing archive state (%s) or session content",
  async (archived) => {
    const fixture = createPersistenceFixture();
    try {
      const session = sessionStateSchema.parse({
        sessionName: "s",
        worktreePath: "/repo/s",
        branchName: "csm/s",
        createdAt: "2026-09-13T00:00:00Z",
        lastActivityAt: "2026-09-13T00:00:00Z",
        archived,
        targetBranch: "release",
      });
      await fixture.store.createSessionRow("/repo", session);
      const handler = createMergeStatusHandler({
        resolveProjectPath: async () => "/repo",
        getSession: fixture.store.getSession,
        mutateSession: fixture.store.mutateSession,
        currentRuns: () => [],
      });
      for (const merged of [true, false]) {
        const response = await handler(
          new Request("http://cc.test/merge-status", {
            method: "PATCH",
            body: JSON.stringify({ merged }),
          }),
          { params: Promise.resolve({ name: "repo", session: "s" }) },
        );
        expect(response.status).toBe(200);
        expect(
          await createStateStore({ db: fixture.db }).getSession("/repo", "s"),
        ).toMatchObject({
          ...session,
          finished: merged,
        });
      }
    } finally {
      fixture.close();
    }
  },
);

it("refuses to mark a session merged while one of its runs has not finished, and unmarks it freely", async () => {
  const fixture = createPersistenceFixture();
  try {
    const session = sessionStateSchema.parse({
      sessionName: "s",
      worktreePath: "/repo/s",
      branchName: "csm/s",
      createdAt: "2026-09-13T00:00:00Z",
      lastActivityAt: "2026-09-13T00:00:00Z",
    });
    await fixture.store.createSessionRow("/repo", session);
    const handler = createMergeStatusHandler({
      resolveProjectPath: async () => "/repo",
      getSession: fixture.store.getSession,
      mutateSession: fixture.store.mutateSession,
      currentRuns: (projectPath, sessionName) =>
        projectPath === "/repo" && sessionName === "s"
          ? [{ runId: "run-1", sessionName: "s", progress: "paused" }]
          : [],
    });
    const mark = (merged: boolean) =>
      handler(
        new Request("http://cc.test/merge-status", {
          method: "PATCH",
          body: JSON.stringify({ merged }),
        }),
        { params: Promise.resolve({ name: "repo", session: "s" }) },
      );

    const refused = await mark(true);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: "RUN_CURRENT",
      details: { runId: "run-1", progress: "paused" },
    });
    expect(
      await createStateStore({ db: fixture.db }).getSession("/repo", "s"),
    ).toMatchObject({ finished: false });

    expect((await mark(false)).status).toBe(200);
  } finally {
    fixture.close();
  }
});
