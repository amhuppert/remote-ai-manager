import {
  invocation,
  recoveryFacts,
  writeRunner,
  type CommandSpec,
  type CommitReport,
  type Failure,
  type HandlerInput,
  type JsonData,
  type ReportedRecovery,
  type WriteHandler,
} from "cli-for-agents";
import { hint, instruction } from "cli-for-agents/guidance";
import { z } from "zod";
import {
  isWellFormedElementHandle,
  parseElementHandle,
  specSlugSchema,
} from "@/lib/specs/handles";
import {
  specEditContextViewSchema,
  specElementGetResponseSchema,
  type SpecEditContextView,
} from "@/lib/specs/view-schemas";
import {
  cliRequest,
  encodePathSegment,
  type ProjectConversationContext,
} from "../../transport";
import {
  resolveCcProjectConversation,
  explicitScopeFlags,
  type CcErrorCode,
} from "../../framework/context";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import {
  ccRequestFailure,
  ccWriteFailure,
  type CcWriteFailure,
} from "../../framework/request";
import { specGetCommand, specStatusCommand } from "./native-definitions";

export type Input<S extends CommandSpec> = HandlerInput<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
export type Write<S extends CommandSpec> = WriteHandler<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
export type ValueResult<T> =
  | { readonly ok: true; readonly value: T }
  | Failure<never, CcErrorCode>;
export type WriteReply<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly report: CcWriteFailure };
export type WriteContext = ProjectConversationContext;

export function usage(message: string): Failure<never, CcErrorCode> {
  return { ok: false, error: ccErrors.error("CC_USAGE", { message }) };
}
export function refused(message: string): Failure<never, CcErrorCode> {
  return {
    ok: false,
    error: ccErrors.error("CC_OPERATION_FAILED", { message }),
  };
}
export function invalidResponse(what: string): Failure<never, CcErrorCode> {
  return {
    ok: false,
    error: ccErrors.error("CC_INVALID_RESPONSE", {
      message: `The server returned an invalid ${what} response; inspect the spec before retrying.`,
    }),
  };
}
export function specPath(context: WriteContext, slug: string): string {
  return `/api/specs/${encodePathSegment(context.project)}/${encodePathSegment(slug)}`;
}
export function actionPath(
  context: WriteContext,
  slug: string,
  action: string,
): string {
  return `${specPath(context, slug)}/actions/${encodePathSegment(action)}`;
}
export const specRecovery = (id: string) =>
  recoveryFacts([{ kind: "spec", id }]);
export function statusHint(app: CcApplication, slug: string) {
  return hint(
    invocation(specStatusCommand, {
      args: { slug },
      flags: explicitScopeFlags(app),
    }),
    "Read the spec's current state and next actor",
  );
}
export function elementHint(app: CcApplication, slug: string, handle: string) {
  return hint(
    invocation(specGetCommand, {
      args: { target: `${slug}/${handle}` },
      flags: explicitScopeFlags(app),
    }),
    "Read the addressed record and its current version",
  );
}
export const humanInstruction = (text: string) =>
  instruction("cc-spec-review", text);
export function quoteData(value: string): string {
  return value
    .replace(
      /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
    .replace(/\t/g, "  ")
    .split("\n")
    .map((line) => `| ${line}`)
    .join("\n");
}

export async function resolveWrite(
  app: CcApplication,
  slug?: string,
): Promise<ValueResult<WriteContext>> {
  if (slug !== undefined && !specSlugSchema.safeParse(slug).success)
    return usage(`Invalid spec slug ${JSON.stringify(slug)}.`);
  return resolveCcProjectConversation(app);
}

export async function readValue<T>(
  app: CcApplication,
  context: WriteContext,
  path: string,
  schema: z.ZodType<T>,
): Promise<ValueResult<T>> {
  const response = await cliRequest(app.host, {
    ...context,
    method: "GET",
    path,
  });
  if (response.kind !== "ok") return ccRequestFailure(response);
  const parsed = schema.safeParse(response.body);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : invalidResponse("spec read");
}

/** Mutating transport retains acknowledgment uncertainty independently of response decoding. */
export async function postValue<T>(
  app: CcApplication,
  context: WriteContext,
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  recovery: ReportedRecovery,
): Promise<WriteReply<T>> {
  const response = await cliRequest(app.host, {
    ...context,
    method: "POST",
    path,
    body,
    headers: {
      "x-cc-conversation-id": context.conversation,
      ...(app.env["CC_AGENT_BACKEND"]
        ? { "x-cc-agent-backend": app.env["CC_AGENT_BACKEND"] }
        : {}),
    },
  });
  if (response.kind !== "ok")
    return { ok: false, report: ccWriteFailure(response, recovery) };
  const parsed = schema.safeParse(response.body);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        report: {
          effect: "unknown",
          recovery,
          result: invalidResponse("spec mutation"),
        },
      };
}

