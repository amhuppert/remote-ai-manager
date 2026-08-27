import { z } from "zod";
import {
  notepadListItemSchema,
  notepadSchema,
  type Notepad,
  type NotepadListItem,
  type NotepadScope,
  type NotepadWriteOperation,
} from "@/lib/notepads/schemas";
import { dispatchGroup } from "../dispatch";
import {
  boundedItems,
  emitLarge,
  omissionSummary,
  type ArtifactManifest,
} from "../disclosure";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  checkFlags,
  cliRequest,
  encodePathSegment,
  failure,
  failureFromRequest,
  render,
  resolveProjectConversationContext,
  resolveProseArg,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliResult,
  type GlobalFlags,
  type ProjectConversationContext,
} from "../shared";

/**
 * `cctl notepad` — the agent surface over notepads (notepad design D6): `list`,
 * `get`, `create`, `update`, `append`. Deliberately five verbs: renaming,
 * pinning, archiving, deleting, and changing a write mode are the user's acts in
 * the notepad panel, and an agent that could widen its own write mode would
 * defeat the control the mode exists to provide.
 *
 * Notepads are addressed by immutable id, never by name — the id is what a list
 * row, a chip's reference XML, and an injected notepad block all carry, so an
 * agent always holds one and a rename never strands it. Routes are flat and
 * id-addressed (`/api/notepads/...`) rather than project-nested; project context
 * is resolved only where a SCOPE is being named (the list filter and a scoped
 * create), which is also what supplies the caller conversation every mutation is
 * attributed to.
 *
 * Every deterministic check — subcommand, flags, id argument, `--if-revision`
 * shape, content readability — fails at exit 2 before any network round-trip.
 * Server refusals (unknown id, name taken, write mode, stale revision) arrive
 * already carrying their own message, rationale, and instruction, so they render
 * through the shared failure mapping rather than being re-worded here.
 */

/** The claimed caller conversation an agent write is attributed to. */
const CALLER_CONVERSATION_HEADER = "x-cc-conversation-id";

/** Rows the bounded default prints before it names the reveal command. */
const NOTEPAD_LIST_LIMIT = 20;

const LIST_HINT = "read one in full with 'cctl notepad get <notepadId>'";

const notepadResponseSchema = z.object({ notepad: notepadSchema });
const notepadListResponseSchema = z.object({
  notepads: z.array(notepadListItemSchema),
});

/**
 * A 2xx body that does not match the expected schema. Success output is an
 * agent-facing contract, so a response we cannot parse must fail loudly rather
 * than claim an operation completed without its authoritative result.
 */
