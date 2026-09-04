import { z } from "zod";

import { describeMemoryAge, renderMemoryStatusLine } from "@/lib/memory/age";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
import {
  listNativeMemoryExceptions,
  renderNativeMemoryDisclosureLine,
} from "@/lib/agent-backends/native-memory";
import {
  memoryIndexModeSchema,
  memoryKindSchema,
  memoryLifecycleSchema,
  memoryLinkSchema,
  memoryNoteSchema,
  memoryRecallModeSchema,
  memoryReviewQueueEntrySchema,
  memoryIndexDeliveryKindSchema,
  memoryLinkKindSchema,
  memoryScopeSchema,
  memoryStatusNoteSchema,
  type MemoryLink,
  type MemoryNote,
  type MemoryReviewQueueEntry,
  type MemoryScope,
} from "@/lib/memory/schemas";

import { dispatchGroup } from "../dispatch";
import { boundedItems, omissionSummary, type Omission } from "../disclosure";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  checkFlags,
  cliRequest,
  encodePathSegment,
  failure,
  failureFromRequest,
  invalidResponseFailure,
  render,
  resolveProjectConversationContext,
  resolveProseArg,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliRequestResult,
  type CliResult,
  type GlobalFlags,
  type ProjectConversationContext,
} from "../shared";

/**
 * `cctl memory` — the agent surface over Command Center's shared memory (spec
 * R12). Fifteen verbs: recall, index, list, get, create, update, link, unlink,
 * mark-reviewed, observe-rederivation, promote, review, archive, delete,
 * export.
 *
 * What is ABSENT is the design. Approving or rejecting a proposed global note
 * is a human act, and restoring one revision over another is a judgement made
 * while reading the history — both live in the Memory Library and have no verb
 * here, so the registry this group derives its dispatch from cannot advertise
 * one.
 *
 * **Slugs are the whole agent-facing identity.** Every verb accepts an internal
 * id in the same argument position, but no default text output ever prints one:
 * a slug is what an index hook, a recall pack, and a list row all carry, and a
 * rename leaves the old slug behind as a resolving alias, so a handle an agent
 * learned never strands. `--json` carries both.
 *
 * Scope authority is never spelled here. The caller conversation rides the
 * request and the server derives the project, the session incarnation, and the
 * visible union from it, so a command cannot name a scope its conversation does
 * not occupy. `--scope` narrows an ambiguous handle; it never widens a reach.
 */

/** The caller conversation the server resolves scope and policy from. */
const CALLER_CONVERSATION_HEADER = "x-cc-conversation-id";

/** Rows the bounded default prints before it names the reveal command. */
const MEMORY_LIST_LIMIT = 20;

/** The literal that clears a nullable field a flag would otherwise set. */
const CLEAR_TOKEN = "none";

const LIST_HINT = "read one in full with 'cctl memory get <slug>'";

/**
 * What a command names when it has no server-confirmed slug to name. A verb
 * that refuses BEFORE its request — a missing `--if-revision`, an unconfirmed
 * delete — holds only the handle the caller typed, which may be an internal id;
 * echoing it back would put an id in agent-facing text.
 */
const SLUG_PLACEHOLDER = "<slug>";

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const noteResponseSchema = z.object({ note: memoryNoteSchema });
const noteListResponseSchema = z.object({ notes: z.array(memoryNoteSchema) });
const lineageSchema = z.object({
  supersedes: z.string().nullable(),
  supersededBy: z.string().nullable(),
});
const noteDetailResponseSchema = z.object({
  note: memoryNoteSchema,
  links: z.array(memoryLinkSchema),
  lineage: lineageSchema,
});
const createResponseSchema = z.object({
  note: memoryNoteSchema,
  advisories: z.object({
    overlapCandidates: z.array(
      z.object({
        slug: z.string(),
        scope: memoryScopeSchema,
        hook: z.string(),
      }),
    ),
    hookWarnings: z.array(z.object({ code: z.string(), message: z.string() })),
  }),
});
const linkResponseSchema = z.object({
  link: memoryLinkSchema,
  note: memoryNoteSchema,
});
const reviewedResponseSchema = z.object({
  note: memoryNoteSchema,
  /** Present, and non-null, only for a status re-lease (R2.2). */
  statusReLease: memoryStatusNoteSchema.nullable(),
});
/**
 * Identities only. An observation verb that answered with a count would put a
 * note's retrieval history in front of an agent, which is the reasoning
 * `inv-no-popularity-or-telemetry-rank` exists to keep out of the loop.
 */
const rederivedResponseSchema = z.object({
  observed: z.object({
    memoryId: z.string(),
    slug: z.string(),
    conversationId: z.string().nullable(),
    executionId: z.string().nullable(),
    contextId: z.string().nullable(),
  }),
});
const promoteResponseSchema = z.object({
  promoted: memoryNoteSchema,
  superseded: memoryNoteSchema,
});
const reviewQueueResponseSchema = z.object({
  entries: z.array(memoryReviewQueueEntrySchema),
});

/**
 * Only the fields these two verbs render. The pack and the block are composed,
 * budgeted, and closed with their own disclosure line server-side, so the CLI
 * relays that text rather than re-deriving a rendering from the records.
 */
