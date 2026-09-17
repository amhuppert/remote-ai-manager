import {
  mutation,
  recoveryFacts,
  writeRunner,
  type MutationHandler,
} from "cli-for-agents";
import { instruction } from "cli-for-agents/guidance";
import { z } from "zod";
import {
  proposeDecisionsRequestSchema,
  submitCharterRequestSchema,
  type ProposeDecisionsRequest,
} from "@/lib/session-alignment/schemas";
import {
  cliRequest,
  encodePathSegment,
  type ConversationContext,
} from "../../transport";
import {
  resolveCcConversation,
  type CcErrorCode,
} from "../../framework/context";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import { ccWriteFailure } from "../../framework/request";
import type { charterWriteSpec, decisionsProposeSpec } from "./definitions";

const decisionsResponseSchema = z.object({
  batchId: z.string().min(1),
  count: z.number().int().nonnegative(),
});
const charterResponseSchema = z.object({
  status: z.enum(["draft_ready", "activated"]),
  version: z.number().int().nullable(),
});
const charterPayloadSchema = submitCharterRequestSchema.omit({
  conversationId: true,
});
type DecisionsHandler = MutationHandler<
  typeof decisionsProposeSpec,
  CcApplication,
  ConversationContext,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags,
  ProposeDecisionsRequest
>;
type CharterHandler = MutationHandler<
  typeof charterWriteSpec,
  CcApplication,
  ConversationContext,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags,
  z.infer<typeof charterPayloadSchema>
>;

function alignmentPath(context: ConversationContext): string {
  return `/api/projects/${encodePathSegment(context.project)}/sessions/${encodePathSegment(context.session)}/alignment`;
}

const decisions: DecisionsHandler = {
  decode: proposeDecisionsRequestSchema,
  prepare: ({ app }) => resolveCcConversation(app),
  commit: writeRunner<
    Parameters<DecisionsHandler["commit"]>[0],
    z.infer<typeof decisionsResponseSchema>,
    CcErrorCode
  >({
    async run({ app, payload, prepared }) {
      const context = prepared.value;
      const recovery = recoveryFacts([
        { kind: "session", id: context.session },
      ]);
      const response = await cliRequest(app.host, {
        ...context,
        method: "POST",
        path: `${alignmentPath(context)}/decisions`,
        body: { ...payload, conversationId: context.conversation },
      });
      if (response.kind !== "ok") return ccWriteFailure(response, recovery);
      const parsed = decisionsResponseSchema.safeParse(response.body);
      if (!parsed.success)
        return {
          effect: "unknown",
          recovery,
          result: {
            ok: false,
            error: ccErrors.error("CC_INVALID_RESPONSE", {
              message:
                "The decision endpoint did not return a batch receipt; inspect the session before retrying.",
            }),
          },
        };
      return {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "decision-batch", id: parsed.data.batchId },
        ]),
        result: {
          ok: true,
          data: parsed.data,
          instruction: instruction(
            "cc-decision-review",
            "Decision review is pending. Write a brief handoff note, then end your turn now; do not start new work. The complete decision review result will arrive as the next user message.",
          ),
        },
      };
    },
    text: ({ count }) =>
      `proposed ${count} decision${count === 1 ? "" : "s"} for the user's review\n`,
  }),
};

const charter: CharterHandler = {
  decode: charterPayloadSchema,
  prepare: ({ app }) => resolveCcConversation(app),
  commit: writeRunner<
    Parameters<CharterHandler["commit"]>[0],
    z.infer<typeof charterResponseSchema>,
    CcErrorCode
  >({
    async run({ app, payload, prepared }) {
      const context = prepared.value;
      const recovery = recoveryFacts([
        { kind: "session", id: context.session },
      ]);
      const response = await cliRequest(app.host, {
        ...context,
        method: "POST",
        path: `${alignmentPath(context)}/charter`,
        body: { ...payload, conversationId: context.conversation },
      });
      if (response.kind !== "ok") return ccWriteFailure(response, recovery);
      const parsed = charterResponseSchema.safeParse(response.body);
      if (!parsed.success)
        return {
          effect: "unknown",
          recovery,
          result: {
            ok: false,
            error: ccErrors.error("CC_INVALID_RESPONSE", {
              message:
                "The charter endpoint did not return its activation status; inspect the session before retrying.",
            }),
          },
        };
      return {
        effect: "applied",
        recovery,
        result: { ok: true, data: parsed.data },
      };
    },
    text: ({ status, version }) =>
      status === "activated"
        ? `charter activated as version ${version}\n`
        : "charter draft submitted; pending the user's approval\n",
  }),
};

export const decisionsHandler = mutation(decisions);
export const charterHandler = mutation(charter);
