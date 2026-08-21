import path from "node:path";
import { getErrorMessage } from "@/lib/shared/errors";
import { z } from "zod";
import { dispatchGroup } from "../dispatch";
import { withForensics } from "../job-wait";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  checkFlags,
  cliRequest,
  connectionFailure,
  encodePathSegment,
  failure,
  failureFromRequest,
  render,
  resolveSessionContext,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliResult,
  type FetchInit,
  type GlobalFlags,
} from "../shared";
import { resolveRunningDevInstance } from "./dev-target";

/**
 * `cctl fixture session create|delete / prompt / status` — test-state
 * scaffolding for live feature verification. Every verb targets the
 * invoking session or workflow context's WORKTREE DEV SERVER (resolved through
 * the managing server's dev-servers route), never the managing CC instance
 * itself: fixtures create and delete real sessions, and doing that against the
 * production DB is destructive. An explicit `--target` equal to the managing
 * server is refused for the same reason.
 *
 * Local dev servers do not enforce API auth, so requests to the target
 * carry no token; a 401 surfaces through the shared request mapping.
 *
 * fixture is the one command family that spans TWO CC instances — a small read
 * against the managing server to learn which dev server is this context's, then
 * the fixture work against that dev server — so it is the one family the build
 * parity gate cannot be applied to: the dev server runs the branch and the
 * binary comes from the installed build, so a stamp that satisfies one hop is
 * refused by the other and no invocation exists. Every request here is
 * therefore `unstamped` (see `CliRequestParams.unstamped`), which is also what
 * the browser and this command's own pre-warm fetches already do. What replaces
 * the gate is that each response is schema-parsed and a parse failure is
 * reported as one — never degraded into a plausible-looking empty result.
 */

const createdSessionSchema = z.object({
  sessionName: z.string(),
  conversations: z.array(z.object({ id: z.string() })).default([]),
});

const conversationListSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string().optional(),
    status: z.string().optional(),
    archived: z.boolean().optional(),
  }),
);

const projectListSchema = z.array(z.object({ name: z.string() }));

interface FixtureTarget {
  url: string;
  /** The dev server's worktree, when known — locates its .config state dir. */
  worktreePath: string | null;
}

function normalizeUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function configPaths(
  target: FixtureTarget,
  conversationId: string | null,
): { dbPath?: string; transcriptPath?: string } {
  if (target.worktreePath === null) return {};
  const configDir = path.join(target.worktreePath, ".config");
  return {
    dbPath: path.join(configDir, "command-center.db"),
    ...(conversationId !== null
      ? {
          transcriptPath: path.join(
            configDir,
            "transcripts",
            `${conversationId}.jsonl`,
          ),
        }
      : {}),
  };
}

/**
 * The artifacts a failed turn is diagnosed from. The success path names them as
 * envelope fields; a failure carries the same pointers rather than leaving the
 * caller to reconstruct paths from a worktree it never sees.
 */
function fixturePathPointers(paths: {
  dbPath?: string;
  transcriptPath?: string;
}): string[] {
  return [
    ...(paths.transcriptPath ? [`transcript: ${paths.transcriptPath}`] : []),
    ...(paths.dbPath ? [`db: ${paths.dbPath}`] : []),
  ];
}

/**
 * Resolve the dev-server base URL to run fixtures against: an explicit
 * `--target` (refused when it is the managing server), else the single
 * running dev server from the managing server's registry (`--dev` picks one
 * when several run).
 */
