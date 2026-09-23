import { quoteLiteralText } from "../../framework/literal-text";
import {
  invocation,
  mutation,
  recoveryFacts,
  runner,
  writeRunner,
} from "cli-for-agents";
import { hint, instruction } from "cli-for-agents/guidance";
import { z } from "zod";
import { resolveCcLane, type CcErrorCode } from "../../framework/context";
import { encodePathSegment, type LaneContext } from "../../transport";
import type * as specs from "./definitions";
import { inputsCommand } from "./definitions";
import {
  collabResponseSchema,
  completeResponseSchema,
  expandResponseSchema,
  inputsResponseSchema,
  sharedDocFileSchema,
} from "./schemas";
import {
  graphPath,
  lanePath,
  principal,
  readResponse,
  writeResponse,
  okSchema,
  type Input,
  type JsonObject,
  type Read,
  type Write,
  type Mutation,
} from "./shared";

export const taskCompleteHandler: Write<typeof specs.taskCompleteSpec> = {
  run: writeRunner<
    Input<typeof specs.taskCompleteSpec>,
    z.infer<typeof completeResponseSchema> & { taskId: string },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcLane(app);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const context = resolved.value;
      const taskId = ctx.args["task-id"];
      const response = await writeResponse(
        app,
        {
          ...context,
          ...principal(app),
          method: "POST",
          path: `${lanePath(context)}/tasks/${encodePathSegment(taskId)}/complete`,
          body: {
            executionId: context.executionId,
            summary: ctx.flags.summary,
          },
        },
        completeResponseSchema,
        recoveryFacts([
          { kind: "workflow-execution", id: context.executionId },
          { kind: "workflow-task", id: taskId },
        ]),
        true,
      );
      if (response.effect !== "applied") return response;
      const data = { ...response.result.data, taskId };
      return {
        ...response,
        result: {
          ok: true,
          data,
        },
      };
    },
    text: (data) =>
      quoteLiteralText(
        `Completed ${data.taskId}. ${data.remainingTaskCount} task${data.remainingTaskCount === 1 ? "" : "s"} remain in this context.\n`,
      ),
  }),
};
export const taskAddHandler: Write<typeof specs.taskAddSpec> = {
  run: writeRunner<
    Input<typeof specs.taskAddSpec>,
    { title: string; executionId: string; contextId: string },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcLane(app);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const context = resolved.value;
      const response = await writeResponse(
        app,
        {
          ...context,
          ...principal(app),
          method: "POST",
          path: `${lanePath(context)}/tasks`,
          body: {
            executionId: context.executionId,
            title: ctx.flags.title,
            instructions: ctx.flags.instructions,
            ...(ctx.flags.slug ? { slug: ctx.flags.slug } : {}),
          },
        },
        okSchema,
        recoveryFacts([
          { kind: "workflow-execution", id: context.executionId },
          { kind: "workflow-context", id: context.contextId },
        ]),
        true,
      );
      if (response.effect !== "applied") return response;
      return {
        ...response,
        result: {
          ok: true,
          data: {
            title: ctx.flags.title,
            executionId: context.executionId,
            contextId: context.contextId,
          },
        },
      };
    },
    text: ({ title }) => quoteLiteralText(`Added task: ${title}\n`),
  }),
};
const expansionPayloadSchema = z
  .object({ contexts: z.array(z.json()), tasks: z.array(z.json()) })
  .catchall(z.json());
type Expand = Mutation<
  typeof specs.graphExpandSpec,
  LaneContext,
  z.infer<typeof expansionPayloadSchema>
>;
const graphExpandImplementation: Expand = {
  decode: expansionPayloadSchema,
  prepare: ({ app }) => resolveCcLane(app),
  commit: writeRunner<
    Parameters<Expand["commit"]>[0],
    z.infer<typeof expandResponseSchema>,
    CcErrorCode
  >({
    async run({ app, payload, prepared }) {
      const context = prepared.value;
      return writeResponse(
        app,
        {
          ...context,
          ...principal(app),
          method: "POST",
          path: `${lanePath(context)}/expand`,
          body: { executionId: context.executionId, request: payload },
        },
        expandResponseSchema,
        recoveryFacts([
          { kind: "workflow-execution", id: context.executionId },
        ]),
        true,
      );
    },
    text: (data) =>
      quoteLiteralText(
        `${data.replayed ? "Replayed an already-applied expansion" : `Expanded the graph: ${data.createdContextIds.length} contexts, ${data.createdTaskIds.length} tasks`}; liveRevision ${data.liveRevision}.\n${data.createdContextIds.join("\n")}\n`,
      ),
  }),
};
export const graphExpandHandler = mutation(graphExpandImplementation);
type SharedDoc = Mutation<
  typeof specs.sharedDocUpsertSpec,
  LaneContext,
  z.infer<typeof sharedDocFileSchema>
