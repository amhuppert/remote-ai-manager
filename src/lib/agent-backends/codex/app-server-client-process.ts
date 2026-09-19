import { execFile, spawn } from "node:child_process";
import { constants, accessSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";
import { promisify } from "node:util";
import {
  errnoCode,
  readProcessGroupIdSync,
  readProcessStartTicks,
} from "@/lib/shared/process-identity";
import type { AppServerProcessHost } from "./app-server-client";
import { buildCodexConfigArgs } from "./app-server-config-args";
import { CODEX_APP_SERVER_VERSION } from "./app-server-protocol";

const packageSchema = z.object({ version: z.string() });

/** Resolve through the owned runtime package, never a user-global PATH command. */
export function resolveCodexAppServerExecutable(): string {
  const platform = process.platform;
  const arch = process.arch;
  if (
    (platform !== "linux" && platform !== "darwin") ||
    (arch !== "x64" && arch !== "arm64")
  ) {
    throw new Error(`Unsupported Codex app-server host: ${platform}/${arch}`);
  }
  // Turbopack rewrites static require.resolve calls to bundle identifiers.
  // CC launches from its installed server root; the native package lives there.
  const runtimeManifest = path.join(
    process.cwd(),
    "node_modules",
    "@openai",
    "codex",
    "package.json",
  );
  const runtimeVersion = packageSchema.safeParse(
    JSON.parse(readFileSync(runtimeManifest, "utf8")),
  );
  if (
    !runtimeVersion.success ||
    runtimeVersion.data.version !== CODEX_APP_SERVER_VERSION
  ) {
    throw new Error(
      `Codex app-server requires runtime ${CODEX_APP_SERVER_VERSION}`,
    );
  }
  const runtimeRequire = createRequire(runtimeManifest);
  const packageName = `@openai/codex-${platform}-${arch}`;
  const platformManifest = runtimeRequire.resolve(
    `${packageName}/package.json`,
  );
  const platformVersion = packageSchema.safeParse(
    JSON.parse(readFileSync(platformManifest, "utf8")),
  );
  if (
    !platformVersion.success ||
    platformVersion.data.version !==
      `${CODEX_APP_SERVER_VERSION}-${platform}-${arch}`
  ) {
    throw new Error(
      `Codex app-server platform package must match ${CODEX_APP_SERVER_VERSION}`,
    );
  }
  const cpu = arch === "x64" ? "x86_64" : "aarch64";
  const target = `${cpu}-${platform === "darwin" ? "apple-darwin" : "unknown-linux-musl"}`;
  const executable = path.join(
    path.dirname(platformManifest),
    "vendor",
    target,
    "bin",
    "codex",
  );
  accessSync(executable, constants.X_OK);
  return executable;
}

const execFileAsync = promisify(execFile);

/** A bounded snapshot of owned descendants, including terminal groups outside the leader group. */
async function processTable(): Promise<Map<
  number,
  { parent: number; start: string }
> | null> {
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-axo", "pid=,ppid=,lstart="],
      { encoding: "utf8", timeout: 250, maxBuffer: 1024 * 1024 },
    );
    const rows = new Map<number, { parent: number; start: string }>();
    for (const line of stdout.trim().split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match?.[1] || !match[2] || !match[3]) return null;
      rows.set(Number(match[1]), { parent: Number(match[2]), start: match[3] });
    }
    return rows;
  } catch {
    return null;
  }
}

export function createAppServerProcessHost(): AppServerProcessHost {
  return {
    spawn({ cwd, env, config }) {
      const child = spawn(
        resolveCodexAppServerExecutable(),
        ["app-server", "--listen", "stdio://", ...buildCodexConfigArgs(config)],
        {
          cwd,
          // Next globally requires NODE_ENV; Node's spawn permits its absence
          // and arbitrary string values. Preserve the exact supplied map.
          env: env as NodeJS.ProcessEnv,
          // Own a process group while retaining all pipes and awaiting exit. Never unref.
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const pid = child.pid;
      if (pid === undefined) {
        // Spawn failure emits an asynchronous error even after synchronous setup fails.
        child.on("error", () => {});
        throw new Error("Codex app-server was not assigned a process ID");
      }
      return {
        pid,
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        onExit(listener) {
          child.on("exit", listener);
          return () => {
            child.off("exit", listener);
          };
        },
        onError(listener) {
          child.on("error", listener);
          return () => {
            child.off("error", listener);
          };
        },
      };
    },
    async observeChildren(pid) {
      const before = await processTable();
      if (!before?.has(pid)) return null;
      const owned = new Map<number, string>();
      const parents = new Set([pid]);
      let added = true;
      while (added) {
        added = false;
        for (const [childPid, row] of before) {
          if (
            childPid !== pid &&
            parents.has(row.parent) &&
            !parents.has(childPid)
          ) {
            owned.set(childPid, row.start);
            parents.add(childPid);
            added = true;
          }
        }
      }
      return async () => {
        const after = await processTable();
        if (!after) return false;
        return [...owned].every(
          ([childPid, start]) => after.get(childPid)?.start !== start,
        );
      };
    },
    processGroupId: readProcessGroupIdSync,
    startTicks: readProcessStartTicks,
    isGroupAlive(pgid) {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch (error) {
        return errnoCode(error) !== "ESRCH";
      }
    },
    signalGroup(pgid, signal) {
      try {
        process.kill(-pgid, signal);
      } catch (error) {
        if (errnoCode(error) !== "ESRCH") throw error;
      }
    },
  };
}
