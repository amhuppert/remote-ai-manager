import { quoteLiteralText } from "../../framework/literal-text";
import { recoveryFacts, runner, writeRunner } from "cli-for-agents";
import type {
  CommandSpec,
  HandlerInput,
  ReadHandler,
  WriteHandler,
} from "cli-for-agents";
import { z } from "zod";
import {
  referenceDocumentSchema,
  type ReferenceDocument,
} from "@/lib/reference-documents/schemas";
import { cliRequest, encodePathSegment } from "../../transport";
import {
  resolveCcSession,
  type CcErrorCode,
  sessionReference,
} from "../../framework/context";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import { ccRequestFailure, ccWriteFailure } from "../../framework/request";
import type {
  docsDeleteSpec,
  docsListSpec,
  docsRegisterSpec,
} from "./definitions";

type Input<S extends CommandSpec> = HandlerInput<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
type Read<S extends CommandSpec> = ReadHandler<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
type Write<S extends CommandSpec> = WriteHandler<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
const registrationSchema = z.object({ document: referenceDocumentSchema });
const listSchema = z.array(referenceDocumentSchema);

function docsPath(project: string, session: string): string {
  return `/api/projects/${encodePathSegment(project)}/sessions/${encodePathSegment(session)}/reference-documents`;
}

export const registerHandler: Write<typeof docsRegisterSpec> = {
  run: writeRunner<
    Input<typeof docsRegisterSpec>,
    { document: ReferenceDocument },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcSession(app);
      if (!resolved.ok)
        return {
          effect: "not_applied",
          result: { ok: false, error: resolved.error },
        };
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "POST",
        path: docsPath(resolved.value.project, resolved.value.session),
        body: { filePath: ctx.args.path, description: ctx.flags.description },
      });
      if (response.kind !== "ok")
        return ccWriteFailure(
          response,
          recoveryFacts([sessionReference(resolved.value.session)]),
        );
      const parsed = registrationSchema.safeParse(response.body);
      if (!parsed.success) {
        return {
          effect: "unknown",
          recovery: recoveryFacts([sessionReference(resolved.value.session)]),
          result: {
            ok: false,
            error: ccErrors.error("CC_INVALID_RESPONSE", {
              message:
                "The document registration response is invalid; inspect docs list before retrying.",
            }),
          },
        };
      }
      return {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "reference-document", id: parsed.data.document.id },
        ]),
        result: { ok: true, data: parsed.data },
      };
    },
    text: ({ document }) =>
      quoteLiteralText(`registered ${document.id}  ${document.filePath}\n`),
  }),
};

export const listHandler: Read<typeof docsListSpec> = {
  run: runner<
    Input<typeof docsListSpec>,
    { documents: ReferenceDocument[] },
    CcErrorCode
  >({
    async run({ app }) {
      const resolved = await resolveCcSession(app);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: docsPath(resolved.value.project, resolved.value.session),
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = listSchema.safeParse(response.body);
      if (!parsed.success)
        return {
          ok: false,
          error: ccErrors.error("CC_INVALID_RESPONSE", {
            message: "The reference document list response is invalid.",
          }),
        };
      return { ok: true, data: { documents: parsed.data } };
    },
    text: ({ documents }) =>
      quoteLiteralText(
        documents.length === 0
          ? "no reference documents registered\n"
          : `${documents.map((document) => `${document.id}  ${document.filePath}  —  ${document.description}`).join("\n")}\n`,
      ),
  }),
};

export const deleteHandler: Write<typeof docsDeleteSpec> = {
  run: writeRunner<
    Input<typeof docsDeleteSpec>,
    { deletedId: string },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcSession(app);
      if (!resolved.ok)
        return {
          effect: "not_applied",
          result: { ok: false, error: resolved.error },
        };
      const recovery = recoveryFacts([
        { kind: "reference-document", id: ctx.args.id },
      ]);
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "DELETE",
        path: `${docsPath(resolved.value.project, resolved.value.session)}/${encodePathSegment(ctx.args.id)}`,
      });
      if (response.kind !== "ok") return ccWriteFailure(response, recovery);
      return {
        effect: "applied",
        recovery,
        result: { ok: true, data: { deletedId: ctx.args.id } },
      };
    },
    text: ({ deletedId }) => quoteLiteralText(`deleted ${deletedId}\n`),
  }),
};
