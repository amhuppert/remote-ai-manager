import { instruction } from "cli-for-agents/guidance";
import {
  binaryArtifact,
  bytes,
  invocation,
  runner,
  type CommandSpec,
  type HandlerInput,
  type ReadHandler,
  type Omission,
  type JsonData,
} from "cli-for-agents";
import { z } from "zod";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  deliveryDeltaProjectionSchema,
  type DeliveryDeltaProjection,
} from "@/lib/specs/delivery-delta";
import {
  compareCanonicalSpecBundles,
  decodeCanonicalSpecBundle,
} from "@/lib/specs/export";
import {
  canonicalSpecBundleSchema,
  integrityReportSchema,
  specDiffViewSchema,
  type CanonicalSpecBundle,
  type SpecDiffView,
} from "@/lib/specs/view-schemas";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import {
  specDiffCommand,
  specDeltaCommand,
  type specDiffSpec,
  type specDeltaSpec,
  type specExportSpec,
  type specVerifySpec,
} from "./native-definitions";
import { explicitScopeFlags, type CcErrorCode } from "../../framework/context";
import { boundSpecRows } from "./native-disclosure";
import { readSpecJson, specPath } from "./native-request";

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

type DiffData = { diff: SpecDiffView; disclosure?: Omission };
const diffRun = (full: boolean) =>
  runner<Input<typeof specDiffSpec>, DiffData, CcErrorCode>({
    async run({ app, ctx }: Input<typeof specDiffSpec>) {
      if (ctx.flags.from !== undefined && ctx.flags.baseline !== undefined)
        return {
          ok: false,
          error: ccErrors.error("CC_USAGE", {
            message:
              "--from and --baseline name different comparison bases; pass one of them.",
          }),
        } as const;
      const query = new URLSearchParams();
      for (const key of ["from", "to", "baseline"] as const) {
        const value = ctx.flags[key];
        if (value !== undefined) query.set(key, value);
      }
      const response = await readSpecJson(
        app,
        (context) =>
          `${specPath(context.project, ctx.args.slug)}/diff${query.size ? `?${query}` : ""}`,
        specDiffViewSchema,
        ctx.args.slug,
      );
      if (!response.ok) return response;
      if (full) return { ok: true, data: { diff: response.data } } as const;
      const rows = boundSpecRows(
        response.data.elements,
        invocation(specDiffCommand, {
          args: ctx.args,
          flags: { ...explicitScopeFlags(app), ...ctx.flags },
          level: "full",
        }),
      );
      return {
        ok: true,
        data: {
          diff: { ...response.data, elements: rows.items },
          disclosure: rows.omission,
        },
      } as const;
    },
  });
export const diffHandler: Read<typeof specDiffSpec> = {
  run: diffRun(false),
  levels: { full: diffRun(true) },
};

type DeltaData = {
  delta: DeliveryDeltaProjection;
  disclosure?: { elements: Omission; criteria: Omission; advisories: Omission };
};
const deltaRun = (full: boolean) =>
  runner<Input<typeof specDeltaSpec>, DeltaData, CcErrorCode>({
    async run({ app, ctx }: Input<typeof specDeltaSpec>) {
      const query =
        ctx.flags.since === undefined
          ? ""
          : `?${new URLSearchParams({ since: ctx.flags.since })}`;
      const response = await readSpecJson(
        app,
        (context) =>
          `${specPath(context.project, ctx.args.slug)}/delta${query}`,
        deliveryDeltaProjectionSchema,
        ctx.args.slug,
      );
      if (!response.ok) return response;
      if (full) return { ok: true, data: { delta: response.data } } as const;
      const reveal = invocation(specDeltaCommand, {
        args: ctx.args,
        flags: { ...explicitScopeFlags(app), ...ctx.flags },
        level: "full",
      });
      const elements = boundSpecRows(response.data.elements, reveal);
      const criteria = boundSpecRows(response.data.criteria, reveal);
      const advisories = boundSpecRows(response.data.advisories, reveal);
      return {
        ok: true,
        data: {
          delta: {
            ...response.data,
            elements: elements.items,
            criteria: criteria.items,
            advisories: advisories.items,
          },
          disclosure: {
            elements: elements.omission,
            criteria: criteria.omission,
            advisories: advisories.omission,
          },
        },
      } as const;
    },
  });
export const deltaHandler: Read<typeof specDeltaSpec> = {
  run: deltaRun(false),
  levels: { full: deltaRun(true) },
};

