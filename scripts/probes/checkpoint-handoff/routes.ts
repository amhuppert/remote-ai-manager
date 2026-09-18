import { readProbeResponse } from "./route-response";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  conversationTargetApiBase,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";

const doctorDataSchema = z.object({
  sameInstance: z.literal(false),
  managing: z.object({ server: z.string().url(), configDir: z.string() }),
  dev: z.object({
    server: z.string().url(),
    configDir: z.string(),
    worktreePath: z.string(),
  }),
});
const doctorSchema = z.object({
  ok: z.literal(true),
  effect: z.literal("read"),
  payload: z.object({ kind: z.literal("inline"), data: doctorDataSchema }),
});

export function verifyDevProbeTarget(
  doctor: unknown,
  worktree: string,
): { server: string; configDir: string } {
  const parsed = doctorSchema.safeParse(doctor);
  if (!parsed.success)
    throw new Error(
      "route probe refused: dev doctor did not identify an isolated instance",
    );
  const { dev, managing } = parsed.data.payload.data;
  const root = path.resolve(worktree);
  const configDir = path.resolve(dev.configDir);
  if (
    path.resolve(dev.worktreePath) !== root ||
    !configDir.startsWith(root + path.sep) ||
    configDir === path.resolve(managing.configDir) ||
    new URL(dev.server).origin === new URL(managing.server).origin
  ) {
    throw new Error(
      "route probe refused: target is outside this worktree or is the managing instance",
    );
  }
  return { server: dev.server, configDir };
}

/** A failed start cannot authorize adoption; the authenticated doctor must. */
export function resolveVerifiedDevProbeTarget(
  worktree: string,
  run: (args: readonly string[]) => string,
) {
  let startFailureCode: string | undefined;
  try {
    run(["dev", "ensure", "nextjs", "--json"]);
  } catch {
    startFailureCode = "cctl_dev_ensure_failed";
  }
  const doctor: unknown = JSON.parse(
    run(["dev", "doctor", "nextjs", "--json"]),
  );
  return {
    ...verifyDevProbeTarget(doctor, worktree),
    ...(startFailureCode ? { startFailureCode } : {}),
  };
}

/** Resolve through CC, then read only this worktree's instance token. */
export function resolveDevProbeClient(worktree = process.cwd()) {
  const target = resolveVerifiedDevProbeTarget(realpathSync(worktree), (args) =>
    execFileSync("cctl", [...args], {
      cwd: worktree,
      encoding: "utf8",
      stdio: "pipe",
    }),
  );
  if (realpathSync(target.configDir) !== target.configDir)
    throw new Error("route probe refused: config directory is a symlink");
  const token = readFileSync(
    path.join(target.configDir, "api-token"),
    "utf8",
  ).trim();
  if (!token)
    throw new Error("route probe refused: instance token unavailable");
  return {
    ...target,
    async stream(
      route: string,
      body: unknown,
    ): Promise<{ status: number; text: string }> {
      if (!route.startsWith("/api/"))
        throw new Error("route probe refused: expected local API path");
      const response = await fetch(new URL(route, target.server), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(300_000),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    },
    async request(
      route: string,
      init: RequestInit = {},
    ): Promise<{ status: number; body: unknown }> {
      if (!route.startsWith("/api/") || route.startsWith("//"))
        throw new Error("route probe refused: expected local API path");
      const response = await fetch(new URL(route, target.server), {
        ...init,
        redirect: "error",
        signal: init.signal ?? AbortSignal.timeout(120_000),
        headers: {
          ...init.headers,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      });
      return readProbeResponse(response);
    },
  };
}

/** All controls go through authenticated production HTTP handlers. */
export function checkpointProbeRoutes(
  client: ReturnType<typeof resolveDevProbeClient>,
  target: ConversationTarget,
) {
  const base = `${conversationTargetApiBase(target)}/checkpoints`;
  const operation = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    check: () => client.request(`${base}/eligibility`),
    list: () => client.request(base),
    get: (id: string) => client.request(`${operation(id)}?detail=seed`),
    // Budget accounting belongs to the caller, before this submission.
    start: (body: unknown) =>
      client.request(base, { method: "POST", body: JSON.stringify(body) }),
    skip: (id: string) =>
      client.request(`${operation(id)}/skip-handoff`, {
        method: "POST",
        body: "{}",
      }),
    cancel: (id: string) =>
      client.request(`${operation(id)}/cancel`, { method: "POST", body: "{}" }),
    reconcile: (id: string) =>
      client.request(`${operation(id)}/reconcile`, {
        method: "POST",
        body: "{}",
      }),
    acknowledgeStoppedExecution: (id: string) =>
      client.request(`${operation(id)}/reconcile`, {
        method: "POST",
        body: JSON.stringify({ captureExecutionStopped: true, source: "api" }),
      }),
  };
}
