#!/usr/bin/env node
// A supervised CC-like parent. The outer probe observes it and every known child.
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const ignoreTerm = process.env.POC_APP_IGNORE_TERM === "1";
const child = spawn(
  ignoreTerm ? "/bin/sh" : process.argv[2],
  ignoreTerm
    ? [
        "-c",
        'trap "" TERM; exec "$@"',
        "probe",
        process.argv[2],
        "app-server",
        "--listen",
        "stdio://",
      ]
    : ["app-server", "--listen", "stdio://"],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  },
);
process.send?.({ appServerPid: child.pid });
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
let active;
let exited = false;
let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const message = JSON.parse(line);
    if (message.method === "turn/started") {
      active = {
        threadId: message.params.threadId,
        turnId: message.params.turn.id,
      };
    }
    if (message.method === "turn/completed") active = undefined;
  }
});
child.once("exit", (code, signal) => {
  exited = true;
  process.send?.({ appServerExit: { code, signal } });
});
child.once("close", () => process.exit(0));
const waitUntil = async (predicate, milliseconds) => {
  const deadline = Date.now() + milliseconds;
  while (!predicate() && Date.now() < deadline) await delay(25);
  return predicate();
};
let stopping = false;
process.on("SIGTERM", async () => {
  if (stopping) return;
  stopping = true;
  process.stdin.unpipe(child.stdin);
  if (active) {
    process.send?.({ stage: "interrupt", at: Date.now() });
    child.stdin.write(
      JSON.stringify({
        id: "parent-shutdown",
        method: "turn/interrupt",
        params: active,
      }) + "\n",
    );
    await waitUntil(() => !active || exited, 5000);
  }
  if (exited) return;
  process.send?.({ stage: "eof", at: Date.now() });
  child.stdin.end();
  if (await waitUntil(() => exited, 5000)) return;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    process.send?.({ stage: signal, at: Date.now() });
    child.kill(signal);
    if (await waitUntil(() => exited, 2000)) return;
  }
  process.send?.({ stage: "cleanup-unconfirmed", at: Date.now() });
  process.exit(2);
});
