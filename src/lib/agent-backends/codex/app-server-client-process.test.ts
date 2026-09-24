import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createAppServerProcessHost } from "./app-server-client-process";

/** A leader whose background child outlives it by `survivorSeconds - 0.2`. */
async function leaderWithSurvivor(survivorSeconds: number) {
  const child = spawn("sh", ["-c", `sleep ${survivorSeconds} & sleep 0.2`], {
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  if (child.pid === undefined) throw new Error("sh was not started");
  // Let the shell fork its background child before the snapshot.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return { pid: child.pid, exited };
}

describe("app-server process host descendant collection", () => {
  it("counts a descendant that exits shortly after its leader as collected", async () => {
    const leader = await leaderWithSurvivor(0.6);
    const collect = await createAppServerProcessHost().observeChildren?.(
      leader.pid,
    );
    await leader.exited;
    expect(await collect?.(Date.now() + 3000)).toEqual([]);
  });

  it("names the descendants still running at the deadline", async () => {
    const leader = await leaderWithSurvivor(5);
    const collect = await createAppServerProcessHost().observeChildren?.(
      leader.pid,
    );
    await leader.exited;
    const survivors = await collect?.(Date.now() + 200);
    try {
      expect(survivors).toEqual([
        { pid: expect.any(Number), command: "sleep" },
      ]);
    } finally {
      for (const survivor of survivors ?? []) process.kill(survivor.pid);
    }
  });
});
