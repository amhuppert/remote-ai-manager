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
  it("verifies surviving group members after their original leader exits", async () => {
    const host = createAppServerProcessHost();
    const leader = spawn("sh", ["-c", "sleep 30 & read line"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    const exited = new Promise<void>((resolve) =>
      leader.once("exit", () => resolve()),
    );
    const pid = leader.pid;
    if (pid === undefined) throw new Error("sh was not started");
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const start = await host.startTicks(pid);
      if (start === null) throw new Error("leader identity was not readable");
      expect(await host.observeGroup?.(pid, "different-start")).toBeNull();
      const owned = await host.observeGroup?.(pid, start);
      leader.stdin.end();
      await exited;

      expect(host.isGroupAlive(pid)).toBe(true);
      expect(await owned?.()).toBe(true);
      expect(await host.observeGroup?.(pid, start)).toBeNull();

      host.signalGroup(pid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await owned?.()).toBe(false);
    } finally {
      host.signalGroup(pid, "SIGKILL");
      await exited;
    }
  });

  it("refuses a group containing a member created after its ownership snapshot", async () => {
    const host = createAppServerProcessHost();
    const leader = spawn(
      "sh",
      ["-c", "sleep 30 & while read line; do sleep 30 & echo spawned; done"],
      {
        detached: true,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const exited = new Promise<void>((resolve) =>
      leader.once("exit", () => resolve()),
    );
    const pid = leader.pid;
    if (pid === undefined) throw new Error("sh was not started");
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const start = await host.startTicks(pid);
      if (start === null) throw new Error("leader identity was not readable");
      const owned = await host.observeGroup?.(pid, start);
      expect(await owned?.()).toBe(true);
      const spawned = new Promise<void>((resolve) =>
        leader.stdout.once("data", () => resolve()),
      );
      leader.stdin.write("spawn\n");
      await spawned;

      expect(await owned?.()).toBe(false);
    } finally {
      host.signalGroup(pid, "SIGKILL");
      leader.stdin.destroy();
      leader.stdout.destroy();
      await exited;
    }
  });

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
