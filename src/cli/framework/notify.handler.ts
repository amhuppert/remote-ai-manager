import { recoveryFacts, writeRunner } from "cli-for-agents";
import type { HandlerInput, WriteHandler } from "cli-for-agents";
import {
  conversationTargetApiBase,
  projectConversationTarget,
} from "@/lib/conversations/conversation-target";
import {
  cliRequest,
  encodePathSegment,
  readConversationScope,
  readSessionEnv,
} from "../transport";
import {
  resolveCcProject,
  type CcErrorCode,
  sessionReference,
} from "./context";
import { ccErrors, type CcApplication, type ccGlobalFlags } from "./family";
import type { notifySpec } from "./notify.definition";
import { ccWriteFailure } from "./request";

type Input = HandlerInput<
  typeof notifySpec,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;

const handler: WriteHandler<
  typeof notifySpec,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
> = {
  run: writeRunner<Input, { notified: boolean }, CcErrorCode>({
    async run({ app, ctx }) {
      const project = await resolveCcProject(app);
      if (!project.ok) {
        return {
          effect: "not_applied",
          result: { ok: false, error: project.error },
        };
      }
      const session = app.globals.session ?? readSessionEnv(app.env);
      const conversation =
        app.globals.conversation ?? app.env["CC_CONVERSATION_ID"];
      let target: { path: string; kind: string; id: string };
      if (session) {
        target = {
          path: `/api/projects/${encodePathSegment(project.value.project)}/sessions/${encodePathSegment(session)}/notifications`,
          ...sessionReference(session),
        };
      } else if (readConversationScope(app.env) === "project" && conversation) {
        target = {
          path: `${conversationTargetApiBase(projectConversationTarget(project.value.project, conversation))}/notifications`,
          kind: "conversation",
          id: conversation,
        };
      } else {
        return {
          effect: "not_applied",
          result: {
            ok: false,
            error: ccErrors.error("CC_USAGE", {
              message:
                readConversationScope(app.env) === "project"
                  ? "no conversation — pass --conversation or set CC_CONVERSATION_ID"
                  : "no session — pass --session or set CC_SESSION",
            }),
          },
        };
      }
      const response = await cliRequest(app.host, {
        ...project.value,
        method: "POST",
        path: target.path,
        body: {
          message: ctx.args.message,
          ...(ctx.flags.title === undefined ? {} : { title: ctx.flags.title }),
        },
      });
      const recovery = recoveryFacts([{ kind: target.kind, id: target.id }]);
      if (response.kind !== "ok") return ccWriteFailure(response, recovery);
      return {
        effect: "applied",
        recovery,
        result: { ok: true, data: { notified: true } },
      };
    },
    text: () => "notification sent\n",
  }),
};

export default handler;
