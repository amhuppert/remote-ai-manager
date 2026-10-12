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
        sessionBackgroundWork: () => [],
        closeBackgroundWork: (_scope, commit) => commit(),
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
      sessionBackgroundWork: () => [],
      closeBackgroundWork: (_scope, commit) => commit(),
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

it("refuses to mark a session merged while a conversation's background work holds, reading it inside a closing that fences new custody until the write", async () => {
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
    const log: string[] = [];
    let held = true;
    const handler = createMergeStatusHandler({
      resolveProjectPath: async () => "/repo",
      getSession: fixture.store.getSession,
      async mutateSession(...args) {
        log.push("write");
        return fixture.store.mutateSession(...args);
      },
      currentRuns: () => [],
      sessionBackgroundWork(projectPath, sessionName) {
        log.push(`read:${projectPath}:${sessionName}`);
        return held
          ? [
              {
                conversationId: "conv-1",
                conversationName: "Suite runner",
                unconfirmed: null,
              },
            ]
          : [];
      },
      async closeBackgroundWork(scope, commit, options) {
        log.push(
          `close:${JSON.stringify(scope)}:${options.end}:${options.stop}`,
        );
        try {
          return await commit();
        } finally {
          log.push("closed");
        }
      },
    });
    const mark = (merged: boolean) =>
      handler(
        new Request("http://cc.test/merge-status", {
          method: "PATCH",
          body: JSON.stringify({ merged }),
        }),
        { params: Promise.resolve({ name: "repo", session: "s" }) },
      );
    const finished = async () =>
      (await createStateStore({ db: fixture.db }).getSession("/repo", "s"))
        ?.finished;

    const refused = await mark(true);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: "BACKGROUND_WORK_RUNNING",
      details: { conversationId: "conv-1" },
      error: expect.stringContaining("marking this session merged"),
    });
    expect(await finished()).toBe(false);
    expect(log).toEqual([
      `close:${JSON.stringify({ projectPath: "/repo", sessionName: "s" })}:merged:false`,
      "read:/repo:s",
      "closed",
    ]);

    held = false;
    log.length = 0;
    expect((await mark(true)).status).toBe(200);
    expect(await finished()).toBe(true);
    expect(log).toEqual([
      `close:${JSON.stringify({ projectPath: "/repo", sessionName: "s" })}:merged:false`,
      "read:/repo:s",
      "write",
      "closed",
    ]);

    // Unmarking opens nothing to close.
    log.length = 0;
    expect((await mark(false)).status).toBe(200);
    expect(log).toEqual(["write"]);
  } finally {
    fixture.close();
  }
});