export function readEditContext(
  app: CcApplication,
  context: WriteContext,
  slug: string,
  element?: string,
) {
  return readValue(
    app,
    context,
    `${specPath(context, slug)}/edit-context${element === undefined ? "" : `?element=${encodeURIComponent(element)}`}`,
    specEditContextViewSchema,
  );
}
export function currentRevision(
  edit: SpecEditContextView,
): ValueResult<string> {
  return edit.currentRevision
    ? { ok: true, value: edit.currentRevision.id }
    : refused(
        "The spec has no current revision; create or open an editable revision before retrying.",
      );
}
export async function writeRevision(
  app: CcApplication,
  context: WriteContext,
  slug: string,
): Promise<ValueResult<string>> {
  const edit = await readEditContext(app, context, slug);
  return edit.ok ? currentRevision(edit.value) : edit;
}

export function bareHandle(
  raw: string,
  slug: string,
  expected: "content" | "question" | "assumption" | "attention",
): ValueResult<string> {
  if (!isWellFormedElementHandle(raw, slug))
    return usage(`Invalid element handle ${JSON.stringify(raw)}.`);
  const parsed = parseElementHandle(raw, slug);
  if (parsed.slug !== slug)
    return usage(`The handle addresses spec ${parsed.slug}, not ${slug}.`);
  const attention = parsed.kind === "question" || parsed.kind === "assumption";
  if (
    (expected === "content" && attention) ||
    (expected === "attention" && !attention) ||
    ((expected === "question" || expected === "assumption") &&
      parsed.kind !== expected)
  )
    return usage(
      `The handle must address ${expected === "content" ? "a requirement, criterion, decision, or task" : expected === "attention" ? "a question or assumption" : `a ${expected}`}.`,
    );
  return {
    ok: true,
    value: raw.includes("/") ? raw.slice(raw.indexOf("/") + 1) : raw,
  };
}

export async function attachment(
  app: CcApplication,
  context: WriteContext,
  slug: string,
  raw?: string,
): Promise<ValueResult<string | null>> {
  if (raw === undefined) return { ok: true, value: null };
  const handle = bareHandle(raw, slug, "content");
  if (!handle.ok) return handle;
  const read = await readValue(
    app,
    context,
    `${specPath(context, slug)}/elements/${encodePathSegment(handle.value)}`,
    specElementGetResponseSchema,
  );
  if (!read.ok) return read;
  return "element" in read.value
    ? { ok: true, value: read.value.element.element.id }
    : refused("The requested handle is not a content element.");
}
export type AttentionTarget = Extract<
  z.infer<typeof specElementGetResponseSchema>,
  { kind: "question" | "assumption" }
>;
export async function attentionTarget(
  app: CcApplication,
  context: WriteContext,
  slug: string,
  raw: string,
  expected: "attention" | "assumption",
): Promise<ValueResult<AttentionTarget>> {
  const handle = bareHandle(raw, slug, expected);
  if (!handle.ok) return handle;
  const read = await readValue(
    app,
    context,
    `${specPath(context, slug)}/elements/${encodePathSegment(handle.value)}`,
    specElementGetResponseSchema,
  );
  if (!read.ok) return read;
  if (
    "kind" in read.value &&
    (read.value.kind === "question" || read.value.kind === "assumption")
  )
    return { ok: true, value: read.value };
  return refused("The requested handle is not an attention record.");
}

export function scalar<S extends CommandSpec, Data>(
  run: (input: Input<S>) => Promise<CommitReport<Data, CcErrorCode>>,
  text?: (data: JsonData<Data>) => string,
): Write<S> {
  return {
    run: writeRunner<Input<S>, Data, CcErrorCode>({
      run,
      ...(text ? { text } : {}),
    }),
  };
}
