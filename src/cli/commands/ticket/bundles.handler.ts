import { explicitScopeFlags } from "../../framework/context";
import {
  binaryArtifact,
  bytes,
  invocation,
  milliseconds,
  recoveryFacts,
  writeRunner,
} from "cli-for-agents";
import type { CommitReport, Failure, ReportedRecovery } from "cli-for-agents";
import { hint } from "cli-for-agents/guidance";
import { z } from "zod";
import {
  bundleTransferSchema,
  type BundleTransfer,
} from "@/lib/tickets/bundle-transfer-schemas";
import { cliRequest, encodePathSegment } from "../../transport";
import { resolveCcProject } from "../../framework/context";
import { ccErrors, type CcApplication } from "../../framework/family";
import { ticketFailure, ticketWriteFailure } from "./target";
import { exportCommand, importCommand, ticketSpecs } from "./definitions";
import {
  identifier,
  invalid,
  resolveTicket,
  ticketPath,
  usage,
  type Input,
  type Write,
  type CcErrorCode,
} from "./target";
import type { TokenSource } from "../../transport";

interface BundleTarget {
  server: string;
  token: string | null;
  tokenSource: TokenSource | null;
  projectName: string;
}
type TransferResult =
  | { ok: true; transfer: BundleTransfer }
  | Failure<never, CcErrorCode>;
const basePath = (target: BundleTarget) =>
  `/api/projects/${encodePathSegment(target.projectName)}/ticket-bundles`;
const transferPath = (target: BundleTarget, id: string) =>
  `${basePath(target)}/${encodePathSegment(id)}`;
const recoveryFor = (transfer: BundleTransfer) =>
  recoveryFacts([{ kind: "ticket-bundle", id: transfer.id }]);
function failed(transfer: BundleTransfer, message: string) {
  return {
    ok: false,
    error: ccErrors.error("CC_OPERATION_FAILED", {
      message,
      details: {
        transferId: transfer.id,
        status: transfer.status,
        digest: transfer.digest,
        omissions: transfer.omissions,
      },
    }),
  } as const;
}
async function readTransfer(
  app: CcApplication,
  target: BundleTarget,
  id: string,
): Promise<TransferResult> {
  const response = await cliRequest(app.host, {
    ...target,
    method: "GET",
    path: transferPath(target, id),
  });
  if (response.kind !== "ok") return ticketFailure(response);
  const parsed = bundleTransferSchema.safeParse(response.body);
  return parsed.success
    ? { ok: true, transfer: parsed.data }
    : invalid("ticket bundle transfer");
}
async function waitForTransfer(
  app: CcApplication,
  ctx:
    | Input<typeof ticketSpecs.import>["ctx"]
    | Input<typeof ticketSpecs.export>["ctx"],
  target: BundleTarget,
  initial: BundleTransfer,
): Promise<TransferResult> {
  let current = initial;
  for (
    let attempt = 0;
    attempt < 600 &&
    (current.status === "preparing" || current.status === "importing");
    attempt++
  ) {
    try {
      await ctx.clock.sleep(milliseconds(1000), ctx.signal);
    } catch {
      return failed(
        current,
        `Observation stopped; resume the ${current.mode} with --prepared ${current.id}.`,
      );
    }
    const next = await readTransfer(app, target, current.id);
    if (!next.ok) return next;
    current = next.transfer;
  }
  if (current.status === "preparing" || current.status === "importing")
    return failed(
      current,
      `Bundle is still running; resume ${current.mode} with --prepared ${current.id}.`,
    );
  return { ok: true, transfer: current };
}
async function prepare(
  app: CcApplication,
  target: BundleTarget,
  path: string,
  body: Record<string, unknown>,
  recovery: ReportedRecovery,
): Promise<
  | { ok: true; transfer: BundleTransfer }
  | { ok: false; report: CommitReport<never, CcErrorCode> }