>;
const sharedDocUpsertImplementation: SharedDoc = {
  decode: sharedDocFileSchema,
  prepare: ({ app }) => resolveCcLane(app),
  commit: writeRunner<
    Parameters<SharedDoc["commit"]>[0],
    { relativePath: string; executionId: string },
    CcErrorCode
  >({
    async run({ app, ctx, payload, prepared }) {
      const context = prepared.value;
      const relativePath = ctx.args["relative-path"];
      const response = await writeResponse(
        app,
        {
          ...context,
          ...principal(app),
          method: "PUT",
          path: `${graphPath(context)}/shared-documents/${relativePath.split("/").map(encodePathSegment).join("/")}`,
          body: {
            ...payload,
            executionId: context.executionId,
            contextId: context.contextId,
          },
        },
        okSchema,
        recoveryFacts([
          { kind: "workflow-execution", id: context.executionId },
          { kind: "workflow-context", id: context.contextId },
        ]),
        true,
      );
      if (response.effect !== "applied") return response;
      return {
        ...response,
        result: {
          ok: true,
          data: { relativePath, executionId: context.executionId },
        },
      };
    },
    text: ({ relativePath }) =>
      quoteLiteralText(`Registered shared document ${relativePath}.\n`),
  }),
};
export const sharedDocUpsertHandler = mutation(sharedDocUpsertImplementation);
export const collabRequestHandler: Write<typeof specs.collabRequestSpec> = {
  run: writeRunner<
    Input<typeof specs.collabRequestSpec>,
    z.infer<typeof collabResponseSchema>,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcLane(app);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const context = resolved.value;
      const response = await writeResponse(
        app,
        {
          ...context,
          ...principal(app),
          method: "POST",
          path: `${lanePath(context)}/collaboration-requests`,
          body: { executionId: context.executionId, brief: ctx.flags.brief },
        },
        collabResponseSchema,
        recoveryFacts([
          { kind: "workflow-execution", id: context.executionId },
        ]),
        true,
      );
      if (response.effect !== "applied") return response;
      const data = response.result.data;
      return {
        ...response,
        ...(data.workflowId
          ? {
              recovery: recoveryFacts([
                { kind: "collaboration", id: data.workflowId },
              ]),
            }
          : {}),
        result: {
          ok: true,
          data,
          instruction: instruction(
            "cc-workflow-collaboration-handoff",
            "End your turn now and wait for the follow-up that delivers the collaboration outcome.",
          ),
        },
      };
    },
    text: ({ workflowId, status }) =>
      quoteLiteralText(
        `Collaboration ${status}${workflowId ? ` (${workflowId})` : ""}.\n`,
      ),
  }),
};

type UpstreamInput = z.infer<typeof inputsResponseSchema>["inputs"][number];
type InputStatus = "delivered" | "skipped" | "none";
type InputSummaryRow = {
  contextId: string;
  title: string;
  status: InputStatus;
  fields: string[] | null;
  bytes: number | null;
};
type InputsSummaryData = { contextId: string; inputs: InputSummaryRow[] };
type InputsFullData = {
  contextId: string;
  inputs: Array<{
    contextId: string;
    title: string;
    status: InputStatus;
    output: JsonObject | null;
  }>;
};

function inputStatus(input: UpstreamInput): InputStatus {
  if (input.skipped) return "skipped";
  return input.output === null ? "none" : "delivered";
}

async function readLaneInputs(app: Input<typeof specs.inputsSpec>["app"]) {
  const resolved = await resolveCcLane(app);
  if (!resolved.ok) return resolved;
  const context = resolved.value;
  const response = await readResponse(
    app,
    {
      ...context,
      method: "GET",
      path: `${lanePath(context)}/inputs?executionId=${encodeURIComponent(context.executionId)}`,
    },
    inputsResponseSchema,
  );
  if (!response.ok) return response;
  return {
    ok: true as const,
    contextId: context.contextId,
    inputs: response.data.inputs,
  };
}

const inputsSummaryRunner = runner<
  Input<typeof specs.inputsSpec>,
  InputsSummaryData,
  CcErrorCode
>({
  async run({ app }) {
    const read = await readLaneInputs(app);
    if (!read.ok) return read;
    const data: InputsSummaryData = {
      contextId: read.contextId,
      inputs: read.inputs.map((input) => ({
        contextId: input.contextId,
        title: input.title,
        status: inputStatus(input),
        fields: input.schemaFields?.map((field) => field.name) ?? null,
        bytes:
          input.output === null
            ? null
            : new TextEncoder().encode(JSON.stringify(input.output)).byteLength,
      })),
    };
    if (!read.inputs.some((input) => input.output !== null))
      return { ok: true, data };
    return {
      ok: true,
      data,
      hint: hint(
        invocation(inputsCommand, { level: "full" }),
        "Read every payload; add --out <name> to save them as one JSON file",
      ),
    };
  },
  text: (data) =>
    quoteLiteralText(
      data.inputs.length === 0
        ? `${data.contextId} has no upstream inputs.\n`
        : data.inputs
            .map(
              (row) =>
                `${row.contextId}: ${row.title}; ${row.status}${row.fields ? `; fields ${row.fields.join(", ")}` : ""}${row.bytes !== null ? `; ${row.bytes} bytes` : ""}`,
            )
            .join("\n") + "\n",
    ),
});

const inputsFullRunner = runner<
  Input<typeof specs.inputsSpec>,
  InputsFullData,
  CcErrorCode
>({
  async run({ app }) {
    const read = await readLaneInputs(app);
    if (!read.ok) return read;
    return {
      ok: true,
      data: {
        contextId: read.contextId,
        inputs: read.inputs.map((input) => ({
          contextId: input.contextId,
          title: input.title,
          status: inputStatus(input),
          output: input.output,
        })),
      },
    };
  },
  text: (data) => quoteLiteralText(`${JSON.stringify(data.inputs, null, 2)}\n`),
});

export const inputsHandler: Read<typeof specs.inputsSpec> = {
  run: inputsSummaryRunner,
  levels: { full: inputsFullRunner },
};