function invalidResponseFailure(what: string, json: boolean): CliResult {
  return failure({
    exitCode: EXIT_OPERATION_FAILED,
    message: `${what} returned an unexpected response — is the CC server the same build as this CLI?`,
    code: "invalid_response",
    json,
  });
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function notepadIdArgument(
  rest: string[],
  verb: string,
  json: boolean,
): { ok: true; value: string } | { ok: false; result: CliResult } {
  const raw = rest[0];
  if (raw === undefined || raw.trim() === "") {
    return {
      ok: false,
      result: usageFailure(
        `notepad ${verb} requires a <notepadId> argument — take it from a list row, a notepad chip, or an injected notepad block`,
        json,
      ),
    };
  }
  if (rest.length > 1) {
    return {
      ok: false,
      result: usageFailure(
        `notepad ${verb} takes a single <notepadId> argument`,
        json,
      ),
    };
  }
  return { ok: true, value: raw };
}

/**
 * The compare-and-swap token for an agent write. Required, and validated here
 * rather than at the server: a missing or malformed base revision is a caller
 * mistake, and refusing it before the request keeps the "nothing changed"
 * promise without needing to ask what committed.
 */
function baseRevisionFlag(
  values: Record<string, string>,
  verb: string,
  json: boolean,
): { ok: true; value: number } | { ok: false; result: CliResult } {
  const raw = values["if-revision"];
  if (raw === undefined) {
    return {
      ok: false,
      result: usageFailure(
        `notepad ${verb} requires --if-revision <n> — the revision reported by the read this content is based on`,
        json,
      ),
    };
  }
  if (!/^[1-9]\d*$/u.test(raw)) {
    return {
      ok: false,
      result: usageFailure(
        `notepad ${verb}: --if-revision takes a positive integer, not ${JSON.stringify(raw)}`,
        json,
      ),
    };
  }
  return { ok: true, value: Number(raw) };
}

function listLimitValue(
  values: Record<string, string>,
  json: boolean,
): { ok: true; value: number } | { ok: false; result: CliResult } {
  const raw = values["limit"];
  if (raw === undefined) return { ok: true, value: NOTEPAD_LIST_LIMIT };
  const parsed = Number(raw);
  if (!/^[0-9]+$/u.test(raw) || !Number.isSafeInteger(parsed) || parsed < 1) {
    return {
      ok: false,
      result: usageFailure(
        `notepad list --limit takes a positive integer, received ${JSON.stringify(raw)}`,
        json,
      ),
    };
  }
  return { ok: true, value: parsed };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function notepadPath(notepadId?: string): string {
  return notepadId === undefined
    ? "/api/notepads"
    : `/api/notepads/${encodePathSegment(notepadId)}`;
}

/**
 * Attribution rides on mutations only. It is a claimed caller conversation, not
 * a verified principal — the house convention for a single-operator system —
 * and it is what makes an agent revision name the conversation that wrote it.
 */
function mutationHeaders(
  context: ProjectConversationContext,
): Record<string, string> {
  return { [CALLER_CONVERSATION_HEADER]: context.conversation };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** `global` or `project(<name>)` — the column that says where a notepad lives. */
function scopeLabel(scope: NotepadScope, project: string | null): string {
  return scope === "global" ? "global" : `project(${project ?? "unknown"})`;
}

function listRow(item: NotepadListItem): string {
  const marks = [item.pinned ? "pinned" : "", item.archived ? "archived" : ""]
    .filter((mark) => mark !== "")
    .join(" ");
  const scope = scopeLabel(item.scope, item.projectName ?? item.projectPath);
  return [
    item.id,
    scope,
    `rev ${item.revision}`,
    item.writeMode,
    ...(marks === "" ? [] : [marks]),
    item.name,
  ].join("  ");
}

/**
 * The facts a caller needs to write next: which notepad, at which revision, and
 * under which write mode. Printed by every verb, including the arm where the
 * content itself went to a file — an agent that got only a manifest still has to
 * learn the revision its next `--if-revision` states.
 */
function metadataLine(notepad: Notepad): string {
  return `scope: ${scopeLabel(notepad.scope, notepad.projectPath)}  revision: ${notepad.revision}  write-mode: ${notepad.writeMode}  updated: ${notepad.updatedAt}`;
}

function detailLines(notepad: Notepad): string[] {
  return [`${notepad.id}  ${notepad.name}`, metadataLine(notepad)];
}

/**
 * The notepad without its content, for the JSON arm of a read whose content went
 * to a file. `--json` changes serialization, never volume: an envelope that
 * inlined what stdout spilled would truncate exactly the pipe the spill exists
 * to protect.
 */
function notepadMetadata(notepad: Notepad): Omit<Notepad, "content"> {
  const { content: _content, ...metadata } = notepad;
  return metadata;
}

/**
 * The read that returns every row this one bounded away: the same filters,
 * widened to the full count. Anything that changes which rows the server returns
 * has to survive here, or the reveal would disclose a different set than it
 * omitted.
 *
 * The project scope is spelled out rather than left to the caller's ambient one.
 * A reveal command travels — into a transcript, a notepad, another lane's
 * prompt — and the same string run under a different `CC_PROJECT` would silently
 * list that project's notepads instead of the ones it promised to disclose.
 * `--global` needs no such pin: it names an absolute scope, and the project
 * query is not sent at all on that arm.
 */
function listRevealCommand(
  values: Record<string, string>,
  project: string,
  total: number,
): string {
  const parts = ["cctl notepad list"];
  if (values["global"] !== undefined) parts.push("--global");
  else parts.push(projectSelector(project));
  if (values["archived"] !== undefined) parts.push("--archived");
  parts.push(`--limit ${total}`);
  return parts.join(" ");
}

/**
 * `--project <name>`, in the form the CLI will read the name back from.
 *
 * A project is a directory basename, so it can itself look like a flag. Spelled
 * `--project --team`, the parser cannot tell the name from a forgotten value and
 * refuses it — a reveal that exits 2 discloses nothing. The attached form pins
 * the value positionally, so it survives; it is used only where the name needs
 * it, leaving the ordinary reveal in the CLI's usual spaced style.
 */
function projectSelector(project: string): string {
  const argument = revealArgument(project);
  return project.startsWith("-")
    ? `--project=${argument}`
    : `--project ${argument}`;
}

/**
 * A reveal argument as the caller's shell must receive it. A project name is a
 * directory basename and the resolver restricts no character, so a name can
 * carry a space, a `$`, a backtick, or a `;` — all of which a pasted command
 * line acts on. Unquoted, `--project My Repo` parses as `--project My`; DOUBLE
 * quoted, `"team$prod"` still expands to `team`, which is the silent
 * wrong-project disclosure this pins shut.
 *
 * So: POSIX single quotes, where the shell expands nothing, with the standard
 * `'\''` break-out for an embedded quote. Bare for an ordinary slug, so the
 * common reveal reads as a plain command.
 *
 * Quoting settles what the SHELL does with the name; what the CLI then reads it
 * back as is {@link projectSelector}'s job.
 */
function revealArgument(value: string): string {
  if (/^[A-Za-z0-9._@\/-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function runNotepad(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  return dispatchGroup({
    group: ["notepad"],
    rest,
    json: flags.json,
    handlers: {
      list: (r) => runNotepadList(r, flags, values, env, host),
      get: (r) => runNotepadGet(r, flags, values, env, host),
      create: (r) => runNotepadCreate(r, flags, values, env, host),
      update: (r) => runNotepadWrite("update", r, flags, values, env, host),
      append: (r) => runNotepadWrite("append", r, flags, values, env, host),
    },
  });
}

async function runNotepadList(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, "notepad list", json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure("notepad list takes no arguments", json);
  }
  const limit = listLimitValue(values, json);
  if (!limit.ok) return limit.result;

  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  // The default merges the global scope with the ambient project's notepads;
  // --global narrows to the scope that is reachable from every conversation.
  const query = new URLSearchParams();
  if (values["global"] !== undefined) query.set("scope", "global");
  else query.set("project", context.project);
  if (values["archived"] !== undefined) query.set("archived", "true");

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path: `${notepadPath()}?${query.toString()}`,
  });
  if (result.kind !== "ok") return failureFromRequest(result, json);

  const parsed = notepadListResponseSchema.safeParse(result.body);
  if (!parsed.success) return invalidResponseFailure("the notepad list", json);
  const notepads = parsed.data.notepads;

  // One cap over the items bounds both serializations, so the rows printed and
  // the rows the envelope carries cannot come apart.
  const bounded = boundedItems(
    notepads,
    limit.value,
    listRevealCommand(values, context.project, notepads.length),
  );
  const humanBody = `${[
    `notepads: ${omissionSummary(bounded.omission)}`,
    ...bounded.items.map(listRow),
  ].join("\n")}\n`;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanBody, {
      ok: true,
      notepads: bounded.items,
      ...bounded.omission,
      hint: LIST_HINT,
    }),
    stderr: "",
  };
}

async function runNotepadGet(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, "notepad get", json);
  if (denied) return denied;
  const notepadId = notepadIdArgument(rest, "get", json);
  if (!notepadId.ok) return notepadId.result;

  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path: notepadPath(notepadId.value),
  });
  if (result.kind !== "ok") return failureFromRequest(result, json);

  const parsed = notepadResponseSchema.safeParse(result.body);
  if (!parsed.success) return invalidResponseFailure("notepad get", json);
  const notepad = parsed.data.notepad;

  // A notepad grows without bound, so the content goes through the disclosure
  // primitive: a pipe truncated mid-document is exactly the corruption an agent
  // cannot detect.
  const outcome = await emitLarge(host, notepad.content, {
    format: "markdown",
    namePrefix: `notepad-${notepad.id.replace(/[^a-zA-Z0-9_-]+/gu, "-")}`,
  });
  if (outcome.kind === "unwritable") {
    return outcome.reason === "host_cannot_write"
      ? failure({
          exitCode: EXIT_OPERATION_FAILED,
          message: "notepad get: this CLI host cannot write artifact files",
          code: "write_unavailable",
          json,
        })
      : failure({
          exitCode: EXIT_OPERATION_FAILED,
          message: `notepad get: could not write ${JSON.stringify(outcome.path)}`,
          code: "write_failed",
          json,
        });
  }

  if (outcome.kind === "artifact") {
    return {
      exitCode: EXIT_OK,
      stdout: render(
        json,
        `${[
          ...detailLines(notepad),
          ...artifactReceiptLines(outcome.manifest),
        ].join("\n")}\n`,
        {
          ok: true,
          notepad: notepadMetadata(notepad),
          storage: "artifact",
          artifact: outcome.manifest,
        },
      ),
      stderr: "",
    };
  }

  // The content's own trailing newline is stripped before the one this body
  // ends with, so a notepad that ends in a blank line does not print as two.
  const humanBody = `${[
    ...detailLines(notepad),
    "",
    outcome.text.replace(/\n$/u, ""),
  ].join("\n")}\n`;
  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanBody, { ok: true, notepad }),
    stderr: "",
  };
}

