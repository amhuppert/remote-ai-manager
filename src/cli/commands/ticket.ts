import path from "node:path";
import { z } from "zod";
import {
  buildAttachmentIndex,
  renderAttachmentIndexLines,
  type AttachmentIndexEntry,
} from "@/lib/tickets/attachment-index";
import { parseTicketIdentifier } from "@/lib/tickets/references";
import {
  startTicketOutputSchema,
  ticketAttachmentSchema,
  ticketDetailSchema,
  ticketListItemSchema,
  ticketListSortSchema,
  ticketLinkSummarySchema,
  ticketStartModeSchema,
  ticketStatusSchema,
  ticketWorkTypeSchema,
  deletedTicketSchema,
  type TicketDetail,
  type TicketLinkSummary,
  type TicketListItem,
} from "@/lib/tickets/schemas";
import { flagNamesFor } from "../help-registry";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  checkFlags,
  cliRequest,
  encodePathSegment,
  failure,
  failureFromRequest,
  render,
  resolveProjectContext,
  resolveToken,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliResult,
  type GlobalFlags,
  type TokenSource,
} from "../shared";

/**
 * `cctl ticket` — the agent ticket command group (ticket-system design §CLI
 * Contract): CRUD (`create|list|get|update|delete`), context attachment
 * (`attach <kind>` for the five kinds), and per-attachment operations
 * (`attachment get|update|remove`). Ticket references come in two forms: a
 * bare `<number>` resolving through the ambient project scope, and the
 * cross-scope `<project>#<number>` that works from any conversation. All
 * deterministic checks (subcommand, flags, reference shape, enum values, file
 * readability) fail at exit 2 before any network round-trip; an unknown ticket
 * is a server 404 (`ticket_not_found`) and exits 1 via the shared failure
 * mapping. `list` and `get` always render the typed attachment index — with
 * descriptions and exact retrieval/follow commands — in both text and `--json`
 * output (bounded entries on list, full descriptions on get) via the shared
 * renderer, so agents can selectively retrieve full content.
 */

const REF_USAGE = "<number> or <project>#<number>";

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

const LIST_HINT =
  "read one in full with 'cctl ticket get <number | project#number>'";

const ticketSessionLinksResponseSchema = z.record(
  z.string(),
  ticketLinkSummarySchema,
);

// ---------------------------------------------------------------------------
// Ticket references
// ---------------------------------------------------------------------------

interface TicketRef {
  /** null = bare-number form; resolves through the ambient project scope. */
  projectName: string | null;
  number: number;
}

const TICKET_NUMBER_PATTERN = /^[1-9][0-9]*$/;