> {
  const response = await cliRequest(app.host, {
    ...target,
    method: "POST",
    path,
    body,
  });
  if (response.kind !== "ok")
    return { ok: false, report: ticketWriteFailure(response, recovery) };
  const parsed = bundleTransferSchema.safeParse(response.body);
  if (!parsed.success)
    return {
      ok: false,
      report: {
        effect: "unknown",
        recovery,
        result: invalid("ticket bundle preparation"),
      },
    };
  return { ok: true, transfer: parsed.data };
}

type ExportData = {
  transfer: BundleTransfer;
  projectName: string;
  number: number;
};
export const exportHandler: Write<typeof ticketSpecs.export> = {
  run: writeRunner<Input<typeof ticketSpecs.export>, ExportData, CcErrorCode>({
    async run({ app, ctx }) {
      if (ctx.flags.acknowledge && !ctx.flags.prepared)
        return {
          effect: "not_applied",
          result: usage(
            "--acknowledge requires --prepared so it names the reviewed archive.",
          ),
        };
      const resolved = await resolveTicket(app, ctx.args.ticket);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const target = resolved.value;
      let initial: BundleTransfer;
      if (ctx.flags.prepared) {
        const result = await readTransfer(app, target, ctx.flags.prepared);
        if (!result.ok) return { effect: "not_applied", result };
        initial = result.transfer;
      } else {
        const result = await prepare(
          app,
          target,
          `${ticketPath(target.projectName, target.number)}/bundle`,
          {},
          recoveryFacts([{ kind: "ticket", id: identifier(target) }]),
        );
        if (!result.ok) return result.report;
        initial = result.transfer;
      }
      const recovery = recoveryFor(initial);
      const refusal = (
        result: Failure<never, CcErrorCode>,
      ): CommitReport<never, CcErrorCode> =>
        ctx.flags.prepared
          ? { effect: "not_applied", result }
          : { effect: "applied", recovery, result };
      const waited = await waitForTransfer(app, ctx, target, initial);
      if (!waited.ok) return refusal(waited);
      const transfer = waited.transfer;
      if (transfer.mode !== "export")
        return refusal(
          usage("Prepared bundle belongs to a different operation."),
        );
      if (transfer.status === "failed")
        return refusal(
          failed(transfer, transfer.error ?? "Bundle preparation failed."),
        );
      if (
        transfer.omissions.length &&
        ctx.flags.acknowledge !== transfer.digest
      ) {
        return refusal({
          ...failed(
            transfer,
            "Export requires acknowledgment of missing content.",
          ),
          ...(transfer.digest
            ? {
                hint: hint(
                  invocation(exportCommand, {
                    args: { ticket: identifier(target) },
                    flags: {
                      ...explicitScopeFlags(app),
                      prepared: transfer.id,
                      acknowledge: transfer.digest,
                    },
                  }),
                  "Review the reported omissions, then acknowledge this prepared archive",
                ),
              }
            : {}),
        });
      }
      const response = await cliRequest(app.host, {
        ...target,
        method: "GET",
        path: `${transferPath(target, transfer.id)}/download?format=json&acknowledge=${encodeURIComponent(ctx.flags.acknowledge ?? "")}`,
      });
      if (response.kind !== "ok") return refusal(ticketFailure(response));
      const parsed = z.object({ archive: z.string() }).safeParse(response.body);
      if (!parsed.success) return refusal(invalid("ticket bundle archive"));
      const archive = Buffer.from(parsed.data.archive, "base64");
      if (archive.toString("base64") !== parsed.data.archive)
        return refusal(invalid("ticket bundle archive bytes"));
      return {
        effect: "applied",
        recovery,
        result: {
          ok: true,
          binary: binaryArtifact<ExportData>({
            bytes: archive,
            mediaType: "application/gzip",
            basename: `ticket-${target.number}.gz`,
            summary: {
              transfer,
              projectName: target.projectName,
              number: target.number,
            },
          }),
        },
      };
    },
    text: ({ transfer, projectName, number }) =>
      `exported ${projectName}#${number} (${transfer.documentCount} documents)${transfer.omissions.length ? `\n${transfer.omissions.map((item) => `${item.source}: ${item.reason}`).join("\n")}` : ""}`,
  }),
};

