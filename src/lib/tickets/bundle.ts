import { createHash } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { createLogger } from "@/lib/logging";
import { z } from "zod";
import {
  ticketSchema,
  ticketAttachmentSchema,
  ticketRelationshipViewSchema,
  ticketSessionLinkSchema,
  ticketStatusUpdateSchema,
} from "./schemas";

export const ticketBundleSchema = z
  .object({
    format: z.literal("cc-ticket-bundle"),
    version: z.literal(1),
    capturedAt: z.string(),
    ticket: ticketSchema,
    attachments: z.array(ticketAttachmentSchema),
    relationships: z.array(ticketRelationshipViewSchema),
    sessions: z.array(ticketSessionLinkSchema),
    statusUpdates: z.array(ticketStatusUpdateSchema),
    roots: z.array(z.string()),
    omissions: z.array(z.object({ source: z.string(), reason: z.string() })),
    documents: z.array(
      z.object({
        source: z.string(),
        description: z.string(),
        fileName: z.string(),
        mediaType: z.string().nullable(),
        content: z.string(),
        sha256: z.string(),
      }),
    ),
  })
  .strict();
export type TicketBundle = z.infer<typeof ticketBundleSchema>;

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const logger = createLogger("tickets.bundle");
export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

export function bundleDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Self-contained gzip archive; members are data, never filesystem extraction paths. */
export async function encodeTicketBundle(
  bundle: TicketBundle,
): Promise<Buffer> {
  const normalized = ticketBundleSchema.parse({
    ...bundle,
    documents: bundle.documents.map((document) => ({
      ...document,
      sha256: bundleDigest(Buffer.from(document.content, "base64")),
    })),
  });
  const bytes = Buffer.from(JSON.stringify(normalized));
  if (bytes.length > MAX_BUNDLE_BYTES)
    throw new Error(
      "Ticket bundle exceeds the 256 MiB expanded archive limit; no content was truncated",
    );
  const archive = await compress(bytes);
  logger.info("bundle.encoded", {
    documents: normalized.documents.length,
    bytes: archive.length,
    omissions: normalized.omissions.length,
  });
  return archive;
}

/** Reject unsupported formats, corrupt members, and oversized archives before importing anything. */
export async function decodeTicketBundle(
  bytes: Uint8Array,
): Promise<TicketBundle> {
  if (bytes.byteLength > MAX_BUNDLE_BYTES)
    throw new Error("Ticket bundle exceeds the 256 MiB archive limit");
  const expanded = await decompress(bytes, {
    maxOutputLength: MAX_BUNDLE_BYTES,
  });
  const input: unknown = JSON.parse(expanded.toString("utf8"));
  const parsed = ticketBundleSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid or unsupported ticket bundle");
  const sources = new Set<string>();
  for (const document of parsed.data.documents) {
    const content = Buffer.from(document.content, "base64");
    if (
      content.toString("base64") !== document.content ||
      bundleDigest(content) !== document.sha256
    ) {
      throw new Error(
        `Ticket bundle integrity check failed: ${document.source}`,
      );
    }
    if (sources.has(document.source))
      throw new Error(`Duplicate bundle source: ${document.source}`);
    sources.add(document.source);
  }
  return parsed.data;
}