export function parseTicketRef(
  raw: string,
): { ok: true; ref: TicketRef } | { ok: false; message: string } {
  const invalid = {
    ok: false as const,
    message: `invalid ticket reference "${raw}" — use ${REF_USAGE}`,
  };
  if (!raw.includes("#")) {
    if (!TICKET_NUMBER_PATTERN.test(raw)) return invalid;
    const number = Number(raw);
    if (!Number.isSafeInteger(number)) return invalid;
    return { ok: true, ref: { projectName: null, number } };
  }
  const parsed = parseTicketIdentifier(raw);
  if (!parsed) return invalid;
  return {
    ok: true,
    ref: { projectName: parsed.projectName, number: parsed.ticketNumber },
  };
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

interface TicketTarget {
  server: string;
  token: string | null;
  tokenSource: TokenSource | null;
  projectName: string;
}

/**
 * Server + token without a project requirement — the qualified
 * `<project>#<number>` form and `list --all` carry their own scope, so
 * demanding CC_PROJECT would break exactly the cross-scope cases the form
 * exists for.
 */
async function resolveServerContext(
  flags: GlobalFlags,
  env: CliEnv,
  host: CliHost,
): Promise<
  | { ok: true; context: Omit<TicketTarget, "projectName"> }
  | { ok: false; result: CliResult }
> {
  const server = flags.server ?? env["CC_SERVER_URL"];
  if (!server) {
    return {
      ok: false,
      result: usageFailure(
        "no server URL — pass --server or set CC_SERVER_URL",
        flags.json,
      ),
    };
  }
  const { token, source } = await resolveToken(flags, env, host);
  return { ok: true, context: { server, token, tokenSource: source } };
}

/**
 * Resolve where a ticket reference points: the reference's own project when
 * qualified, the ambient project scope (--project / CC_PROJECT) when bare.
 */
async function resolveTicketTarget(
  ref: TicketRef,
  flags: GlobalFlags,
  env: CliEnv,
  host: CliHost,
): Promise<
  { ok: true; target: TicketTarget } | { ok: false; result: CliResult }
> {
  if (ref.projectName !== null) {
    const base = await resolveServerContext(flags, env, host);
    if (!base.ok) return base;
    return {
      ok: true,
      target: { ...base.context, projectName: ref.projectName },
    };
  }
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved;
  const { server, project, token, tokenSource } = resolved.context;
  return {
    ok: true,
    target: { server, token, tokenSource, projectName: project },
  };
}

function ticketRefArgument(
  rest: string[],
  verb: string,
  json: boolean,
): { ok: true; ref: TicketRef } | { ok: false; result: CliResult } {
  const raw = rest[0];
  if (raw === undefined) {
    return {
      ok: false,
      result: usageFailure(
        `ticket ${verb} requires a <ticket> argument (${REF_USAGE})`,
        json,
      ),
    };
  }
  if (rest.length > 1) {
    return {
      ok: false,
      result: usageFailure(
        `ticket ${verb} takes a single <ticket> argument`,
        json,
      ),
    };
  }
  const parsed = parseTicketRef(raw);
  if (!parsed.ok) {
    return { ok: false, result: usageFailure(parsed.message, json) };
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Local enum validation (deterministic, pre-network)
// ---------------------------------------------------------------------------

function enumFlagValue<T extends string>(
  values: Record<string, string>,
  name: string,
  schema: z.ZodEnum<Record<string, T>>,
  json: boolean,
): { ok: true; value: T | undefined } | { ok: false; result: CliResult } {
  const raw = values[name];
  if (raw === undefined) return { ok: true, value: undefined };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      result: usageFailure(
        `invalid --${name} "${raw}" — one of: ${schema.options.join(", ")}`,
        json,
      ),
    };
  }
  return { ok: true, value: parsed.data };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function identifierOf(
  detail: Pick<TicketDetail, "projectName" | "number">,
): string {
  return `${detail.projectName}#${detail.number}`;
}

function ticketPath(projectName: string, number?: number): string {
  const base = `/api/projects/${encodePathSegment(projectName)}/tickets`;
  return number === undefined ? base : `${base}/${number}`;
}

function attachmentsPath(projectName: string, number: number): string {
  return `${ticketPath(projectName, number)}/attachments`;
}

function attachmentPath(
  projectName: string,
  number: number,
  attachmentId: string,
): string {
  return `${attachmentsPath(projectName, number)}/${encodePathSegment(attachmentId)}`;
}

/** `attachments:` block for text output — entries via the shared renderer. */
function renderIndexText(entries: AttachmentIndexEntry[]): string {
  if (entries.length === 0) return "attachments: none\n";
  return `attachments:\n${renderAttachmentIndexLines(entries).join("\n")}\n`;
}

function renderDetailText(
  detail: TicketDetail,
  sessionLinks: Record<string, TicketLinkSummary> | null,
): string {
  const lines = [
    `${identifierOf(detail)}  ${detail.title}`,
    `status: ${detail.status}  type: ${detail.workType}  created: ${detail.createdAt}  updated: ${detail.updatedAt}`,
  ];
  if (detail.sessions.length > 0) {
    const sessions = detail.sessions
      .map((link) => {
        if (link.endedAt !== null) {
          return `${link.sessionName} (ended: ${link.endReason ?? "unknown"})`;
        }
        const current = sessionLinks?.[link.sessionName];
        const active =
          current?.ticketId === detail.id &&
          current.linkedAt === link.linkedAt &&
          current.active;
        return `${link.sessionName} (${active ? "active" : "status unknown"})`;
      })
      .join(", ");
    lines.push(`sessions: ${sessions}`);
  }
  if (detail.description !== "") {
    lines.push("", detail.description);
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function runTicket(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const sub = rest[0];
  if (sub === undefined) {
    return usageFailure(
      "ticket requires a subcommand: create, list, get, update, delete, start, attach, or attachment",
      json,
    );
  }
  if (sub === "create") {
    return runTicketCreate(rest.slice(1), flags, values, env, host);
  }
  if (sub === "list") {
    return runTicketList(rest.slice(1), flags, values, env, host);
  }
  if (sub === "get") {
    return runTicketGet(rest.slice(1), flags, values, env, host);
  }
  if (sub === "update") {
    return runTicketUpdate(rest.slice(1), flags, values, env, host);
  }
  if (sub === "delete") {
    return runTicketDelete(rest.slice(1), flags, values, env, host);
  }
  if (sub === "start") {
    return runTicketStart(rest.slice(1), flags, values, env, host);
  }
  if (sub === "attach") {
    return runTicketAttach(rest.slice(1), flags, values, env, host);
  }
  if (sub === "attachment") {
    return runTicketAttachment(rest.slice(1), flags, values, env, host);
  }
  return usageFailure(`unknown ticket subcommand "${sub}"`, json);
}

async function runTicketCreate(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, flagNamesFor("ticket create"), json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure(
      "ticket create takes no arguments — pass fields as flags",
      json,
    );
  }

  const title = values["title"];
  if (title === undefined) {
    return usageFailure('ticket create requires --title "<title>"', json);
  }
  const rawType = values["type"];
  if (rawType === undefined) {
    return usageFailure(
      `ticket create requires --type <${ticketWorkTypeSchema.options.join("|")}>`,
      json,
    );
  }
  const workType = enumFlagValue(values, "type", ticketWorkTypeSchema, json);
  if (!workType.ok) return workType.result;
  const status = enumFlagValue(values, "status", ticketStatusSchema, json);
  if (!status.ok) return status.result;

  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const { server, project, token, tokenSource } = resolved.context;

  const result = await cliRequest(host, {
    server,
    token,
    tokenSource,
    method: "POST",
    path: ticketPath(project),
    body: {
      title,
      workType: workType.value,
      ...(values["description"] !== undefined
        ? { description: values["description"] }
        : {}),
      ...(status.value !== undefined ? { status: status.value } : {}),
    },
  });
  if (result.kind !== "ok") return failureFromRequest(result, json);

  const parsed = ticketDetailSchema.safeParse(result.body);
  if (!parsed.success) return invalidResponseFailure("ticket create", json);
  const humanBody = `created ${identifierOf(parsed.data)}  ${parsed.data.title}\n`;
  // Terminal: no hint.
  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanBody, {
      ok: true,
      ticket: parsed.data,
    }),
    stderr: "",
  };
}

async function runTicketList(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, flagNamesFor("ticket list"), json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure("ticket list takes no arguments", json);
  }

  const status = enumFlagValue(values, "status", ticketStatusSchema, json);
  if (!status.ok) return status.result;
  const workType = enumFlagValue(values, "type", ticketWorkTypeSchema, json);
  if (!workType.ok) return workType.result;
  const sort = enumFlagValue(values, "sort", ticketListSortSchema, json);
  if (!sort.ok) return sort.result;

  const all = values["all"] !== undefined;
  let target: Omit<TicketTarget, "projectName"> & { path: string };
  if (all) {
    const base = await resolveServerContext(flags, env, host);
    if (!base.ok) return base.result;
    target = { ...base.context, path: "/api/tickets" };
  } else {
    const resolved = await resolveProjectContext(flags, env, host);
    if (!resolved.ok) return resolved.result;
    const { server, project, token, tokenSource } = resolved.context;
    target = { server, token, tokenSource, path: ticketPath(project) };
  }

  const query = new URLSearchParams();
  if (status.value !== undefined) query.set("status", status.value);
  if (workType.value !== undefined) query.set("workType", workType.value);
  if (sort.value !== undefined) query.set("sort", sort.value);
  const queryString = query.size > 0 ? `?${query.toString()}` : "";

  const result = await cliRequest(host, {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
    method: "GET",
    path: `${target.path}${queryString}`,
  });
  if (result.kind !== "ok") return failureFromRequest(result, json);

  const parsed = z.array(ticketListItemSchema).safeParse(result.body);
  if (!parsed.success) return invalidResponseFailure("the ticket list", json);
  const tickets = parsed.data;
  const enriched = await Promise.all(
    tickets.map(async (item) => ({
      item,
      index: await fetchBoundedIndex(host, target, item, json),
    })),
  );
  const indexed: Array<
    TicketListItem & { attachmentIndex: AttachmentIndexEntry[] }
  > = [];
  for (const { item, index } of enriched) {
    if (!index.ok) return index.result;
    indexed.push({ ...item, attachmentIndex: index.entries });
  }

  const humanBody =
    indexed.length === 0
      ? "no tickets found\n"
      : `${indexed
          .map((item) => {
            const line = `${identifierOf(item)}  ${item.status}  ${item.workType}  ${item.title}`;
            const indexLines = renderAttachmentIndexLines(item.attachmentIndex);
            return [line, ...indexLines].join("\n");
          })
          .join("\n")}\n`;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanBody, {
      ok: true,
      tickets: indexed,
      hint: LIST_HINT,
    }),
    stderr: "",
  };
}