/** The receipt that stands in for content stdout does not carry. */
function artifactReceiptLines(manifest: ArtifactManifest): string[] {
  return [
    `notepad get\tstdout budget exceeded`,
    `artifact: ${manifest.path}`,
    `format: ${manifest.format}`,
    `bytes: ${manifest.bytes}`,
    `sha256: ${manifest.sha256}`,
  ];
}

async function runNotepadCreate(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, "notepad create", json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure(
      "notepad create takes no arguments — pass fields as flags",
      json,
    );
  }
  const name = values["name"];
  if (name === undefined) {
    return usageFailure('notepad create requires --name "<name>"', json);
  }
  const content = await resolveProseArg(values, host, "content", json);
  if (!content.ok) return content.result;

  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;
  const global = values["global"] !== undefined;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: notepadPath(),
    headers: mutationHeaders(context),
    body: {
      scope: global ? "global" : "project",
      ...(global ? {} : { project: context.project }),
      name,
      ...(content.value !== undefined ? { content: content.value } : {}),
    },
  });
  if (result.kind !== "ok") return failureFromRequest(result, json);

  const parsed = notepadResponseSchema.safeParse(result.body);
  if (!parsed.success) return invalidResponseFailure("notepad create", json);
  const notepad = parsed.data.notepad;

  return {
    exitCode: EXIT_OK,
    stdout: render(
      json,
      `${[`created ${notepad.id}  ${notepad.name}`, metadataLine(notepad)].join("\n")}\n`,
      {
        ok: true,
        notepad,
        hint: `add to it with 'cctl notepad append ${notepad.id} --if-revision ${notepad.revision}'`,
      },
    ),
    stderr: "",
  };
}