const recallResponseSchema = z.object({
  pack: z.object({
    mode: memoryRecallModeSchema,
    text: z.string(),
    showing: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    narrowCommand: z.string().nullable(),
    entries: z.array(
      z.object({
        note: memoryNoteSchema,
        tier: z.enum(["full", "hook"]),
        statusLine: z.string().nullable(),
        readCommand: z.string(),
      }),
    ),
  }),
});
const indexResponseSchema = z.object({
  /** Which render came back — null when the conversation is told nothing. */
  mode: memoryIndexDeliveryKindSchema.nullable(),
  block: z
    .object({
      text: z.string(),
      bytes: z.number().int().nonnegative(),
      omitted: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      withheld: z.object({
        reviewDue: z.number().int().nonnegative(),
        expired: z.number().int().nonnegative(),
        proposed: z.number().int().nonnegative(),
      }),
      entries: z.array(
        z.object({
          memoryId: z.string(),
          revision: z.number().int().positive(),
          slug: z.string(),
          scope: memoryScopeSchema,
          section: z.string(),
          statusDelivered: z.boolean(),
        }),
      ),
    })
    .nullable(),
});
const exportResponseSchema = z.object({
  archive: z.string(),
  noteCount: z.number().int().nonnegative(),
  generatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function notesPath(handle?: string, sub?: string): string {
  if (handle === undefined) return "/api/memory/notes";
  const base = `/api/memory/notes/${encodePathSegment(handle)}`;
  return sub === undefined ? base : `${base}/${sub}`;
}

function callerHeaders(
  context: ProjectConversationContext,
): Record<string, string> {
  return { [CALLER_CONVERSATION_HEADER]: context.conversation };
}

// ---------------------------------------------------------------------------
// Arguments and flags
// ---------------------------------------------------------------------------

type Parsed<T> = { ok: true; value: T } | { ok: false; result: CliResult };

function handleArgument(
  rest: string[],
  verb: string,
  json: boolean,
): Parsed<string> {
  const raw = rest[0];
  if (raw === undefined || raw.trim() === "") {
    return {
      ok: false,
      result: usageFailure(
        `memory ${verb} requires a <slug> argument — take it from an index hook, a recall pack, or a 'cctl memory list' row`,
        json,
      ),
    };
  }
  if (rest.length > 1) {
    return {
      ok: false,
      result: usageFailure(
        `memory ${verb} takes a single <slug> argument`,
        json,
      ),
    };
  }
  return { ok: true, value: raw };
}

/** A flag whose value must be one of an enum's members, checked before any request. */
function enumFlag<T extends string>(
  values: Record<string, string>,
  name: string,
  schema: z.ZodType<T>,
  command: string,
  json: boolean,
): Parsed<T | undefined> {
  const raw = values[name];
  if (raw === undefined) return { ok: true, value: undefined };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      result: usageFailure(
        `${command}: --${name} "${raw}" is not one of ${optionsOf(schema).join(", ")}`,
        json,
      ),
    };
  }
  return { ok: true, value: parsed.data };
}

function optionsOf(schema: z.ZodType<string>): string[] {
  const json = z.toJSONSchema(schema) as { enum?: unknown };
  return Array.isArray(json.enum) ? json.enum.map(String) : [];
}

function positiveIntFlag(
  values: Record<string, string>,
  name: string,
  command: string,
  json: boolean,
): Parsed<number | undefined> {
  const raw = values[name];
  if (raw === undefined) return { ok: true, value: undefined };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return {
      ok: false,
      result: usageFailure(
        `${command}: --${name} must be a positive integer, received "${raw}"`,
        json,
      ),
    };
  }
  return { ok: true, value: parsed };
}

/**
 * A nullable field a flag sets: absent leaves it, `none` clears it, anything
 * else is the new value. One rule across every nullable field, so an agent that
 * learns how to drop a status line already knows how to drop an expiry.
 */
function nullableFlag(
  values: Record<string, string>,
  name: string,
): string | null | undefined {
  const raw = values[name];
  if (raw === undefined) return undefined;
  return raw === CLEAR_TOKEN ? null : raw;
}

function nullableProse(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === CLEAR_TOKEN ? null : value;
}

/** `--scope` as a handle narrowing, for the verbs that address one note. */
function scopeQuery(scope: MemoryScope | undefined): string {
  return scope === undefined ? "" : `?scope=${scope}`;
}

// ---------------------------------------------------------------------------
// Refusal composition
// ---------------------------------------------------------------------------

/**
 * The server authors every refusal's message and reason; the CLI adds the exact
 * command that recovers from it, because only the CLI knows which verb was run.
 * The two refusals R12 names by hand are the ones that need it: an ambiguous
 * slug has to come back with a runnable per-scope narrowing, and a stale
 * revision with the revision to state next.
 *
 * Every recovery names the SERVER's slug rather than the handle the caller
 * sent. The caller's handle may be an internal id or an alias, and echoing an
 * id into refusal text is exactly what inv-slug-only-text-output forbids — so
 * the refusal detail is also the only thing that makes the command runnable,
 * because a narrowing spelled with an id would resolve without the scope.
 */
function memoryFailure(
  result: Exclude<CliRequestResult, { kind: "ok" }>,
  json: boolean,
  recovery: { verb: string },
): CliResult {
  if (result.kind !== "error") return failureFromRequest(result, json);

  if (result.code === "ambiguous_handle" && isRecord(result.details)) {
    const candidates = candidateRows(result.details["candidates"]);
    if (candidates.length > 0) {
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: result.error,
        detail: candidates
          .map(
            (candidate) =>
              `  ${candidate.slug} [${candidate.scope}] ${candidate.lifecycle} — cctl memory ${recovery.verb} ${candidate.slug} --scope ${candidate.scope}`,
          )
          .join("\n"),
        code: result.code,
        ...(result.rationale ? { rationale: result.rationale } : {}),
        instruction: `Re-run narrowed to one scope, for example: cctl memory ${recovery.verb} ${candidates[0]?.slug ?? SLUG_PLACEHOLDER} --scope ${candidates[0]?.scope ?? "project"}`,
        ...(result.details ? { details: result.details } : {}),
        json,
      });
    }
  }

  if (result.code === "stale_revision" && isRecord(result.details)) {
    const current = result.details["currentRevision"];
    const slug = result.details["slug"];
    if (typeof current === "number") {
      const named = typeof slug === "string" ? slug : SLUG_PLACEHOLDER;
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: result.error,
        code: result.code,
        ...(result.rationale ? { rationale: result.rationale } : {}),
        instruction: `Re-read with 'cctl memory get ${named}', then re-run with --if-revision ${current}.`,
        details: result.details,
        json,
      });
    }
  }

  return failureFromRequest(result, json);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const candidateRowSchema = z.object({
  slug: z.string(),
  scope: memoryScopeSchema,
  lifecycle: memoryLifecycleSchema,
});