const attachmentsResponseSchema = z.object({
  attachments: z.array(ticketAttachmentSchema),
});

/**
 * Bounded index entries for one list item. The list endpoints return lean
 * items (design §HTTP API), so attachment rows come from each ticket's index
 * endpoint — skipped entirely when `attachmentCount` is 0. The index is a
 * required part of the list output (design §CLI Contract), so an enrichment
 * failure fails the whole command through the shared exit-code mapping rather
 * than silently rendering the ticket without its attachments.
 */
async function fetchBoundedIndex(
  host: CliHost,
  target: {
    server: string;
    token: string | null;
    tokenSource: TokenSource | null;
  },
  item: TicketListItem,
  json: boolean,
): Promise<
  | { ok: true; entries: AttachmentIndexEntry[] }
  | { ok: false; result: CliResult }
> {
  if (item.attachmentCount === 0) return { ok: true, entries: [] };
  const result = await cliRequest(host, {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
    method: "GET",
    path: attachmentsPath(item.projectName, item.number),
  });
  if (result.kind !== "ok") {
    return { ok: false, result: failureFromRequest(result, json) };
  }
  const parsed = attachmentsResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return {
      ok: false,
      result: invalidResponseFailure(
        `the attachment index for ${identifierOf(item)}`,
        json,
      ),
    };
  }
  return {
    ok: true,
    entries: buildAttachmentIndex({
      identifier: identifierOf(item),
      attachments: parsed.data.attachments,
      mode: "bounded",
    }),
  };
}

