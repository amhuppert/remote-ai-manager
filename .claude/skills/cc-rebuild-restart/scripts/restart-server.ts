/**
 * Command Center detached restart daemon.
 *
 * Run ONLY as a fully-detached process (own session, reparented to launchd). It is
 * launched by `rebuild-and-restart.sh` via a `bun -e` spawn with `detached: true` +
 * `.unref()`, which is the macOS-safe equivalent of `setsid` (macOS ships no `setsid`).
 *
 * Why detachment is mandatory: the Claude session that triggers this skill runs as a
 * CHILD of the very CC server being restarted (server -> claude SDK -> bash -> launcher).
 * If the restarter stayed in that process tree, killing the server would kill the
 * restarter too and the server would never come back. As a detached session leader the
 * daemon's only ancestor is launchd, so it survives the kill it performs.
 *
 * Config is passed via environment (set by the launcher):
 *   CC_MAIN_ROOT          absolute path to the MAIN worktree (server cwd)
 *   CC_PORT               port the server listens on (detected, default 3000)
 *   CC_BUN_BIN            absolute path to the bun binary
 *   CC_RESTART_DELAY_MS   grace period before the kill (lets the triggering turn/SSE flush)
 *   CC_SERVER_LOG         file the restarted server's stdout/stderr is appended to
 *   CC_RESTART_DRY_RUN    when "1", print the plan and exit without killing/restarting
 */

import { execFileSync, spawn } from "node:child_process";
import { openSync } from "node:fs";

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`restart-server: missing required env var ${key}`);
  }
  return value;
}

const mainRoot = requireEnv("CC_MAIN_ROOT");
const bunBin = requireEnv("CC_BUN_BIN");
const port = Number(process.env.CC_PORT ?? "3000");
const delayMs = Number(process.env.CC_RESTART_DELAY_MS ?? "5000");
const serverLog = process.env.CC_SERVER_LOG ?? "/tmp/command-center-server.log";
const dryRun = process.env.CC_RESTART_DRY_RUN === "1";

// Session/dev-injected vars that must NOT leak into the restarted production server.
// CC_CONFIG_DIR is the dangerous one: a worktree session sets it to its own .config,
// which would point the main server at the wrong SQLite database.
const STRIP_ENV = [
  "CC_CONFIG_DIR",
  "CC_ENV",
  "PORT",
  "CC_PORT",
  "CC_BUN_BIN",
  "CC_MAIN_ROOT",
  "CC_RESTART_DELAY_MS",
  "CC_RESTART_SCRIPT",
  "CC_RESTART_LOG",
  "CC_SERVER_LOG",
  "CC_RESTART_DRY_RUN",
];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [restart] ${message}`);
}

/** PIDs holding a LISTEN socket on the given port (empty when the port is free). */
function listenersOnPort(p: number): number[] {
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${p}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    });
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    // lsof exits non-zero when nothing matches.
    return [];
  }
}

function cwdOf(pid: number): string | null {
  try {
    const out = execFileSync(
      "lsof",
      ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
      { encoding: "utf8" },
    );
    const line = out.split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

function commandOf(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function parentOf(pid: number): number | null {
  try {
    const ppid = Number(
      execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim(),
    );
    return Number.isFinite(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every `next-server` process whose cwd is the main worktree. This covers both the live
 * server and any leaked orphans from earlier restarts (we observed one with ppid 1 that
 * no longer held the port). cwd === mainRoot uniquely identifies the main CC server
 * family: worktree dev servers run with their own worktree as cwd, so they are never hit.
 */
function mainRootServerPids(): number[] {
  let psOut = "";
  try {
    psOut = execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const line of psOut.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2] ?? "";
    if (!/next-server/.test(command)) continue;
    if (cwdOf(pid) === mainRoot) pids.push(pid);
  }
  return pids;
}

/** Resolve the full set of PIDs that make up the main-worktree server. */
function collectKillTargets(): number[] {
  const targets = new Set<number>();

  for (const pid of listenersOnPort(port)) {
    if (cwdOf(pid) === mainRoot) {
      targets.add(pid);
      const parent = parentOf(pid);
      if (
        parent &&
        cwdOf(parent) === mainRoot &&
        /\bbun\b|next/.test(commandOf(parent))
      ) {
        targets.add(parent);
      }
    } else {
      log(
        `port ${port} is held by pid ${pid} whose cwd is not ${mainRoot}; refusing to kill it`,
      );
    }
  }

  for (const pid of mainRootServerPids()) {
    targets.add(pid);
    const parent = parentOf(pid);
    if (
      parent &&
      cwdOf(parent) === mainRoot &&
      /\bbun\b|next/.test(commandOf(parent))
    ) {
      targets.add(parent);
    }
  }

  return [...targets];
}

function buildServerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of STRIP_ENV) delete env[key];
  env.PORT = String(port);
  return env;
}

async function killTargets(targets: number[]): Promise<void> {
  if (targets.length === 0) {
    log("no running main-worktree server found; will start a fresh one");
    return;
  }

  log(`SIGTERM -> ${targets.join(", ")}`);
  for (const pid of targets) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }

  const graceDeadline = Date.now() + 8000;
  while (
    Date.now() < graceDeadline &&
    (targets.some(isAlive) || listenersOnPort(port).length > 0)
  ) {
    await sleep(250);
  }

  for (const pid of targets) {
    if (isAlive(pid)) {
      log(`SIGKILL ${pid}`);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

async function waitForPortFree(): Promise<boolean> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (listenersOnPort(port).length === 0) return true;
    await sleep(250);
  }
  return listenersOnPort(port).length === 0;
}

function startServer(): number | undefined {
  const out = openSync(serverLog, "a");
  const child = spawn(bunBin, ["run", "start"], {
    cwd: mainRoot,
    detached: true,
    stdio: ["ignore", out, out],
    env: buildServerEnv(),
  });
  child.unref();
  return child.pid;
}

async function waitForServerUp(): Promise<boolean> {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (listenersOnPort(port).length > 0) return true;
    await sleep(500);
  }
  return false;
}

async function main(): Promise<void> {
  log(`main worktree: ${mainRoot}`);
  log(`target port:   ${port}`);

  const targets = collectKillTargets();

  if (dryRun) {
    log("DRY RUN — no processes will be killed and no server will be started.");
    log(
      `would SIGTERM (then SIGKILL survivors): ${targets.length ? targets.join(", ") : "(none)"}`,
    );
    for (const pid of targets)
      log(`  pid ${pid}: ${commandOf(pid)} [cwd=${cwdOf(pid)}]`);
    log(`would start: ${bunBin} run start  (cwd=${mainRoot}, PORT=${port})`);
    log(`would strip from server env: ${STRIP_ENV.join(", ")}`);
    log(`server stdout/stderr would append to: ${serverLog}`);
    return;
  }

  if (delayMs > 0) {
    log(
      `waiting ${delayMs}ms before kill (lets the triggering turn + SSE flush)`,
    );
    await sleep(delayMs);
  }

  await killTargets(targets);

  if (!(await waitForPortFree())) {
    log(
      `ERROR: port ${port} is still occupied after kill; aborting restart to avoid two servers`,
    );
    process.exit(1);
  }

  const pid = startServer();
  log(`started new server pid ${pid ?? "(unknown)"}; output -> ${serverLog}`);

  if (await waitForServerUp()) {
    log(`SUCCESS: Command Center is listening on port ${port}`);
    process.exit(0);
  }
  log(
    `WARNING: server did not start listening on port ${port} within 60s; inspect ${serverLog}`,
  );
  process.exit(1);
}

main().catch((error: unknown) => {
  log(
    `FATAL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});