function candidateRows(
  value: unknown,
): { slug: string; scope: MemoryScope; lifecycle: string }[] {
  const parsed = z.array(candidateRowSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** `global`, `project`, or `session(<name>)` — where a note lives. */
function scopeLabel(note: MemoryNote): string {
  return note.scope === "session" && note.sessionName !== null
    ? `session(${note.sessionName})`
    : note.scope;
}

function listRow(note: MemoryNote): string {
  const marks = [
    note.lifecycle === "active" ? "" : note.lifecycle,
    note.indexMode === "auto" ? "" : note.indexMode,
  ]
    .filter((mark) => mark !== "")
    .join(" ");
  return [
    note.slug,
    scopeLabel(note),
    note.kind,
    ...(marks === "" ? [] : [marks]),
    note.hook,
  ].join("  ");
}

/**
 * The facts a caller needs to write next: which note, at which revision, and
 * how old its perishable claim is. The revision is what a following update,
 * archive, or promote states as `--if-revision`.
 */
function detailLines(note: MemoryNote, now: string): string[] {
  const lines = [
    `${note.slug}  ${scopeLabel(note)}  ${note.kind}  ${note.lifecycle}`,
    `revision: ${note.revision}  index-mode: ${note.indexMode}  updated: ${describeMemoryAge(note.updatedAt, now)}`,
    `hook: ${note.hook}`,
  ];
  if (note.aliases.length > 0) {
    lines.push(`aliases: ${note.aliases.join(", ")}`);
  }
  if (note.statusNote !== null) {
    lines.push(`status: ${renderMemoryStatusLine(note.statusNote, now)}`);
  }
  if (note.reviewAfter !== null) {
    lines.push(`review-after: ${note.reviewAfter}`);
  }
  if (note.expiresAt !== null) {
    lines.push(`expires-at: ${note.expiresAt}`);
  }
  return lines;
}

/**
 * Where this note sits in its own lineage. A reader who followed a stale slug
 * out of an old transcript is shown the retired note; without this line nothing
 * tells them a replacement exists, which is the failure supersession was added
 * to prevent. Named by SLUG, because the id the pointer is stored as is not a
 * handle any verb takes.
 */
function lineageLines(lineage: {
  supersedes: string | null;
  supersededBy: string | null;
}): string[] {
  const lines: string[] = [];
  if (lineage.supersededBy !== null) {
    lines.push(
      `superseded by: ${lineage.supersededBy} — this note was replaced; read that one`,
    );
  }
  if (lineage.supersedes !== null) {
    lines.push(`supersedes: ${lineage.supersedes}`);
  }
  return lines;
}

function linkRow(link: MemoryLink): string {
  return `  ${link.kind}: ${artifactLabel(link)}`;
}

/**
 * The artifact in the same handle form `--artifact` accepts, so a link a read
 * prints can be unlinked by copying the line.
 */
function artifactLabel(link: MemoryLink): string {
  const artifact = link.artifact;
  switch (artifact.kind) {
    case "ticket":
      return `ticket:${artifact.ticketId}`;
    case "spec":
      return `spec:${artifact.specId}`;
    case "workflow_execution":
      return `execution:${artifact.executionId}`;
    case "workflow_context":
      return `context:${artifact.executionId}/${artifact.contextId}`;
    case "session":
      return `session:${artifact.sessionName}@${artifact.sessionCreatedAt}`;
  }
}

/** One review-queue row: the note, why it is queued, and what clears it. */
function reviewRow(entry: MemoryReviewQueueEntry): string {
  const reasons = [
    ...(entry.expired ? ["expired"] : []),
    ...(entry.noteReviewDue ? ["note review due"] : []),
    ...(entry.statusReviewDue ? ["status review due"] : []),
    ...(entry.promotionCandidate ? ["promotion candidate"] : []),
  ].join(", ");
  const clears = entry.promotionCandidate
    ? `cctl memory promote ${entry.note.slug}`
    : entry.statusReviewDue && !entry.noteReviewDue
      ? `cctl memory mark-reviewed ${entry.note.slug} --status`
      : `cctl memory mark-reviewed ${entry.note.slug}`;
  return [
    entry.note.slug,
    scopeLabel(entry.note),
    reasons,
    `— ${clears}`,
    entry.note.hook,
  ].join("  ");
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function runMemory(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  lists: Record<string, string[]>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  return dispatchGroup({
    group: ["memory"],
    rest,
    json: flags.json,
    handlers: {
      recall: (r) => runRecall(r, flags, values, env, host),
      index: (r) => runIndex(r, flags, values, env, host),
      list: (r) => runList(r, flags, values, env, host),
      get: (r) => runGet(r, flags, values, env, host),
      create: (r) => runCreate(r, flags, values, lists, env, host),
      update: (r) => runUpdate(r, flags, values, lists, env, host),
      link: (r) => runLinkVerb("link", r, flags, values, env, host),
      unlink: (r) => runLinkVerb("unlink", r, flags, values, env, host),
      "mark-reviewed": (r) => runMarkReviewed(r, flags, values, env, host),
      "observe-rederivation": (r) =>
        runObserveRederivation(r, flags, values, env, host),
      promote: (r) => runPromote(r, flags, values, env, host),
      review: (r) => runReview(r, flags, values, env, host),
      archive: (r) => runArchive(r, flags, values, env, host),
      delete: (r) => runDelete(r, flags, values, env, host),
      export: (r) => runExport(r, flags, values, env, host),
    },
  });
}

// ---------------------------------------------------------------------------
// Retrieval verbs
// ---------------------------------------------------------------------------

async function runRecall(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "memory recall", json);
  if (denied) return denied;
  if (rest.length > 1) {
    return usageFailure(
      "memory recall takes at most one query — quote it as a single argument",
      json,
    );
  }
  const scope = enumFlag(
    values,
    "scope",
    memoryScopeSchema,
    "memory recall",
    json,
  );
  if (!scope.ok) return scope.result;
  const budget = positiveIntFlag(values, "budget", "memory recall", json);
  if (!budget.ok) return budget.result;

  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const query = rest[0];
  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: "/api/memory/recall",
    headers: callerHeaders(context),
    body: {
      ...(query !== undefined && query !== "" ? { query } : {}),
      ...(values["related"] !== undefined
        ? { related: values["related"] }
        : {}),
      ...(scope.value !== undefined ? { scope: scope.value } : {}),
      ...(budget.value !== undefined ? { budgetChars: budget.value } : {}),
    },
  });
  if (result.kind !== "ok") return failureFromRequest(result, json);

  const parsed = recallResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return invalidResponseFailure({
      what: "the memory recall pack",
      issues: parsed.error.issues,
      json,
    });
  }
  const pack = parsed.data.pack;

  // The pack is bounded and closed with its own showing-N-of-M line server-
  // side; the envelope restates the same counts through the shared fragment so
  // the two serializations cannot disagree about what was left out.
  const omission: Omission =
    pack.showing < pack.total && pack.narrowCommand !== null
      ? {
          total: pack.total,
          returned: pack.showing,
          truncated: true,
          reveal: pack.narrowCommand,
        }
      : { total: pack.total, returned: pack.showing, truncated: false };

  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${pack.text}\n`, {
      ok: true,
      mode: pack.mode,
      pack: pack.text,
      // The pack TEXT names slugs only; the envelope is the one place a memory
      // id may appear (inv-slug-only-text-output), and it carries both so a
      // --json consumer can address a record the text taught it to want.
      entries: pack.entries.map((entry) => ({
        memoryId: entry.note.id,
        slug: entry.note.slug,
        scope: entry.note.scope,
        revision: entry.note.revision,
        tier: entry.tier,
        readCommand: entry.readCommand,
      })),
      ...omission,
    }),
    stderr: "",
  };
}

async function runIndex(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  // A block is composed for one conversation's next turn, so there is nothing a
  // project or a session would be a preview OF: the two would have to be
  // synthesized from a request no turn ever makes. Both spellings an agent
  // reaches for are refused ahead of the unknown-flag check, which would
  // otherwise answer `--scope` with a message that never names what does work.
  const preview =
    values["scope"] !== undefined
      ? "--scope"
      : flags.session !== undefined
        ? "--session"
        : null;
  if (preview !== null) {
    return usageFailure(
      `memory index has no ${preview} preview — a memory block is composed for one conversation's next turn, so name one: cctl memory index --conversation <id>`,
      json,
    );
  }
  const denied = checkFlags(values, "memory index", json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure(
      "memory index takes no arguments — name a conversation with --conversation",
      json,
    );
  }
  // The DEFAULT is the delivery due for the conversation as it stands — a delta
  // once it already holds a block — composed by the provider the turn itself
  // uses. Which configuration a dispatcher will hand that turn is held nowhere
  // this verb can read, so the default answers for the conversation rather than
  // guaranteeing the turn. `--full` asks for the whole index instead, which is
  // what a human reads to see everything the conversation can be told.
  const full = values["full"] !== undefined;

  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path: `/api/memory/index?conversation=${encodeURIComponent(context.conversation)}${full ? "&full=true" : ""}`,
    headers: callerHeaders(context),
  });
  if (result.kind !== "ok") return failureFromRequest(result, json);

  const parsed = indexResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return invalidResponseFailure({
      what: "the memory index block",
      issues: parsed.error.issues,
      json,
    });
  }
  const { block, mode } = parsed.data;

  // A backend Command Center could not neutralize is still running its own
  // memory beside this block, and the operator has to be told without going
  // looking (R14). It heads stderr for the same reason the no-block sentence
  // does: stdout is the block byte-for-byte, so anything else printed there
  // would be a byte the turn never carries. `--json` carries the same fact
  // structurally, where an empty array IS the nothing-to-disclose answer.
  const nativeMemoryExceptions = listNativeMemoryExceptions(
    listBackendCatalogEntries(),
  );
  const disclosure = renderNativeMemoryDisclosureLine(nativeMemoryExceptions);
  const stderrHeader = disclosure === null ? "" : `${disclosure}\n`;

  // Nothing is injected when the provider answers null, so stdout is EMPTY:
  // this verb's stdout is the block, and a "there is no block" sentence printed
  // there would be a byte the turn never carries. The explanation goes to
  // stderr, which no comparison with the injected text can see.
  if (block === null) {
    return {
      exitCode: EXIT_OK,
      stdout: json
        ? render(json, "", {
            ok: true,
            mode,
            block: null,
            entries: [],
            nativeMemoryExceptions,
            hint: "capture the first note with 'cctl memory create --hook \"<one line>\"'",
          })
        : "",
      stderr: json
        ? ""
        : `${stderrHeader}no memory block: this conversation is told nothing right now\n`,
    };
  }

  // The text is relayed VERBATIM and unterminated: this is the block the turn
  // injects, so a trailing newline added for the terminal's sake would make the
  // preview one byte different from the thing it previews (R12.2, R13.1).
  return {
    exitCode: EXIT_OK,
    stdout: render(json, block.text, {
      ok: true,
      mode,
      block: block.text,
      bytes: block.bytes,
      omitted: block.omitted,
      total: block.total,
      withheld: block.withheld,
      // Both identities, as the envelope contract requires: the block text
      // carries slugs, and the watermark consumer needs the id and revision.
      entries: block.entries,
      nativeMemoryExceptions,
    }),
    stderr: json ? "" : stderrHeader,
  };
}