async function runTicketGet(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, flagNamesFor("ticket get"), json);
  if (denied) return denied;
  const ref = ticketRefArgument(rest, "get", json);
  if (!ref.ok) return ref.result;

  const resolved = await resolveTicketTarget(ref.ref, flags, env, host);
  if (!resolved.ok) return resolved.result;
  const { server, token, tokenSource, projectName } = resolved.target;

  const result = await cliRequest(host, {
    server,
    token,
    tokenSource,
    method: "GET",
    path: ticketPath(projectName, ref.ref.number),
  });
  if (result.kind !== "ok") return failureFromRequest(result, json);

  const parsed = ticketDetailSchema.safeParse(result.body);
  if (!parsed.success) {
    return invalidResponseFailure(
      `ticket ${projectName}#${ref.ref.number}`,
      json,
    );
  }

  const detail = parsed.data;
  let sessionLinks: Record<string, TicketLinkSummary> | null = null;
  if (!json && detail.sessions.some((link) => link.endedAt === null)) {
    const linksResult = await cliRequest(host, {
      server,
      token,
      tokenSource,
      method: "GET",
      path: `${ticketPath(projectName)}/session-links`,
    });
    if (linksResult.kind === "ok") {
      const links = ticketSessionLinksResponseSchema.safeParse(
        linksResult.body,
      );
      if (links.success) sessionLinks = links.data;
    }
  }
  const attachmentIndex = buildAttachmentIndex({
    identifier: identifierOf(detail),
    attachments: detail.attachments,
    mode: "full",
  });
  const humanBody = `${renderDetailText(detail, sessionLinks)}${renderIndexText(attachmentIndex)}`;
  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanBody, {
      ok: true,
      ticket: detail,
      attachmentIndex,
    }),
    stderr: "",
  };
}

async function runTicketUpdate(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, flagNamesFor("ticket update"), json);
  if (denied) return denied;
  const ref = ticketRefArgument(rest, "update", json);
  if (!ref.ok) return ref.result;

  const workType = enumFlagValue(values, "type", ticketWorkTypeSchema, json);
  if (!workType.ok) return workType.result;
  const status = enumFlagValue(values, "status", ticketStatusSchema, json);
  if (!status.ok) return status.result;

  const body: Record<string, string> = {};
  if (values["title"] !== undefined) body["title"] = values["title"];
  if (values["description"] !== undefined) {
    body["description"] = values["description"];
  }
  if (workType.value !== undefined) body["workType"] = workType.value;
  if (status.value !== undefined) body["status"] = status.value;
  if (Object.keys(body).length === 0) {
    return usageFailure(
      "ticket update requires at least one of --title, --description, --type, --status",
      json,
    );
  }

  const resolved = await resolveTicketTarget(ref.ref, flags, env, host);
  if (!resolved.ok) return resolved.result;
  const { server, token, tokenSource, projectName } = resolved.target;

  const result = await cliRequest(host, {
    server,
    token,
    tokenSource,
    method: "PATCH",
    path: ticketPath(projectName, ref.ref.number),
    body,
  });
  if (result.kind !== "ok") return failureFromRequest(result, json);

  const parsed = ticketDetailSchema.safeParse(result.body);
  if (!parsed.success) {
    return invalidResponseFailure(
      `ticket update for ${projectName}#${ref.ref.number}`,
      json,
    );
  }
  const identifier = identifierOf(parsed.data);
  // Terminal: no hint.
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `updated ${identifier}\n`, {
      ok: true,
      ticket: parsed.data,
    }),
    stderr: "",
  };
}

async function runTicketDelete(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, flagNamesFor("ticket delete"), json);
  if (denied) return denied;
  const ref = ticketRefArgument(rest, "delete", json);
  if (!ref.ok) return ref.result;

  const resolved = await resolveTicketTarget(ref.ref, flags, env, host);
  if (!resolved.ok) return resolved.result;
  const { server, token, tokenSource, projectName } = resolved.target;

  const result = await cliRequest(host, {
    server,
    token,
    tokenSource,
    method: "DELETE",
    path: ticketPath(projectName, ref.ref.number),
  });
  if (result.kind !== "ok") return failureFromRequest(result, json);

  const parsed = deletedTicketSchema.safeParse(result.body);
  if (!parsed.success) {
    return invalidResponseFailure(
      `ticket delete for ${projectName}#${ref.ref.number}`,
      json,
    );
  }
  const identifier = `${parsed.data.projectName}#${parsed.data.number}`;
  // Terminal: no hint.
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `deleted ${identifier}\n`, {
      ok: true,
      deleted: parsed.data,
    }),
    stderr: "",
  };
}

