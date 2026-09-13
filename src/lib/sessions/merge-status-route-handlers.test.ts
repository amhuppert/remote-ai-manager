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