async function runList(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "memory list", json);
  if (denied) return denied;
  if (rest.length > 0)
    return usageFailure("memory list takes no arguments", json);

  const scope = enumFlag(
    values,
    "scope",
    memoryScopeSchema,
    "memory list",
    json,
  );
  if (!scope.ok) return scope.result;
  const lifecycle = enumFlag(
    values,
    "lifecycle",
    memoryLifecycleSchema,
    "memory list",
    json,
  );
  if (!lifecycle.ok) return lifecycle.result;
  const limit = positiveIntFlag(values, "limit", "memory list", json);
  if (!limit.ok) return limit.result;

  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const query = new URLSearchParams();
  if (scope.value !== undefined) query.set("scope", scope.value);
  if (lifecycle.value !== undefined) query.set("lifecycle", lifecycle.value);
  if (values["archived"] !== undefined) query.set("archived", "true");
  const suffix = query.toString();

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path: suffix === "" ? notesPath() : `${notesPath()}?${suffix}`,
    headers: callerHeaders(context),
  });
  if (result.kind !== "ok") return failureFromRequest(result, json);

  const parsed = noteListResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return invalidResponseFailure({
      what: "the memory list",
      issues: parsed.error.issues,
      json,
    });
  }
  const notes = parsed.data.notes;
  const bounded = boundedItems(
    notes,
    limit.value ?? MEMORY_LIST_LIMIT,
    revealCommand("cctl memory list", values, notes.length),
  );

  return {
    exitCode: EXIT_OK,
    stdout: render(
      json,
      `${[
        `notes: ${omissionSummary(bounded.omission)}`,
        ...bounded.items.map(listRow),
      ].join("\n")}\n`,
      {
        ok: true,
        notes: bounded.items,
        ...bounded.omission,
        hint: LIST_HINT,
      },
    ),
    stderr: "",
  };
}

