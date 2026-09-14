import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { applyCursorTaskEvent } from "./background-tasks";
import { createCursorTaskStore } from "./background-task-store";
const root = path.resolve(".cc/temp", `cursor-task-store-${process.pid}`);
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it("recovers task ownership through fresh file-store instances and records settlement", async () => {
  await mkdir(root, { recursive: true });
  const state = applyCursorTaskEvent(
    [],
    {
      type: "tool_call",
      name: "task",
      call_id: "durable-call",
      status: "running",
    },
    "durable-run",
    "2026-09-14T00:00:00.000Z",
  );
  await createCursorTaskStore(root).save(state);
  expect(await createCursorTaskStore(root).load()).toEqual(state);
  await createCursorTaskStore(root).save(
    state.map((task) => ({ ...task, status: "lost" })),
  );
  expect((await createCursorTaskStore(root).load())[0]?.status).toBe("lost");
});
