import path from "node:path";
import { z } from "zod";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import { getConfigDirPath } from "@/lib/config/loader";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { publishEvent } from "@/lib/events/publication";
import { readBodyBounded } from "@/lib/shared/bounded-body";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import { resolveTicketProjectOr404 } from "./route-resolution";
import { getTicketContentStore, getTicketsRepo } from "./service-factory";
import { getTicketProjectOperationGate } from "./project-operation-gate";
import { parseTicketNumberSegment } from "./ticket-number";
import { publishTicketChange } from "./events";
import { MAX_BUNDLE_BYTES } from "./bundle";
import { captureTicketBundle } from "./bundle-capture";
import { importTicketBundle } from "./bundle-import";
import { createBundleCaptureDeps } from "./bundle-production";
import { createBundleTransfers } from "./bundle-transfer";

const logger = createLogger("tickets.bundle-routes");
function transfers() {
  return getGlobalSingleton("__cc_ticket_bundle_transfers", () =>
    createBundleTransfers({
      root: path.join(getConfigDirPath(), "ticket-bundle-transfers"),
      capture: (projectPath, number) =>
        getTicketProjectOperationGate().runTicketOperation(projectPath, () =>
          captureTicketBundle(createBundleCaptureDeps(), projectPath, number),
        ),
      importBundle: (bundle, projectPath, allowDuplicate) =>
        getTicketProjectOperationGate().runTicketOperation(
          projectPath,
          async () => {
            const repo = getTicketsRepo();
            const ticket = await importTicketBundle(
              { repo, contentStore: getTicketContentStore() },
              bundle,
              projectPath,
              allowDuplicate,
            );
            publishTicketChange({
              publish: publishEvent,
              logger,
              change: "created",
              projectName: ticket.projectName,
              ticketNumber: ticket.number,
              listItem: await repo.findListItem(projectPath, ticket.number),
              attachmentIndexChanged: true,
            });
            return ticket.number;
          },
        ),
      publish: (projectPath, transfer) => {
        publishEvent({
          type: "ticket-bundle-status",
          projectName: path.basename(projectPath),
          ...transfer,
        });
      },
    }),
  );
}
export interface BundleRouteDeps {
  getTransfers(): ReturnType<typeof createBundleTransfers>;
  resolveProjectPath(projectName: string): Promise<string | null>;
  auth: AgentAuth;
}
type Context = { params: Promise<Record<string, string>> };
const uploadSchema = z.object({ archive: z.string().min(1) }).strict();
const commitSchema = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    allowDuplicate: z.boolean().default(false),
  })
  .strict();

export function createBundleRouteHandlers(deps: BundleRouteDeps) {
  function handle(
    operation: (
      request: Request,
      projectPath: string,
      params: Record<string, string>,
    ) => Promise<Response>,
  ) {
    return async (request: Request, context: Context): Promise<Response> => {
      if ((await deps.auth.validateOptionalToken(request)).kind === "invalid")
        return Response.json({ error: "Invalid token" }, { status: 401 });
      const params = await context.params;
      const project = await resolveTicketProjectOr404(
        deps,
        params["name"] ?? "",
      );
      if (!project.ok) return project.response;
      try {
        return await operation(request, project.value, params);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Bundle operation failed";
        logger.warn("bundle.request_failed", { error: message });
        return Response.json(
          { error: message, code: "bundle_request_failed" },
          { status: /not found/i.test(message) ? 404 : 400 },
        );
      }
    };
  }
  async function body(request: Request, limit: number): Promise<unknown> {
    const read = await readBodyBounded(request.body, limit);
    if (!read.ok) throw new Error("Bundle request is too large");
    return JSON.parse(Buffer.from(read.bytes).toString("utf8"));
  }
  return {
    exportPOST: handle(async (_request, projectPath, params) => {
      const number = parseTicketNumberSegment(params["number"] ?? "");
      if (number === null) throw new Error("Invalid ticket number");
      return Response.json(
        await deps.getTransfers().prepare(projectPath, { number }),
        { status: 202 },
      );
    }),
    uploadPOST: handle(async (request, projectPath) => {
      const parsed = uploadSchema.safeParse(
        await body(request, Math.ceil((MAX_BUNDLE_BYTES * 4) / 3) + 1024),
      );
      if (!parsed.success) throw new Error("Expected a ticket archive");
      const bytes = Buffer.from(parsed.data.archive, "base64");
      if (
        bytes.toString("base64") !== parsed.data.archive ||
        bytes.length > MAX_BUNDLE_BYTES
      )
        throw new Error("Invalid or oversized ticket archive");
      return Response.json(
        await deps.getTransfers().prepare(projectPath, { bytes }),
        { status: 202 },
      );
    }),
    statusGET: handle(async (_request, projectPath, params) =>
      Response.json(
        await deps.getTransfers().get(projectPath, params["id"] ?? ""),
      ),
    ),
    downloadGET: handle(async (request, projectPath, params) => {
      const query = new URL(request.url).searchParams;
      const bytes = await deps
        .getTransfers()
        .download(
          projectPath,
          params["id"] ?? "",
          query.get("acknowledge") ?? undefined,
        );
      if (query.get("format") === "json")
        return Response.json({
          archive: Buffer.from(bytes).toString("base64"),
        });
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": 'attachment; filename="ticket.cc-ticket.gz"',
          "Cache-Control": "no-store",
        },
      });
    }),
    importPOST: handle(async (request, projectPath, params) => {
      const parsed = commitSchema.safeParse(await body(request, 4096));
      if (!parsed.success)
        throw new Error("Review the bundle before importing");
      return Response.json(
        await deps
          .getTransfers()
          .commit(
            projectPath,
            params["id"] ?? "",
            parsed.data.digest,
            parsed.data.allowDuplicate,
          ),
        { status: 202 },
      );
    }),
  };
}
const handlers = createBundleRouteHandlers({
  getTransfers: transfers,
  resolveProjectPath,
  auth: createAgentAuth(),
});
export const bundleExportPOST = withTracing(handlers.exportPOST);
export const bundleUploadPOST = withTracing(handlers.uploadPOST);
export const bundleStatusGET = withTracing(handlers.statusGET);
export const bundleDownloadGET = withTracing(handlers.downloadGET);
export const bundleImportPOST = withTracing(handlers.importPOST);