// ---------------------------------------------------------------------------
// ticket start
// ---------------------------------------------------------------------------

async function runTicketStart(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, flagNamesFor("ticket start"), json);
  if (denied) return denied;
  const ref = ticketRefArgument(rest, "start", json);
  if (!ref.ok) return ref.result;

  const rawMode = values["mode"];
  if (rawMode === undefined) {
    return usageFailure(
      `ticket start requires --mode <${ticketStartModeSchema.options.join("|")}>`,
      json,
    );
  }
  const mode = enumFlagValue(values, "mode", ticketStartModeSchema, json);
  if (!mode.ok) return mode.result;

  const resolved = await resolveTicketTarget(ref.ref, flags, env, host);
  if (!resolved.ok) return resolved.result;
  const { server, token, tokenSource, projectName } = resolved.target;
  const identifier = `${projectName}#${ref.ref.number}`;

  const result = await cliRequest(host, {
    server,
    token,
    tokenSource,
    method: "POST",
    path: `${ticketPath(projectName, ref.ref.number)}/start`,
    body: { mode: mode.value },
  });
  if (result.kind !== "ok") return failureFromRequest(result, json);

  const parsed = startTicketOutputSchema.safeParse(result.body);
  if (!parsed.success) {
    return invalidResponseFailure(`ticket start for ${identifier}`, json);
  }

  const output = parsed.data;
  const kickoffLine =
    mode.value === "prepared"
      ? "prepared — the session waits for your first prompt"
      : output.initialPromptQueued
        ? "agent kickoff queued — the first turn starts from the ticket"
        : "agent kickoff could NOT be queued — send the first prompt manually";
  const humanBody = `started ${identifier} in ${mode.value} mode\nsession: ${output.sessionName}\n${kickoffLine}\n`;
  // Terminal: no hint.
  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanBody, { ok: true, ...output }),
    stderr: "",
  };
}

// ---------------------------------------------------------------------------
// ticket attach <kind>
// ---------------------------------------------------------------------------

const ATTACH_KINDS = [
  "file",
  "conversation",
  "session",
  "ticket",
  "note",
] as const;
type AttachKind = (typeof ATTACH_KINDS)[number];

/** The kind-specific positional each attach kind takes, for usage messages. */
const ATTACH_ARG_NOUN: Record<AttachKind, string> = {
  file: "<path>",
  conversation: "<conversationId>",
  session: "<sessionName>",
  ticket: "<ticket>",
  note: '"<markdown>"',
};

function isAttachKind(value: string): value is AttachKind {
  return (ATTACH_KINDS as readonly string[]).includes(value);
}

/**
 * Multipart form-data encoder for the file-attach upload: a JSON `metadata`
 * part plus the raw `file` part, matching what the attachment route's platform
 * parser expects. Hand-rolled because the injected fetch seam carries plain
 * bytes, not FormData objects.
 */
function buildFileMultipart(input: {
  metadataJson: string;
  fileName: string;
  bytes: Uint8Array;
}): { contentType: string; rawBody: Uint8Array<ArrayBuffer> } {
  const boundary = `----cctl-ticket-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const safeFileName = input.fileName.replace(/["\r\n\\]/g, "_");
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\n` +
      `content-disposition: form-data; name="metadata"\r\n\r\n` +
      `${input.metadataJson}\r\n` +
      `--${boundary}\r\n` +
      `content-disposition: form-data; name="file"; filename="${safeFileName}"\r\n` +
      `content-type: application/octet-stream\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const rawBody = new Uint8Array(
    head.byteLength + input.bytes.byteLength + tail.byteLength,
  );
  rawBody.set(head, 0);
  rawBody.set(input.bytes, head.byteLength);
  rawBody.set(tail, head.byteLength + input.bytes.byteLength);
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    rawBody,
  };
}

async function runTicketAttach(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const kind = rest[0];
  if (kind === undefined || !isAttachKind(kind)) {
    return usageFailure(
      `ticket attach requires a kind: ${ATTACH_KINDS.join(", ")}`,
      json,
    );
  }
  const denied = checkFlags(
    values,
    flagNamesFor(`ticket attach ${kind}`),
    json,
  );
  if (denied) return denied;

  const refRaw = rest[1];
  if (refRaw === undefined) {
    return usageFailure(
      `ticket attach ${kind} requires a <ticket> argument (${REF_USAGE})`,
      json,
    );
  }
  const parsedRef = parseTicketRef(refRaw);
  if (!parsedRef.ok) return usageFailure(parsedRef.message, json);
  const ref = parsedRef.ref;

  const description = values["description"];
  if (description === undefined) {
    return usageFailure(
      `ticket attach ${kind} requires --description "<what and why>"`,
      json,
    );
  }

  // Every kind takes at most one positional after the <ticket> (the
  // conversation id is optional). Reject extras deterministically, before any
  // resolution or request.
  if (rest.length > 3) {
    return usageFailure(
      `ticket attach ${kind} takes a single ${ATTACH_ARG_NOUN[kind]} argument after the <ticket> — quote values with spaces`,
      json,
    );
  }

  const resolved = await resolveTicketTarget(ref, flags, env, host);
  if (!resolved.ok) return resolved.result;
  const target = resolved.target;
  const identifier = `${target.projectName}#${ref.number}`;

  if (kind === "file") {
    return attachFile(
      rest.slice(2),
      description,
      target,
      ref,
      values,
      json,
      host,
    );
  }

  const payload = await buildJsonAttachPayload(
    kind,
    rest.slice(2),
    flags,
    env,
    host,
    json,
  );
  if (!payload.ok) return payload.result;

  const result = await cliRequest(host, {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
    method: "POST",
    path: attachmentsPath(target.projectName, ref.number),
    body: { description, payload: payload.value },
  });
  if (result.kind !== "ok") return failureFromRequest(result, json);

  return attachedResult(result.body, kind, identifier, json);
}