type ImportData = {
  transfer: BundleTransfer;
  projectName: string;
  number: number | null;
};
export const importHandler: Write<typeof ticketSpecs.import> = {
  run: writeRunner<Input<typeof ticketSpecs.import>, ImportData, CcErrorCode>({
    async run({ app, ctx }) {
      if (Boolean(ctx.flags.archive) === Boolean(ctx.flags.prepared))
        return {
          effect: "not_applied",
          result: usage(
            "Supply exactly one of --archive <path> or --prepared <id>.",
          ),
        };
      const resolved = await resolveCcProject(app);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const target = { ...resolved.value, projectName: resolved.value.project };
      let initial: BundleTransfer;
      if (ctx.flags.archive) {
        let content: Uint8Array;
        try {
          content = await ctx.host.files.read(
            ctx.flags.archive,
            bytes(256 * 1024 * 1024),
            ctx.signal,
          );
        } catch {
          return {
            effect: "not_applied",
            result: usage(
              "Cannot read the bundle within the 256 MiB archive limit.",
            ),
          };
        }
        const result = await prepare(
          app,
          target,
          basePath(target),
          { archive: Buffer.from(content).toString("base64") },
          recoveryFacts([{ kind: "project", id: target.projectName }]),
        );
        if (!result.ok) return result.report;
        initial = result.transfer;
      } else if (ctx.flags.prepared) {
        const result = await readTransfer(app, target, ctx.flags.prepared);
        if (!result.ok) return { effect: "not_applied", result };
        initial = result.transfer;
      } else
        return {
          effect: "not_applied",
          result: usage("Supply an archive or prepared transfer."),
        };
      let recovery = recoveryFor(initial);
      const initialRefusal = (
        result: Failure<never, CcErrorCode>,
      ): CommitReport<never, CcErrorCode> =>
        ctx.flags.prepared
          ? { effect: "not_applied", result }
          : { effect: "applied", recovery, result };
      const waited = await waitForTransfer(app, ctx, target, initial);
      if (!waited.ok) return initialRefusal(waited);
      let transfer = waited.transfer;
      if (transfer.mode !== "import")
        return initialRefusal(
          usage("Prepared bundle belongs to a different operation."),
        );
      if (transfer.status === "failed")
        return initialRefusal(
          failed(transfer, transfer.error ?? "Bundle preparation failed."),
        );
      if (transfer.status !== "imported") {
        const response = await cliRequest(app.host, {
          ...target,
          method: "POST",
          path: `${transferPath(target, transfer.id)}/import`,
          body: {
            digest: transfer.digest,
            allowDuplicate: ctx.flags["allow-duplicate"] === true,
          },
        });
        if (response.kind !== "ok") {
          const report = ticketWriteFailure(response, recovery);
          return report.effect === "unknown"
            ? report
            : { effect: "applied", recovery, result: report.result };
        }
        const parsed = bundleTransferSchema.safeParse(response.body);
        if (!parsed.success)
          return {
            effect: "unknown",
            recovery,
            result: invalid("ticket bundle import"),
          };
        recovery = recoveryFor(parsed.data);
        const waited = await waitForTransfer(app, ctx, target, parsed.data);
        if (!waited.ok) return { effect: "applied", recovery, result: waited };
        transfer = waited.transfer;
      }
      if (transfer.status !== "imported")
        return {
          effect: "applied",
          recovery,
          result: {
            ...failed(transfer, transfer.error ?? "Import has not completed."),
            hint: hint(
              invocation(importCommand, {
                flags: {
                  ...explicitScopeFlags(app),
                  prepared: transfer.id,
                  ...(transfer.status === "duplicate"
                    ? { "allow-duplicate": true }
                    : {}),
                },
              }),
              "Review the transfer result before retrying",
            ),
          },
        };
      return {
        effect: "applied",
        recovery,
        result: {
          ok: true,
          data: {
            transfer,
            projectName: target.projectName,
            number: transfer.ticketNumber,
          },
        },
      };
    },
    text: ({ transfer, projectName, number }) =>
      `imported ${projectName}#${number}\n${transfer.omissions.map((item) => `${item.source}: ${item.reason}`).join("\n")}`,
  }),
};