/** The command that reveals the rows a cap dropped, spelled as it was invoked. */
function revealCommand(
  base: string,
  values: Record<string, string>,
  total: number,
): string {
  const parts = [base];
  for (const name of ["scope", "lifecycle"]) {
    const value = values[name];
    if (value !== undefined) parts.push(`--${name} ${value}`);
  }
  for (const name of ["archived", "promotable"]) {
    if (values[name] !== undefined) parts.push(`--${name}`);
  }
  parts.push(`--limit ${total}`);
  return parts.join(" ");
}

async function runGet(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "memory get", json);
  if (denied) return denied;
  const handle = handleArgument(rest, "get", json);
  if (!handle.ok) return handle.result;
  const scope = enumFlag(
    values,
    "scope",
    memoryScopeSchema,
    "memory get",
    json,
  );
  if (!scope.ok) return scope.result;

  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const query = new URLSearchParams();
  if (scope.value !== undefined) query.set("scope", scope.value);
  if (values["archived"] !== undefined) query.set("archived", "true");
  const suffix = query.toString();

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path:
      suffix === ""
        ? notesPath(handle.value)
        : `${notesPath(handle.value)}?${suffix}`,
    headers: callerHeaders(context),
  });
  if (result.kind !== "ok") {
    return memoryFailure(result, json, { verb: "get" });
  }

  const parsed = noteDetailResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return invalidResponseFailure({
      what: "memory get",
      issues: parsed.error.issues,
      json,
    });
  }
  const { note, links, lineage } = parsed.data;
  const now = new Date().toISOString();

  const lines = [
    ...detailLines(note, now),
    ...lineageLines(lineage),
    ...(links.length === 0 ? [] : ["links:", ...links.map(linkRow)]),
    ...(note.body === "" ? [] : ["", note.body]),
  ];

  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${lines.join("\n")}\n`, {
      ok: true,
      note,
      links,
      lineage,
    }),
    stderr: "",
  };
}

// ---------------------------------------------------------------------------
// Capture verbs
// ---------------------------------------------------------------------------

async function runCreate(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  lists: Record<string, string[]>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "memory create", json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure(
      "memory create takes no positional arguments — pass --hook",
      json,
    );
  }

  const hook = await resolveProseArg(values, host, "hook", json);
  if (!hook.ok) return hook.result;
  if (hook.value === undefined || hook.value.trim() === "") {
    return usageFailure(
      "memory create requires --hook — one dense line stating the fact a future conversation needs",
      json,
    );
  }
  const bodyText = await resolveProseArg(values, host, "body", json);
  if (!bodyText.ok) return bodyText.result;
  const statusNote = await resolveProseArg(values, host, "status-note", json);
  if (!statusNote.ok) return statusNote.result;

  const scope = enumFlag(
    values,
    "scope",
    memoryScopeSchema,
    "memory create",
    json,
  );
  if (!scope.ok) return scope.result;
  const kind = enumFlag(
    values,
    "kind",
    memoryKindSchema,
    "memory create",
    json,
  );
  if (!kind.ok) return kind.result;
  const indexMode = enumFlag(
    values,
    "index-mode",
    memoryIndexModeSchema,
    "memory create",
    json,
  );
  if (!indexMode.ok) return indexMode.result;

  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: notesPath(),
    headers: callerHeaders(context),
    body: {
      scope: scope.value ?? "project",
      kind: kind.value ?? "lesson",
      hook: hook.value,
      ...(bodyText.value !== undefined ? { body: bodyText.value } : {}),
      ...(values["slug"] !== undefined ? { slug: values["slug"] } : {}),
      ...(lists["alias"] !== undefined ? { aliases: lists["alias"] } : {}),
      ...(statusNote.value !== undefined
        ? { statusNote: nullableProse(statusNote.value) }
        : {}),
      ...(indexMode.value !== undefined ? { indexMode: indexMode.value } : {}),
      ...(values["review-after"] !== undefined
        ? { reviewAfter: nullableFlag(values, "review-after") }
        : {}),
      ...(values["expires-at"] !== undefined
        ? { expiresAt: nullableFlag(values, "expires-at") }
        : {}),
      ...(values["supersedes"] !== undefined
        ? { supersedes: values["supersedes"] }
        : {}),
    },
  });
  if (result.kind !== "ok") return failureFromRequest(result, json);

  const parsed = createResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return invalidResponseFailure({
      what: "memory create",
      issues: parsed.error.issues,
      json,
    });
  }
  const { note, advisories } = parsed.data;
  const now = new Date().toISOString();

  // Advisories are output, never a refusal: the note is already written. The
  // spec's frictionless-capture principle is that an overlap or a weak hook is
  // something to tell the author about, not a reason to lose the capture.
  const advisoryLines = [
    ...advisories.hookWarnings.map((warning) => `  hook: ${warning.message}`),
    ...advisories.overlapCandidates.map(
      (candidate) =>
        `  overlaps: ${candidate.slug} [${candidate.scope}] ${candidate.hook}`,
    ),
  ];

  return {
    exitCode: EXIT_OK,
    stdout: render(
      json,
      `${[
        ...detailLines(note, now),
        ...(advisoryLines.length === 0
          ? []
          : ["advisories:", ...advisoryLines]),
      ].join("\n")}\n`,
      {
        ok: true,
        note,
        advisories,
        ...(note.lifecycle === "proposed"
          ? {
              hint: "a global note lands as a proposal and reaches no conversation until a human approves it in the Memory Library",
            }
          : {}),
      },
    ),
    stderr: "",
  };
}

async function runUpdate(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  lists: Record<string, string[]>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "memory update", json);
  if (denied) return denied;
  const handle = handleArgument(rest, "update", json);
  if (!handle.ok) return handle.result;

  const ifRevision = positiveIntFlag(
    values,
    "if-revision",
    "memory update",
    json,
  );
  if (!ifRevision.ok) return ifRevision.result;
  if (ifRevision.value === undefined) {
    return usageFailure(
      `memory update requires --if-revision <n> — read the current revision with 'cctl memory get ${SLUG_PLACEHOLDER}'`,
      json,
    );
  }

  const hook = await resolveProseArg(values, host, "hook", json);
  if (!hook.ok) return hook.result;
  const bodyText = await resolveProseArg(values, host, "body", json);
  if (!bodyText.ok) return bodyText.result;
  const statusNote = await resolveProseArg(values, host, "status-note", json);
  if (!statusNote.ok) return statusNote.result;

  const indexMode = enumFlag(
    values,
    "index-mode",
    memoryIndexModeSchema,
    "memory update",
    json,
  );
  if (!indexMode.ok) return indexMode.result;
  const scope = enumFlag(
    values,
    "scope",
    memoryScopeSchema,
    "memory update",
    json,
  );
  if (!scope.ok) return scope.result;

  const patch = {
    baseRevision: ifRevision.value,
    ...(hook.value !== undefined ? { hook: hook.value } : {}),
    ...(bodyText.value !== undefined ? { body: bodyText.value } : {}),
    ...(values["slug"] !== undefined ? { slug: values["slug"] } : {}),
    ...(lists["alias"] !== undefined ? { aliases: lists["alias"] } : {}),
    ...(statusNote.value !== undefined
      ? { statusNote: nullableProse(statusNote.value) }
      : {}),
    ...(indexMode.value !== undefined ? { indexMode: indexMode.value } : {}),
    ...(values["review-after"] !== undefined
      ? { reviewAfter: nullableFlag(values, "review-after") }
      : {}),
    ...(values["expires-at"] !== undefined
      ? { expiresAt: nullableFlag(values, "expires-at") }
      : {}),
  };
  if (Object.keys(patch).length === 1) {
    return usageFailure(
      "memory update changes nothing — pass at least one of --hook, --body, --slug, --alias, --status-note, --index-mode, --review-after, --expires-at",
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
    method: "PATCH",
    path: `${notesPath(handle.value)}${scopeQuery(scope.value)}`,
    headers: callerHeaders(context),
    body: patch,
  });
  if (result.kind !== "ok") {
    return memoryFailure(result, json, { verb: "update" });
  }

  return noteResult(result.body, "memory update", json);
}

/** The shared success arm of every verb that answers with one note. */
function noteResult(
  responseBody: unknown,
  what: string,
  json: boolean,
  /** Extra envelope fields, composed from the note the server answered with. */
  extra: (note: MemoryNote) => Record<string, unknown> = () => ({}),
): CliResult {
  const parsed = noteResponseSchema.safeParse(responseBody);
  if (!parsed.success) {
    return invalidResponseFailure({
      what,
      issues: parsed.error.issues,
      json,
    });
  }
  const note = parsed.data.note;
  const now = new Date().toISOString();
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${detailLines(note, now).join("\n")}\n`, {
      ok: true,
      note,
      ...extra(note),
    }),
    stderr: "",
  };
}