/**
 * The JSON payload for the non-file kinds. Conversation and session pointers
 * belong to the AMBIENT project scope (they are "this project's conversation/
 * session"), independent of which project owns the host ticket; a related
 * ticket carries its own scope when the qualified form is used.
 */
async function buildJsonAttachPayload(
  kind: Exclude<AttachKind, "file">,
  args: string[],
  flags: GlobalFlags,
  env: CliEnv,
  host: CliHost,
  json: boolean,
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; result: CliResult }
> {
  if (kind === "note") {
    const markdown = args[0];
    if (markdown === undefined) {
      return {
        ok: false,
        result: usageFailure(
          'ticket attach note requires a "<markdown>" argument',
          json,
        ),
      };
    }
    return { ok: true, value: { kind: "note", markdown } };
  }

  if (kind === "ticket") {
    const relatedRaw = args[0];
    if (relatedRaw === undefined) {
      return {
        ok: false,
        result: usageFailure(
          `ticket attach ticket requires a related <ticket> argument (${REF_USAGE})`,
          json,
        ),
      };
    }
    const related = parseTicketRef(relatedRaw);
    if (!related.ok) {
      return { ok: false, result: usageFailure(related.message, json) };
    }
    const scope = await resolveTicketTarget(related.ref, flags, env, host);
    if (!scope.ok) return scope;
    return {
      ok: true,
      value: {
        kind: "related_ticket",
        projectName: scope.target.projectName,
        number: related.ref.number,
      },
    };
  }

  // conversation | session — both need the ambient project for the payload.
  const ambient = await resolveProjectContext(flags, env, host);
  if (!ambient.ok) return ambient;
  const projectName = ambient.context.project;

  if (kind === "session") {
    const sessionName = args[0];
    if (sessionName === undefined) {
      return {
        ok: false,
        result: usageFailure(
          "ticket attach session requires a <sessionName> argument",
          json,
        ),
      };
    }
    return { ok: true, value: { kind: "session", projectName, sessionName } };
  }

  const explicitId = args[0] ?? flags.conversation;
  const conversationId = explicitId ?? env["CC_CONVERSATION_ID"];
  if (conversationId === undefined) {
    return {
      ok: false,
      result: usageFailure(
        "no conversation to attach — pass <conversationId>, --conversation, or run inside a CC conversation (CC_CONVERSATION_ID)",
        json,
      ),
    };
  }
  // The env session identifies THIS conversation's session, so it only applies
  // when attaching the current conversation; an explicitly named conversation
  // (positional or --conversation) takes a session only from an explicit
  // --session.
  const sessionName =
    explicitId !== undefined
      ? (flags.session ?? null)
      : (flags.session ?? env["CC_SESSION"] ?? null);
  return {
    ok: true,
    value: { kind: "conversation", projectName, sessionName, conversationId },
  };
}

async function attachFile(
  args: string[],
  description: string,
  target: TicketTarget,
  ref: TicketRef,
  values: Record<string, string>,
  json: boolean,
  host: CliHost,
): Promise<CliResult> {
  const filePath = args[0];
  if (filePath === undefined) {
    return usageFailure("ticket attach file requires a <path> argument", json);
  }
  const bytes = await host.readFileBytes(filePath);
  if (bytes === null) {
    return usageFailure(`cannot read file "${filePath}"`, json);
  }

  const fileName = path.basename(filePath);
  const mediaType = values["media-type"];
  const multipart = buildFileMultipart({
    metadataJson: JSON.stringify({
      description,
      fileName,
      ...(mediaType !== undefined ? { mediaType } : {}),
    }),
    fileName,
    bytes,
  });

  const result = await cliRequest(host, {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
    method: "POST",
    path: attachmentsPath(target.projectName, ref.number),
    rawBody: multipart.rawBody,
    headers: { "content-type": multipart.contentType },
  });
  if (result.kind !== "ok") return failureFromRequest(result, json);

  return attachedResult(
    result.body,
    "file",
    `${target.projectName}#${ref.number}`,
    json,
  );
}

