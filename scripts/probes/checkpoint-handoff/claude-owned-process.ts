import type { Options, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type ClaudeProcessKind = "ordinary" | "capture";
export interface OwnedClaudeProcessEvidence {
  queryId: string;
  kind: ClaudeProcessKind;
  pid: number | null;
  parentPid: number | null;
  sdkExitObserved: boolean;
  exitCode: number | null;
  signalCode: string | null;
  signals: { signal: NodeJS.Signals; sent: boolean; at: string }[];
}
export interface OwnedClaudeProcess {
  snapshot(): OwnedClaudeProcessEvidence;
  observeIdentity(): Promise<boolean>;
  signal(signal: NodeJS.Signals): Promise<boolean>;
  waitForExit(timeoutMs: number): Promise<boolean>;
}
type SpawnClaude = NonNullable<Options["spawnClaudeCodeProcess"]>;
export function observeOwnedClaudeSpawn(
  directory: string,
  queryId: string,
  kind: ClaudeProcessKind,
  original: SpawnClaude,
  onSpawn: (child: OwnedClaudeProcess) => void,
): SpawnClaude {
  return (options) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!/^[a-zA-Z0-9-]+$/.test(queryId))
      throw new Error("invalid process observation ID");
    const pidFile = path.join(directory, `${queryId}.pid`);
    // The production spawner still owns the child and diagnostic/collection
    // callbacks. POSIX exec preserves this shim's PID for the real SDK process.
    const child: SpawnedProcess = original({
      ...options,
      command: "/bin/sh",
      args: [
        "-c",
        'umask 077; set -C; printf "%s\\n" "$$" > "$1" || exit 91; shift; exec "$@"',
        "cc-owned-provider-probe",
        pidFile,
        options.command,
        ...options.args,
      ],
    });
    const evidence: OwnedClaudeProcessEvidence = {
      queryId,
      kind,
      pid: null,
      parentPid: null,
      sdkExitObserved: false,
      exitCode: null,
      signalCode: null,
      signals: [],
    };
    const exited = Promise.withResolvers<void>();
    child.once("exit", (code, signal) => {
      evidence.sdkExitObserved = true;
      evidence.exitCode = code;
      evidence.signalCode = signal;
      exited.resolve();
    });
    const observeIdentity = async () => {
      const until = Date.now() + 2000;
      while (
        !existsSync(pidFile) &&
        !evidence.sdkExitObserved &&
        Date.now() < until
      )
        await delay(10);
      if (evidence.sdkExitObserved) return false;
      if (!existsSync(pidFile))
        throw new Error("owned child did not publish its PID");
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)
        throw new Error("invalid owned child PID");
      const parentPid = Number(
        execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
          encoding: "utf8",
        }).trim(),
      );
      if (parentPid !== process.pid)
        throw new Error("PID was not a direct child of this probe process");
      evidence.pid = pid;
      evidence.parentPid = parentPid;
      return true;
    };
    onSpawn({
      snapshot: () => structuredClone(evidence),
      observeIdentity,
      async signal(signal) {
        if (
          evidence.sdkExitObserved ||
          child.exitCode !== null ||
          child.signalCode
        )
          return false;
        if (!(await observeIdentity())) return false;
        const sent = child.kill(signal);
        evidence.signals.push({ signal, sent, at: new Date().toISOString() });
        return sent;
      },
      async waitForExit(timeoutMs) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            exited.promise.then(() => true),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), timeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      },
    });
    return child;
  };
}