// ---------------------------------------------------------------------------
// Link verbs
// ---------------------------------------------------------------------------

async function runLinkVerb(
  verb: "link" | "unlink",
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const command = `memory ${verb}`;
  const denied = checkFlags(values, command, json);
  if (denied) return denied;
  const handle = handleArgument(rest, verb, json);
  if (!handle.ok) return handle.result;

  const artifact = values["artifact"];
  if (artifact === undefined || artifact.trim() === "") {
    return usageFailure(
      `${command} requires --artifact <handle> — ticket:<number>, ticket:<project>#<number> or ticket:<id>, spec:<id>, execution:<id>, context:<executionId>/<contextId>, or session:<name>@<createdAt>`,
      json,
    );
  }
  const kind = enumFlag(values, "kind", memoryLinkKindSchema, command, json);
  if (!kind.ok) return kind.result;

  const linkKind = kind.value ?? "about";

  const scope = enumFlag(values, "scope", memoryScopeSchema, command, json);
  if (!scope.ok) return scope.result;

  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: verb === "link" ? "POST" : "DELETE",
    path: `${notesPath(handle.value, "links")}${scopeQuery(scope.value)}`,
    headers: callerHeaders(context),
    body: { kind: linkKind, artifact },
  });
  if (result.kind !== "ok") {
    return memoryFailure(result, json, { verb });
  }

  const parsed = linkResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return invalidResponseFailure({
      what: command,
      issues: parsed.error.issues,
      json,
    });
  }
  const { link, note } = parsed.data;
  const verbed = verb === "link" ? "linked" : "unlinked";

  return {
    exitCode: EXIT_OK,
    stdout: render(
      json,
      // The note's own slug, not the handle that addressed it: an id or an
      // alias resolves here, and only the slug may be printed.
      `${note.slug}  ${verbed}  ${link.kind}: ${artifactLabel(link)}\n`,
      { ok: true, link, note },
    ),
    stderr: "",
  };
}