/**
 * `update` and `append` are one code path because they differ only in the
 * operation they name: both address a notepad by id, both state the revision
 * they are based on, and both are governed by the same write mode. The server
 * owns which modes accept which operation, so the CLI never predicts a refusal.
 */
async function runNotepadWrite(
  operation: NotepadWriteOperation,
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, `notepad ${operation}`, json);
  if (denied) return denied;
  const notepadId = notepadIdArgument(rest, operation, json);
  if (!notepadId.ok) return notepadId.result;
  const baseRevision = baseRevisionFlag(values, operation, json);
  if (!baseRevision.ok) return baseRevision.result;
  const content = await resolveProseArg(values, host, "content", json);
  if (!content.ok) return content.result;
  if (content.value === undefined) {
    return usageFailure(
      `notepad ${operation} requires --content "<markdown>" or --content-file <path>`,
      json,
    );
  }

  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${notepadPath(notepadId.value)}/content`,
    headers: mutationHeaders(context),
    body: {
      operation,
      content: content.value,
      baseRevision: baseRevision.value,
    },
  });
  if (result.kind !== "ok") return failureFromRequest(result, json);

  const parsed = notepadResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return invalidResponseFailure(`notepad ${operation}`, json);
  }
  const notepad = parsed.data.notepad;
  const verb = operation === "update" ? "updated" : "appended to";

  return {
    exitCode: EXIT_OK,
    stdout: render(
      json,
      `${[`${verb} ${notepad.id}  ${notepad.name}`, metadataLine(notepad)].join("\n")}\n`,
      {
        ok: true,
        notepad,
        hint: `the next write to this notepad states --if-revision ${notepad.revision}`,
      },
    ),
    stderr: "",
  };
}