function attachedResult(
  body: unknown,
  kindArg: AttachKind,
  identifier: string,
  json: boolean,
): CliResult {
  const parsed = ticketAttachmentSchema.safeParse(body);
  if (!parsed.success) {
    return invalidResponseFailure(
      `ticket attach ${kindArg} for ${identifier}`,
      json,
    );
  }
  const kind = parsed.data.payload.kind;
  const idText = ` ${parsed.data.id}`;
  // Terminal: no hint — the index on `ticket get` is the follow-up surface.
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `attached ${kind}${idText} to ${identifier}\n`, {
      ok: true,
      attachment: parsed.data,
    }),
    stderr: "",
  };
}

// ---------------------------------------------------------------------------
// ticket attachment get|update|remove
// ---------------------------------------------------------------------------

/**
 * Boundary schema for the resolve endpoint's per-kind payload. Loose objects:
 * the CLI renders the fields below and forwards everything the server sent in
 * the `--json` envelope unchanged.
 */
const resolvedAttachmentSchema = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("file"),
    attachment: ticketAttachmentSchema,
    fileName: z.string(),
    mediaType: z.string().nullable(),
    sizeBytes: z.number(),
    encoding: z.enum(["utf8", "base64"]),
    content: z.string(),
  }),
  z.looseObject({
    kind: z.literal("conversation"),
    attachment: ticketAttachmentSchema,
    conversationId: z.string(),
    sessionName: z.string().nullable(),
    source: z.enum(["live_compaction", "retained_compaction"]),
    sourceAvailable: z.boolean(),
    markdown: z.string(),
    capturedAt: z.string(),
    readCommands: z.array(z.string()),
  }),
  z.looseObject({
    kind: z.literal("session"),
    attachment: ticketAttachmentSchema,
    projectName: z.string(),
    sessionName: z.string(),
    finished: z.boolean(),
    conversationIds: z.array(z.string()),
    readCommands: z.array(z.string()),
  }),
  // One member covers both availability arms (a discriminated union cannot
  // repeat the "related_ticket" discriminator); presence of `ticket` is the
  // in-member availability signal.
  z.looseObject({
    kind: z.literal("related_ticket"),
    attachment: ticketAttachmentSchema,
    available: z.boolean(),
    ticket: ticketDetailSchema.optional(),
    followCommand: z.string().optional(),
    identifierSnapshot: z.string().optional(),
  }),
  z.looseObject({
    kind: z.literal("note"),
    attachment: ticketAttachmentSchema,
    markdown: z.string(),
  }),
]);

const removedAttachmentSchema = z.object({
  attachmentId: z.string().min(1),
  ticketId: z.string().min(1),
  kind: z.enum(["file", "conversation", "session", "related_ticket", "note"]),
});
type ResolvedAttachmentBody = z.infer<typeof resolvedAttachmentSchema>;

function renderResolvedText(
  resolved: ResolvedAttachmentBody,
  identifier: string,
): string {
  const header = `${resolved.attachment.id} ${resolved.kind} on ${identifier} — ${resolved.attachment.description}`;
  if (resolved.kind === "note") {
    return `${header}\n\n${resolved.markdown}\n`;
  }
  if (resolved.kind === "file") {
    const meta = `file: ${resolved.fileName} (${resolved.mediaType ?? "unknown type"}, ${resolved.sizeBytes} bytes)`;
    const content =
      resolved.encoding === "utf8"
        ? resolved.content
        : `content (base64):\n${resolved.content}`;
    return `${header}\n${meta}\n\n${content}\n`;
  }
  if (resolved.kind === "conversation") {
    const sourceLine =
      resolved.source === "live_compaction"
        ? "source: live compaction of the conversation"
        : `source: retained compaction snapshot (captured ${resolved.capturedAt})${
            resolved.sourceAvailable
              ? ""
              : " — the source conversation no longer exists"
          }`;
    // The service owns which read commands still apply (e.g. a compaction
    // read outlives the source conversation) — render whatever it sent.
    const commands = resolved.readCommands.map((cmd) => `- ${cmd}`).join("\n");
    const followUp =
      resolved.readCommands.length > 0 ? `read commands:\n${commands}\n` : "";
    return `${header}\nconversation: ${resolved.conversationId}${
      resolved.sessionName !== null ? ` (session ${resolved.sessionName})` : ""
    }\n${sourceLine}\n\n${resolved.markdown}\n${followUp}`;
  }
  if (resolved.kind === "session") {
    const commands = resolved.readCommands.map((cmd) => `- ${cmd}`).join("\n");
    return `${header}\nsession: ${resolved.projectName}/${resolved.sessionName} (${
      resolved.finished ? "finished" : "live"
    }, ${resolved.conversationIds.length} conversation(s))\nread commands:\n${commands}\n`;
  }
  const ticket = resolved.ticket;
  if (!resolved.available || ticket === undefined) {
    return `${header}\nrelated ticket ${resolved.identifierSnapshot ?? "(unknown)"} is no longer available (deleted)\n`;
  }
  const relatedIndex = buildAttachmentIndex({
    identifier: identifierOf(ticket),
    attachments: ticket.attachments,
    mode: "full",
  });
  const follow =
    resolved.followCommand ?? `cctl ticket get ${identifierOf(ticket)}`;
  return `${header}\nrelated ticket: ${identifierOf(ticket)}  ${ticket.title} (${ticket.status})\nfollow: ${follow}\n${renderIndexText(relatedIndex)}`;
}