// ---------------------------------------------------------------------------
// Maintenance verbs
// ---------------------------------------------------------------------------

async function runMarkReviewed(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "memory mark-reviewed", json);
  if (denied) return denied;
  const handle = handleArgument(rest, "mark-reviewed", json);
  if (!handle.ok) return handle.result;
  const scope = enumFlag(
    values,
    "scope",
    memoryScopeSchema,
    "memory mark-reviewed",
    json,
  );
  if (!scope.ok) return scope.result;
  const ifRevision = positiveIntFlag(
    values,
    "if-revision",
    "memory mark-reviewed",
    json,
  );
  if (!ifRevision.ok) return ifRevision.result;

  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${notesPath(handle.value, "reviewed")}${scopeQuery(scope.value)}`,
    headers: callerHeaders(context),
    body: {
      target: values["status"] !== undefined ? "statusNote" : "note",
      ...(ifRevision.value !== undefined
        ? { baseRevision: ifRevision.value }
        : {}),
    },
  });
  if (result.kind !== "ok") {
    return memoryFailure(result, json, { verb: "mark-reviewed" });
  }

  const parsed = reviewedResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return invalidResponseFailure({
      what: "memory mark-reviewed",
      issues: parsed.error.issues,
      json,
    });
  }
  const { note, statusReLease } = parsed.data;
  const now = new Date().toISOString();

  // A status re-lease asserts "this is still true" about a line that primes
  // every conversation again the moment it holds, so the act states the claim,
  // how old it is, and how long the re-lease buys — the note detail alone
  // leaves the operator to go find what they just re-asserted (R2.2, D8).
  const lines =
    statusReLease === null
      ? detailLines(note, now)
      : [
          `re-asserted: ${renderMemoryStatusLine(statusReLease, now)}`,
          `status-review-after: ${statusReLease.reviewAfter}`,
          ...detailLines(note, now),
        ];

  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${lines.join("\n")}\n`, {
      ok: true,
      note,
      statusReLease,
    }),
    stderr: "",
  };
}

/**
 * Spec R15's validator re-derivation observation. The judgement — this round
 * re-established something a note it already had said — belongs to whoever read
 * the round, so this is where it enters the record: the counter it raises and
 * the `memory.telemetry.validator_rederivation` event the server logs are what
 * the evidence-gated default "validators receive no memory" is revisited from.
 *
 * It is not a mutation verb. No revision moves, no `--if-revision` applies, and
 * the contribution policy that refuses a validator's notes does not refuse
 * this: a validator that could not report its own wasted round would leave the
 * question unanswerable.
 */
