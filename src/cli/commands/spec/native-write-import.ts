import {
  mutation,
  payloadRead,
  recoveryFacts,
  runner,
  writeRunner,
  type MutationHandler,
  type PayloadReadHandler,
} from "cli-for-agents";
import { z } from "zod";
import {
  importBundleSchema,
  specSchema,
  specRevisionSchema,
} from "@/lib/specs/schemas";
import { lintFindingSchema } from "@/lib/specs/view-schemas";
import { draftHealth } from "@/lib/specs/draft-health";
import { cliRequest, encodePathSegment } from "../../transport";
import { ccRequestFailure } from "../../framework/request";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import type { CcErrorCode } from "../../framework/context";
import type * as S from "./native-write-definitions";
import {
  invalidResponse,
  postValue,
  resolveWrite,
  specRecovery,
  statusHint,
  type WriteContext,
} from "./native-write-support";

const countsSchema = z
  .object({
    sections: z.number().int().nonnegative(),
    requirements: z.number().int().nonnegative(),
    criteria: z.number().int().nonnegative(),
    decisions: z.number().int().nonnegative(),
    questions: z.number().int().nonnegative(),
    assumptions: z.number().int().nonnegative(),
  })
  .strict();
const handleSchema = z
  .object({ handle: z.string().min(1), summary: z.string() })
  .strict();
const previewSchema = z
  .object({
    dryRun: z.literal(true),
    preview: z
      .object({
        counts: countsSchema,
        handles: z
          .object({
            requirements: z.array(handleSchema),
            criteria: z.array(handleSchema),
            decisions: z.array(handleSchema),
            questions: z.array(handleSchema),
            assumptions: z.array(handleSchema),
          })
          .strict(),
        findings: z.array(lintFindingSchema),
        blocking: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
const receiptSchema = z
  .object({
    spec: specSchema,
    revision: specRevisionSchema,
    counts: countsSchema,
  })
  .strict();
const writeBundleSchema = importBundleSchema.refine(
  (bundle) => !bundle.dryRun,
  {
    message:
      "Use spec import-preview to rehearse dryRun:true bundles; spec import commits a bundle with dryRun false.",
    path: ["dryRun"],
  },
);
const importPath = (context: WriteContext) =>
  `/api/specs/${encodePathSegment(context.project)}/actions/import`;
async function preview(
  app: CcApplication,
  context: WriteContext,
  bundle: z.infer<typeof importBundleSchema>,
) {
  const backend = app.env["CC_AGENT_BACKEND"];
  const response = await cliRequest(app.host, {
    ...context,
    method: "POST",
    path: importPath(context),
    body: { ...bundle, dryRun: true },
    headers: {
      "x-cc-conversation-id": context.conversation,
      ...(backend ? { "x-cc-agent-backend": backend } : {}),
    },
  });
  if (response.kind !== "ok") return ccRequestFailure(response);
  const parsed = previewSchema.safeParse(response.body);
  return parsed.success
    ? { ok: true as const, value: parsed.data }
    : invalidResponse("import preview");
}

type Preview = PayloadReadHandler<
  typeof S.specImportPreviewSpec,
  CcApplication,
  z.infer<typeof importBundleSchema>,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
const importPreview: Preview = {
  decode: importBundleSchema,
  run: runner<
    Parameters<Preview["run"]>[0],
    z.infer<typeof previewSchema>,
    CcErrorCode
  >({
    async run({ app, payload }) {
      const resolved = await resolveWrite(app, payload.slug);
      if (!resolved.ok) return resolved;
      const response = await preview(app, resolved.value, payload);
      return response.ok ? { ok: true, data: response.value } : response;
    },
  }),
};
export const importPreviewHandler = payloadRead(importPreview);

type Import = MutationHandler<
  typeof S.specImportSpec,
  CcApplication,
  WriteContext,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags,
  z.infer<typeof importBundleSchema>
>;
const importWrite: Import = {
  decode: writeBundleSchema,
  async prepare({ app, payload }) {
    const resolved = await resolveWrite(app, payload.slug);
    if (!resolved.ok) return resolved;
    const response = await preview(app, resolved.value, payload);
    if (!response.ok) return response;
    const blocking = draftHealth(response.value.preview.findings).blocking;
    if (blocking > 0 || response.value.preview.blocking > 0)
      return {
        ok: false,
        error: ccErrors.error("CC_OPERATION_FAILED", {
          message:
            "Import preview has blocking findings; use spec import-preview with this file to inspect and resolve them.",
          details: response.value,
        }),
      };
    return resolved;
  },
  commit: writeRunner<
    Parameters<Import["commit"]>[0],
    z.infer<typeof receiptSchema>,
    CcErrorCode
  >({
    async run({ app, payload, prepared }) {
      const response = await postValue(
        app,
        prepared.value,
        importPath(prepared.value),
        { ...payload, dryRun: false },
        receiptSchema,
        specRecovery(payload.slug),
      );
      return response.ok
        ? {
            effect: "applied",
            recovery: recoveryFacts([
              { kind: "spec", id: response.value.spec.id },
              { kind: "spec-revision", id: response.value.revision.id },
            ]),
            result: {
              ok: true,
              data: response.value,
              hint: statusHint(app, payload.slug),
            },
          }
        : response.report;
    },
  }),
};
export const importHandler = mutation(importWrite);
