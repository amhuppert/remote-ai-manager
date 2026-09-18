export interface ObservedProcess {
  pid: number;
  parentPid: number;
  started: string;
}
export interface RouteCleanupDeps {
  snapshot(): ObservedProcess[];
  stopServer(): void;
  wait(): Promise<void>;
}
export async function collectStoppedRouteProcesses(
  root: ObservedProcess,
  deps: RouteCleanupDeps,
) {
  const before = deps.snapshot();
  const rootMatched = before.some(
    (item) => item.pid === root.pid && item.started === root.started,
  );
  const ids = new Set([root.pid]);
  if (rootMatched) {
    for (;;) {
      const size = ids.size;
      for (const item of before) if (ids.has(item.parentPid)) ids.add(item.pid);
      if (ids.size === size) break;
    }
  }
  const observed = rootMatched
    ? before.filter((item) => ids.has(item.pid))
    : [root];
  deps.stopServer();
  let remaining: ObservedProcess[] = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    remaining = deps
      .snapshot()
      .filter((item) =>
        observed.some(
          (prior) => prior.pid === item.pid && prior.started === item.started,
        ),
      );
    if (remaining.length === 0)
      return { observed, remaining, settled: rootMatched };
    await deps.wait();
  }
  return { observed, remaining, settled: false };
}

import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export function snapshotRouteProcesses(): ObservedProcess[] {
  return execFileSync("ps", ["-axo", "pid=,ppid=,lstart="], {
    encoding: "utf8",
  })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (!match) return [];
      return [
        {
          pid: Number(match[1]),
          parentPid: Number(match[2]),
          started: match[3] ?? "",
        },
      ];
    });
}

export function observeRouteServer(server: string): ObservedProcess {
  const url = new URL(server);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const pids = execFileSync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { encoding: "utf8" },
  )
    .trim()
    .split(/\s+/u)
    .map(Number);
  const unique = [...new Set(pids)];
  if (unique.length !== 1)
    throw new Error("cannot correlate dev route listener to one process");
  const observed = snapshotRouteProcesses().find(
    (item) => item.pid === unique[0],
  );
  if (!observed)
    throw new Error(
      "dev route listener disappeared before process observation",
    );
  return observed;
}

export const productionRouteCleanup: RouteCleanupDeps = {
  snapshot: snapshotRouteProcesses,
  stopServer() {
    execFileSync("cctl", ["dev", "stop", "nextjs", "--json"], {
      stdio: "pipe",
    });
  },
  async wait() {
    await delay(250);
  },
};