async function resolveFixtureTarget(
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<
  { ok: true; target: FixtureTarget } | { ok: false; result: CliResult }
> {
  const json = flags.json;
  const managing = flags.server ?? env["CC_SERVER_URL"];

  const explicit = values["target"];
  if (explicit !== undefined) {
    if (managing && normalizeUrl(explicit) === normalizeUrl(managing)) {
      return {
        ok: false,
        result: usageFailure(
          `refusing to run fixtures against the managing CC server (${managing}) — fixtures mutate real sessions; target a worktree dev server (see 'cctl dev ensure')`,
          json,
        ),
      };
    }
    return {
      ok: true,
      target: { url: normalizeUrl(explicit), worktreePath: null },
    };
  }

  const session = await resolveSessionContext(flags, env, host);
  if (!session.ok) return session;

  const resolved = await resolveRunningDevInstance({
    flags,
    selector: {
      name: values["dev"],
      disambiguate: "pass --dev <name> to select one",
      bypass: "or name the dev server directly with --target <devUrl>",
    },
    context: session.context,
    env,
    host,
  });
  if (!resolved.ok) return resolved;

  return {
    ok: true,
    target: {
      url: resolved.instance.url,
      worktreePath: resolved.instance.worktreePath,
    },
  };
}

/** Request against the target dev server. Local dev servers skip auth. */
async function targetRequest(
  host: CliHost,
  target: FixtureTarget,
  method: string,
  pathAndQuery: string,
  body?: unknown,
) {
  return cliRequest(host, {
    server: target.url,
    token: null,
    tokenSource: null,
    method,
    path: pathAndQuery,
    unstamped: true,
    ...(body !== undefined ? { body } : {}),
  });
}

/** On an unknown target project, name the projects the dev server does have. */
async function withAvailableProjects(
  host: CliHost,
  target: FixtureTarget,
  project: string,
  json: boolean,
): Promise<CliResult> {
  const listed = await targetRequest(host, target, "GET", "/api/projects");
  const names =
    listed.kind === "ok"
      ? (projectListSchema.safeParse(listed.body).data ?? [])
          .map((p) => p.name)
          .join(", ")
      : "";
  return usageFailure(
    `project "${project}" not found on ${target.url}${names ? ` — available: ${names}` : ""}`,
    json,
  );
}

function sessionsPath(project: string): string {
  return `/api/projects/${encodePathSegment(project)}/sessions`;
}

function conversationsPath(project: string, session: string): string {
  return `${sessionsPath(project)}/${encodePathSegment(session)}/conversations`;
}

export async function runFixture(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  return dispatchGroup({
    group: ["fixture"],
    rest,
    json: flags.json,
    handlers: {
      session: (r) =>
        dispatchGroup({
          group: ["fixture", "session"],
          rest: r,
          json: flags.json,
          noun: "verb",
          handlers: {
            create: (rr) => runSessionCreate(rr, flags, values, env, host),
            delete: (rr) => runSessionDelete(rr, flags, values, env, host),
          },
        }),
      prompt: (r) => runPrompt(r, flags, values, env, host),
      status: (r) => runStatus(r, flags, values, env, host),
    },
  });
}

async function runSessionCreate(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "fixture session create", json);
  if (denied) return denied;
  const project = rest[0];
  if (project === undefined || rest.length > 1) {
    return usageFailure(
      "fixture session create takes a single <project> argument",
      json,
    );
  }

  const resolved = await resolveFixtureTarget(flags, values, env, host);
  if (!resolved.ok) return resolved.result;
  const target = resolved.target;

  const sessionName = values["name"] ?? `fx-${Date.now().toString(36)}`;
  const created = await targetRequest(
    host,
    target,
    "POST",
    sessionsPath(project),
    {
      mode: "normal",
      sessionName,
    },
  );
  if (created.kind !== "ok") {
    if (created.kind === "error" && created.status === 404) {
      return withAvailableProjects(host, target, project, json);
    }
    return failureFromRequest(created, json);
  }

  const parsed = createdSessionSchema.safeParse(created.body);
  if (!parsed.success) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: `unexpected create-session response from ${target.url}`,
      json,
    });
  }
  const name = parsed.data.sessionName;
  const conversationId = parsed.data.conversations[0]?.id ?? null;
  const urls = {
    session: `${target.url}/projects/${encodePathSegment(project)}/${encodePathSegment(name)}`,
    ...(conversationId !== null
      ? { conversation: `${target.url}/conversations?c=${conversationId}` }
      : {}),
  };

  // Dev mode compiles each route on first hit (~5-6s page, ~1-2s API), so
  // pre-warm the destinations the agent will drive next; the browser then
  // lands on warm routes. Best-effort — failures never fail the create.
  if (values["skip-warm"] === undefined) {
    const init: FetchInit = { method: "GET", headers: {} };
    const warmUrls = [
      urls.session,
      ...(urls.conversation ? [urls.conversation] : []),
      `${target.url}${conversationsPath(project, name)}`,
    ];
    await Promise.allSettled(warmUrls.map((u) => host.fetch(u, init)));
  }

  const paths = configPaths(target, conversationId);
  const human = [
    `created ${project}/${name}${conversationId ? ` (conversation ${conversationId})` : ""}`,
    `  session:      ${urls.session}`,
    ...(urls.conversation ? [`  conversation: ${urls.conversation}`] : []),
    ...(paths.transcriptPath
      ? [`  transcript:   ${paths.transcriptPath}`]
      : []),
  ].join("\n");
  const hint = `run a turn with 'cctl fixture prompt ${project} ${name} --text \"...\" --wait'; delete with 'cctl fixture session delete ${project} ${name}'`;
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${human}\n`, {
      ok: true,
      sessionName: name,
      conversationId,
      target: target.url,
      worktreePath: target.worktreePath,
      urls,
      ...paths,
      hint,
    }),
    stderr: "",
  };
}

async function runSessionDelete(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "fixture session delete", json);
  if (denied) return denied;
  const [project, sessionName] = rest;
  if (project === undefined || sessionName === undefined || rest.length > 2) {
    return usageFailure(
      "fixture session delete takes <project> <sessionName> arguments",
      json,
    );
  }

  const resolved = await resolveFixtureTarget(flags, values, env, host);
  if (!resolved.ok) return resolved.result;
  const target = resolved.target;

  const result = await targetRequest(
    host,
    target,
    "DELETE",
    `${sessionsPath(project)}?sessionName=${encodeURIComponent(sessionName)}`,
  );
  if (result.kind !== "ok") return failureFromRequest(result, json);

  const worktreeRemoved =
    typeof result.body === "object" &&
    result.body !== null &&
    "worktreeRemoved" in result.body &&
    result.body.worktreeRemoved === true;
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `deleted ${project}/${sessionName}\n`, {
      ok: true,
      worktreeRemoved,
    }),
    stderr: "",
  };
}

type SseOutcome =
  | { kind: "done" }
  | { kind: "error"; message: string }
  | { kind: "ended" };

/** Read an SSE body until the server emits `done` or `error`. */
async function readSseUntilDone(response: Response): Promise<SseOutcome> {
  const body = response.body;
  if (body === null) return { kind: "ended" };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent: string | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (value !== undefined) buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("event:")) {
        currentEvent = trimmed.slice("event:".length).trim();
        if (currentEvent === "done") return { kind: "done" };
        continue;
      }
      if (trimmed.startsWith("data:") && currentEvent === "error") {
        return { kind: "error", message: trimmed.slice("data:".length).trim() };
      }
    }
    if (done) {
      return currentEvent === "error"
        ? { kind: "error", message: "turn failed" }
        : { kind: "ended" };
    }
  }
}

async function runPrompt(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "fixture prompt", json);
  if (denied) return denied;
  const [project, sessionName] = rest;
  if (project === undefined || sessionName === undefined || rest.length > 2) {
    return usageFailure(
      "fixture prompt takes <project> <sessionName> arguments",
      json,
    );
  }
  const text = values["text"];
  if (text === undefined) {
    return usageFailure('fixture prompt requires --text "<prompt>"', json);
  }
  const timeoutRaw = values["timeout"];
  const timeoutMs = timeoutRaw === undefined ? null : Number(timeoutRaw) * 1000;
  if (timeoutMs !== null && !Number.isFinite(timeoutMs)) {
    return usageFailure(`invalid --timeout "${timeoutRaw}" (seconds)`, json);
  }

  const resolved = await resolveFixtureTarget(flags, values, env, host);
  if (!resolved.ok) return resolved.result;
  const target = resolved.target;

  // Only an explicit --conversation counts: the env's CC_CONVERSATION_ID is
  // this agent's own conversation on the MANAGING server, never the target's.
  let conversationId = values["conversation"];
  if (conversationId === undefined) {
    const listed = await targetRequest(
      host,
      target,
      "GET",
      conversationsPath(project, sessionName),
    );
    if (listed.kind !== "ok") {
      if (listed.kind === "error" && listed.status === 404) {
        return withAvailableProjects(host, target, project, json);
      }
      return failureFromRequest(listed, json);
    }
    const conversations = (
      conversationListSchema.safeParse(listed.body).data ?? []
    ).filter((c) => c.archived !== true);
    const first = conversations[0];
    if (first === undefined) {
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: `no conversations in ${project}/${sessionName}`,
        json,
      });
    }
    if (conversations.length > 1) {
      return usageFailure(
        `multiple conversations in ${project}/${sessionName} (${conversations.map((c) => c.id).join(", ")}); pass --conversation <id>`,
        json,
      );
    }
    conversationId = first.id;
  }

  const promptUrl = `${target.url}${conversationsPath(project, sessionName)}/${encodePathSegment(conversationId)}/prompt`;
  let response: Response;
  try {
    response = await host.fetch(promptUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: text }),
    });
  } catch (error) {
    return connectionFailure({
      message: `cannot reach the dev server at ${target.url}`,
      detail: getErrorMessage(error),
      hint: "start it with `cctl dev ensure`, then re-run this prompt",
      json,
    });
  }
  if (!response.ok) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: `prompt failed (HTTP ${response.status})`,
      json,
    });
  }

  const paths = configPaths(target, conversationId);
  if (values["wait"] === undefined) {
    void response.body?.cancel().catch(() => {});
    return {
      exitCode: EXIT_OK,
      stdout: render(json, `turn started in ${conversationId}\n`, {
        ok: true,
        conversationId,
        turn: "started",
        ...paths,
        hint: `poll with 'cctl fixture status ${project} ${sessionName}'`,
      }),
      stderr: "",
    };
  }

  const read = readSseUntilDone(response);
  const outcome =
    timeoutMs === null
      ? await read
      : await Promise.race([
          read,
          host.sleep(timeoutMs).then(() => ({ kind: "timeout" as const })),
        ]);

  if (outcome.kind === "timeout") {
    void response.body?.cancel().catch(() => {});
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: `turn timed out after ${timeoutRaw}s (it may still be running server-side)`,
      hint: `check with 'cctl fixture status ${project} ${sessionName}'`,
      json,
    });
  }
  if (outcome.kind === "error") {
    return failure(
      withForensics(
        {
          exitCode: EXIT_OPERATION_FAILED,
          message: `turn failed: ${outcome.message}`,
          json,
        },
        fixturePathPointers(paths),
      ),
    );
  }
  if (outcome.kind === "ended") {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message:
        "stream ended without a done event — the turn's outcome is unknown",
      hint: `check with 'cctl fixture status ${project} ${sessionName}'`,
      json,
    });
  }

  return {
    exitCode: EXIT_OK,
    stdout: render(json, `turn completed in ${conversationId}\n`, {
      ok: true,
      conversationId,
      turn: "completed",
      ...paths,
      hint: paths.transcriptPath
        ? `verify against the transcript: ${paths.transcriptPath}`
        : undefined,
    }),
    stderr: "",
  };
}

async function runStatus(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "fixture status", json);
  if (denied) return denied;
  const [project, sessionName] = rest;
  if (project === undefined || sessionName === undefined || rest.length > 2) {
    return usageFailure(
      "fixture status takes <project> <sessionName> arguments",
      json,
    );
  }

  const resolved = await resolveFixtureTarget(flags, values, env, host);
  if (!resolved.ok) return resolved.result;

  const listed = await targetRequest(
    host,
    resolved.target,
    "GET",
    conversationsPath(project, sessionName),
  );
  if (listed.kind !== "ok") return failureFromRequest(listed, json);

  const conversations = (
    conversationListSchema.safeParse(listed.body).data ?? []
  ).map((c) => ({
    id: c.id,
    name: c.name ?? "",
    status: c.status ?? "unknown",
  }));
  const human =
    conversations.length === 0
      ? "no conversations\n"
      : `${conversations.map((c) => `${c.id}  ${c.status}  ${c.name}`).join("\n")}\n`;
  return {
    exitCode: EXIT_OK,
    stdout: render(json, human, { ok: true, conversations }),
    stderr: "",
  };
}