async function runTicketAttachment(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const verb = rest[0];
  if (verb !== "get" && verb !== "update" && verb !== "remove") {
    return usageFailure(
      "ticket attachment requires a subcommand: get, update, or remove",
      json,
    );
  }
  const denied = checkFlags(
    values,
    flagNamesFor(`ticket attachment ${verb}`),
    json,
  );
  if (denied) return denied;

  const refRaw = rest[1];
  if (refRaw === undefined) {
    return usageFailure(
      `ticket attachment ${verb} requires a <ticket> argument (${REF_USAGE})`,
      json,
    );
  }
  const parsedRef = parseTicketRef(refRaw);
  if (!parsedRef.ok) return usageFailure(parsedRef.message, json);
  const attachmentId = rest[2];
  if (attachmentId === undefined) {
    return usageFailure(
      `ticket attachment ${verb} requires an <attachmentId> argument`,
      json,
    );
  }
  if (rest.length > 3) {
    return usageFailure(
      `ticket attachment ${verb} takes <ticket> and <attachmentId> arguments only`,
      json,
    );
  }

  const body: Record<string, string> = {};
  if (verb === "update") {
    if (values["description"] !== undefined) {
      body["description"] = values["description"];
    }
    if (values["markdown"] !== undefined) {
      body["markdown"] = values["markdown"];
    }
    if (Object.keys(body).length === 0) {
      return usageFailure(
        "ticket attachment update requires at least one of --description, --markdown",
        json,
      );
    }
  }

  const resolved = await resolveTicketTarget(parsedRef.ref, flags, env, host);
  if (!resolved.ok) return resolved.result;
  const { server, token, tokenSource, projectName } = resolved.target;
  const identifier = `${projectName}#${parsedRef.ref.number}`;
  const requestPath = attachmentPath(
    projectName,
    parsedRef.ref.number,
    attachmentId,
  );

  if (verb === "get") {
    const result = await cliRequest(host, {
      server,
      token,
      tokenSource,
      method: "GET",
      path: requestPath,
    });
    if (result.kind !== "ok") return failureFromRequest(result, json);

    const parsed = resolvedAttachmentSchema.safeParse(result.body);
    if (!parsed.success) {
      return invalidResponseFailure(
        `attachment ${attachmentId} on ${identifier}`,
        json,
      );
    }
    const humanBody = renderResolvedText(parsed.data, identifier);
    return {
      exitCode: EXIT_OK,
      stdout: render(json, humanBody, {
        ok: true,
        attachment: parsed.data,
      }),
      stderr: "",
    };
  }

  if (verb === "update") {
    const result = await cliRequest(host, {
      server,
      token,
      tokenSource,
      method: "PATCH",
      path: requestPath,
      body,
    });
    if (result.kind !== "ok") return failureFromRequest(result, json);

    const parsed = ticketAttachmentSchema.safeParse(result.body);
    if (!parsed.success) {
      return invalidResponseFailure(
        `attachment update ${attachmentId} on ${identifier}`,
        json,
      );
    }
    // Terminal: no hint.
    return {
      exitCode: EXIT_OK,
      stdout: render(
        json,
        `updated attachment ${attachmentId} on ${identifier}\n`,
        { ok: true, attachment: parsed.data },
      ),
      stderr: "",
    };
  }

  const result = await cliRequest(host, {
    server,
    token,
    tokenSource,
    method: "DELETE",
    path: requestPath,
  });
  if (result.kind !== "ok") return failureFromRequest(result, json);
  const parsed = removedAttachmentSchema.safeParse(result.body);
  if (!parsed.success) {
    return invalidResponseFailure(
      `attachment remove ${attachmentId} on ${identifier}`,
      json,
    );
  }

  // Terminal: no hint.
  return {
    exitCode: EXIT_OK,
    stdout: render(
      json,
      `removed attachment ${attachmentId} from ${identifier}\n`,
      { ok: true, removed: parsed.data },
    ),
    stderr: "",
  };
}