const manifestCountsSchema = z.object({
  revisions: z.array(z.object({ elements: z.array(z.unknown()) })),
});
export const exportHandler: Read<typeof specExportSpec> = {
  run: runner({
    async run({ app, ctx }: Input<typeof specExportSpec>) {
      const response = await readSpecJson(
        app,
        (context) => `${specPath(context.project, ctx.args.slug)}/export`,
        canonicalSpecBundleSchema,
        ctx.args.slug,
      );
      if (!response.ok) return response;
      let manifest: unknown;
      try {
        manifest = JSON.parse(response.data.manifest);
      } catch {
        manifest = null;
      }
      const counts = manifestCountsSchema.safeParse(manifest);
      if (!counts.success)
        return {
          ok: false,
          error: ccErrors.error("CC_INVALID_RESPONSE", {
            message:
              "The canonical bundle manifest has an invalid revisions collection.",
          }),
        } as const;
      const summary = {
        revisionCount: counts.data.revisions.length,
        elementCount: counts.data.revisions.reduce(
          (total, revision) => total + revision.elements.length,
          0,
        ),
      };
      if (ctx.flags.stdout)
        return {
          ok: true,
          data: { bundle: response.data, ...summary },
        } as const;
      return {
        ok: true,
        binary: binaryArtifact<typeof summary>({
          bytes: new TextEncoder().encode(
            `${JSON.stringify(response.data, null, 2)}\n`,
          ),
          mediaType: "application/json",
          basename: `${ctx.args.slug}-spec-bundle.json`,
          summary,
        }),
      } as const;
    },
  }),
};

type VerifyData = {
  report: z.infer<typeof integrityReportSchema>;
  against?: string;
};
function verifyText({ report, against }: JsonData<VerifyData>): string {
  return (
    [
      `Checked ${report.checkedRevisionIds.length} revisions; ${report.mismatches.length} integrity mismatches; ${report.consistencyFindings.length} consistency findings.`,
      ...report.mismatches.map(
        (mismatch) =>
          `Revision ${mismatch.revisionId}: ${mismatch.mismatchedElementIds.length ? `payload hash mismatch for ${mismatch.mismatchedElementIds.join(", ")}` : "revision content hash mismatch"}`,
      ),
      ...report.consistencyFindings.flatMap((finding) => [
        `${finding.family} (${finding.code}): ${finding.detail}`,
        `Remedy: ${finding.remedy}`,
      ]),
      ...(against ? [`Compared with ${against}.`] : []),
    ].join("\n") + "\n"
  );
}
export const verifyHandler: Read<typeof specVerifySpec> = {
  run: runner<Input<typeof specVerifySpec>, VerifyData, CcErrorCode>({
    async run({ app, ctx }: Input<typeof specVerifySpec>) {
      let against: CanonicalSpecBundle | undefined;
      if (ctx.flags.against !== undefined) {
        let value: unknown;
        try {
          const content = await ctx.host.files.read(
            ctx.flags.against,
            bytes(32 * 1024 * 1024),
            ctx.signal,
          );
          value = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(content),
          );
        } catch (error) {
          return {
            ok: false,
            error: ccErrors.error("CC_USAGE", {
              message: "Could not read the comparison bundle.",
              details: { cause: getErrorMessage(error) },
            }),
          } as const;
        }
        const decoded = decodeCanonicalSpecBundle(value);
        if (!decoded.ok)
          return {
            ok: false,
            error: ccErrors.error("CC_USAGE", {
              message: decoded.message,
              details: { serverCode: decoded.code, against: ctx.flags.against },
              issues: [
                {
                  code: decoded.code,
                  path: [decoded.issue.path],
                  message: decoded.issue.message,
                },
              ],
            }),
            instruction: instruction(
              "cc-spec-bundle-integrity",
              decoded.instruction,
            ),
          } as const;
        against = decoded.value;
      }
      const response = await readSpecJson(
        app,
        (context) => `${specPath(context.project, ctx.args.slug)}/verify`,
        integrityReportSchema,
        ctx.args.slug,
      );
      if (!response.ok) return response;
      const report = response.data;
      if (!report.ok || report.consistencyFindings.length > 0) {
        const code = report.ok ? "spec_inconsistent" : "integrity_mismatch";
        return {
          ok: false,
          error: ccErrors.error("CC_OPERATION_FAILED", {
            message: report.ok
              ? `Spec ${ctx.args.slug} has unresolved consistency findings.`
              : `Spec ${ctx.args.slug} failed integrity verification.`,
            details: { serverCode: code },
          }),
          data: { report },
          instruction: instruction(
            "cc-spec-integrity",
            report.ok
              ? "Run the remedy named on each finding, then verify again."
              : "Inspect the reported revision mismatch and resolve it in the authoritative spec store, then export a fresh bundle and verify again.",
          ),
        } as const;
      }
      if (against !== undefined) {
        const current = await readSpecJson(
          app,
          (context) => `${specPath(context.project, ctx.args.slug)}/export`,
          canonicalSpecBundleSchema,
          ctx.args.slug,
        );
        if (!current.ok) return current;
        const comparison = compareCanonicalSpecBundles(current.data, against);
        if (!comparison.ok)
          return {
            ok: false,
            error: ccErrors.error("CC_OPERATION_FAILED", {
              message: comparison.message,
              details: {
                serverCode: comparison.code,
                ...(ctx.flags.against === undefined
                  ? {}
                  : { against: ctx.flags.against }),
              },
              issues: [
                {
                  code: comparison.code,
                  path: [comparison.issue.path],
                  message: comparison.issue.message,
                },
              ],
            }),
            data: { report },
            instruction: instruction(
              "cc-spec-comparison",
              comparison.instruction,
            ),
          } as const;
      }
      return {
        ok: true,
        data: {
          report,
          ...(ctx.flags.against === undefined
            ? {}
            : { against: ctx.flags.against }),
        },
      } as const;
    },
    text: verifyText,
  }),
};