async function runObserveRederivation(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "memory observe-rederivation", json);
  if (denied) return denied;
  const handle = handleArgument(rest, "observe-rederivation", json);
  if (!handle.ok) return handle.result;
  const scope = enumFlag(
    values,
    "scope",
    memoryScopeSchema,
    "memory observe-rederivation",
    json,
  );
  if (!scope.ok) return scope.result;

  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const artifact = values["artifact"];
  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${notesPath(handle.value, "rederived")}${scopeQuery(scope.value)}`,
    headers: callerHeaders(context),
    body: artifact === undefined ? {} : { artifact },
  });
  if (result.kind !== "ok") {
    return memoryFailure(result, json, { verb: "observe-rederivation" });
  }

  const parsed = rederivedResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return invalidResponseFailure({
      what: "memory observe-rederivation",
      issues: parsed.error.issues,
      json,
    });
  }
  const { observed } = parsed.data;
  const round =
    observed.executionId === null
      ? "an unnamed round"
      : observed.contextId === null
        ? `execution:${observed.executionId}`
        : `context:${observed.executionId}/${observed.contextId}`;

  return {
    exitCode: EXIT_OK,
    stdout: render(
      json,
      `recorded: ${observed.slug} was re-derived in ${round}\n`,
      { ok: true, observed },
    ),
    stderr: "",
  };
}

async function runPromote(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "memory promote", json);
  if (denied) return denied;
  const handle = handleArgument(rest, "promote", json);
  if (!handle.ok) return handle.result;

  const hook = await resolveProseArg(values, host, "hook", json);
  if (!hook.ok) return hook.result;
  const bodyText = await resolveProseArg(values, host, "body", json);
  if (!bodyText.ok) return bodyText.result;
  const statusNote = await resolveProseArg(values, host, "status-note", json);
  if (!statusNote.ok) return statusNote.result;
  const indexMode = enumFlag(
    values,
    "index-mode",
    memoryIndexModeSchema,
    "memory promote",
    json,
  );
  if (!indexMode.ok) return indexMode.result;
  const ifRevision = positiveIntFlag(
    values,
    "if-revision",
    "memory promote",
    json,
  );
  if (!ifRevision.ok) return ifRevision.result;

  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: notesPath(handle.value, "promote"),
    headers: callerHeaders(context),
    body: {
      ...(values["slug"] !== undefined ? { slug: values["slug"] } : {}),
      ...(hook.value !== undefined ? { hook: hook.value } : {}),
      ...(bodyText.value !== undefined ? { body: bodyText.value } : {}),
      ...(statusNote.value !== undefined
        ? { statusNote: nullableProse(statusNote.value) }
        : {}),
      ...(indexMode.value !== undefined ? { indexMode: indexMode.value } : {}),
      ...(ifRevision.value !== undefined
        ? { baseRevision: ifRevision.value }
        : {}),
    },
  });
  if (result.kind !== "ok") {
    return memoryFailure(result, json, { verb: "promote" });
  }

  const parsed = promoteResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return invalidResponseFailure({
      what: "memory promote",
      issues: parsed.error.issues,
      json,
    });
  }
  const { promoted, superseded } = parsed.data;
  const now = new Date().toISOString();

  return {
    exitCode: EXIT_OK,
    stdout: render(
      json,
      `${[
        ...detailLines(promoted, now),
        `superseded: ${superseded.slug} [${scopeLabel(superseded)}]`,
      ].join("\n")}\n`,
      { ok: true, promoted, superseded },
    ),
    stderr: "",
  };
}

async function runReview(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "memory review", json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure("memory review takes no arguments", json);
  }
  const limit = positiveIntFlag(values, "limit", "memory review", json);
  if (!limit.ok) return limit.result;

  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const query = new URLSearchParams();
  if (values["promotable"] !== undefined) {
    query.set("promotionCandidates", "true");
  }
  const suffix = query.toString();

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path: suffix === "" ? "/api/memory/review" : `/api/memory/review?${suffix}`,
    headers: callerHeaders(context),
  });
  if (result.kind !== "ok") return failureFromRequest(result, json);

  const parsed = reviewQueueResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return invalidResponseFailure({
      what: "the memory review queue",
      issues: parsed.error.issues,
      json,
    });
  }
  const entries = parsed.data.entries;
  const bounded = boundedItems(
    entries,
    limit.value ?? MEMORY_LIST_LIMIT,
    revealCommand("cctl memory review", values, entries.length),
  );

  return {
    exitCode: EXIT_OK,
    stdout: render(
      json,
      `${[
        `review queue: ${omissionSummary(bounded.omission)}`,
        ...bounded.items.map(reviewRow),
      ].join("\n")}\n`,
      { ok: true, entries: bounded.items, ...bounded.omission },
    ),
    stderr: "",
  };
}

async function runArchive(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "memory archive", json);
  if (denied) return denied;
  const handle = handleArgument(rest, "archive", json);
  if (!handle.ok) return handle.result;
  const scope = enumFlag(
    values,
    "scope",
    memoryScopeSchema,
    "memory archive",
    json,
  );
  if (!scope.ok) return scope.result;
  const ifRevision = positiveIntFlag(
    values,
    "if-revision",
    "memory archive",
    json,
  );
  if (!ifRevision.ok) return ifRevision.result;

  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${notesPath(handle.value, "archive")}${scopeQuery(scope.value)}`,
    headers: callerHeaders(context),
    body:
      ifRevision.value === undefined ? {} : { baseRevision: ifRevision.value },
  });
  if (result.kind !== "ok") {
    return memoryFailure(result, json, { verb: "archive" });
  }

  return noteResult(result.body, "memory archive", json, (note) => ({
    hint: `read it again with 'cctl memory get ${note.slug} --archived'`,
  }));
}

async function runDelete(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "memory delete", json);
  if (denied) return denied;
  const handle = handleArgument(rest, "delete", json);
  if (!handle.ok) return handle.result;

  // The confirmation is a local check with no request behind it: a permanent
  // delete an agent did not mean to run must fail before the server sees it.
  if (values["confirm"] === undefined) {
    return usageFailure(
      `memory delete permanently destroys the note and its whole history — pass --confirm, or archive it instead with 'cctl memory archive ${SLUG_PLACEHOLDER}'`,
      json,
    );
  }
  const scope = enumFlag(
    values,
    "scope",
    memoryScopeSchema,
    "memory delete",
    json,
  );
  if (!scope.ok) return scope.result;

  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "DELETE",
    path: `${notesPath(handle.value)}${scopeQuery(scope.value)}`,
    headers: callerHeaders(context),
  });
  if (result.kind !== "ok") {
    return memoryFailure(result, json, { verb: "delete" });
  }

  const parsed = noteResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return invalidResponseFailure({
      what: "memory delete",
      issues: parsed.error.issues,
      json,
    });
  }
  const note = parsed.data.note;

  return {
    exitCode: EXIT_OK,
    stdout: render(
      json,
      `${note.slug}  deleted permanently  [${scopeLabel(note)}]\n`,
      { ok: true, note },
    ),
    stderr: "",
  };
}

async function runExport(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "memory export", json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure(
      "memory export takes no positional arguments — pass --output <path>",
      json,
    );
  }
  const output = values["output"];
  if (output === undefined || output.trim() === "") {
    return usageFailure("memory export requires --output <path>", json);
  }
  const scope = enumFlag(
    values,
    "scope",
    memoryScopeSchema,
    "memory export",
    json,
  );
  if (!scope.ok) return scope.result;

  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const query = scope.value === undefined ? "" : `?scope=${scope.value}`;
  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path: `/api/memory/export${query}`,
    headers: callerHeaders(context),
  });
  if (result.kind !== "ok") return failureFromRequest(result, json);

  const parsed = exportResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return invalidResponseFailure({
      what: "the memory export",
      issues: parsed.error.issues,
      json,
    });
  }
  const { archive, noteCount, generatedAt } = parsed.data;

  const write = host.writeTextFile;
  if (write === undefined) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: "memory export: this CLI host cannot write files",
      code: "write_unavailable",
      json,
    });
  }
  try {
    await write(output, archive);
  } catch {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: `memory export: could not write ${JSON.stringify(output)}`,
      code: "write_failed",
      json,
    });
  }

  return {
    exitCode: EXIT_OK,
    stdout: render(
      json,
      `${[
        `archive: ${output}`,
        `notes: ${noteCount}`,
        `generated: ${generatedAt}`,
      ].join("\n")}\n`,
      {
        ok: true,
        path: output,
        noteCount,
        generatedAt,
        bytes: Buffer.byteLength(archive, "utf8"),
        hint: "revision history is excluded by design — it stays in the database",
      },
    ),
    stderr: "",
  };
}
