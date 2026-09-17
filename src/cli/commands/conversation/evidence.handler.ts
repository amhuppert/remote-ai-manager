import { binaryArtifact, invocation, runner } from "cli-for-agents";
import { hint } from "cli-for-agents/guidance";
import { z } from "zod";
import {
  historyEntryMetadataSchema,
  type HistoryEntryMetadata,
} from "@/lib/conversations/history-recovery";
import { cliRequest, cliRequestBytes, cliRequestText } from "../../transport";
import type { CcErrorCode } from "../../framework/context";
import {
  ccRequestFailure,
  type CcFailedRequest,
} from "../../framework/request";
import {
  entryGetCommand,
  imageGetCommand,
  type entryGetSpec,
  type imageGetSpec,
} from "./definitions";
import {
  basePath,
  invalidResponse,
  isScopeMiss,
  quoteEvidence,
  readInScope,
  requestParams,
  scopeFlags,
  type Input,
  type Read,
} from "./native-target";

const metadataSchema = z.object({ entry: historyEntryMetadataSchema });
function archiveFailure(response: CcFailedRequest) {
  const failure = ccRequestFailure(response);
  if (
    response.kind !== "error" ||
    response.status !== 404 ||
    response.code === undefined ||
    ["entry_not_found", "not_an_image_block"].includes(response.code) ||
    isScopeMiss(response)
  )
    return failure;
  return ccRequestFailure(response, { errorCode: "CC_OPERATION_FAILED" });
}
export const entryGetHandler: Read<typeof entryGetSpec> = {
  run: runner<
    Input<typeof entryGetSpec>,
    { entry: HistoryEntryMetadata; text: string },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const id = ctx.args["conversation-id"];
      const seq = ctx.args.seq;
      const thinking = ctx.flags["include-thinking"] === true;
      const metadata = await readInScope(
        app,
        id,
        (target) =>
          cliRequest(app.host, {
            ...requestParams(target),
            method: "GET",
            path: `${basePath(target)}/history/entries/${seq}?format=metadata${thinking ? "&includeThinking=true" : ""}`,
          }),
        archiveFailure,
      );
      if (!metadata.ok) return metadata;
      const parsed = metadataSchema.safeParse(metadata.value.body);
      if (!parsed.success) return invalidResponse("archive entry metadata");
      const response = await cliRequestText(app.host, {
        ...requestParams(metadata.target),
        method: "GET",
        path: `${basePath(metadata.target)}/history/entries/${seq}${thinking ? "?includeThinking=true" : ""}`,
      });
      if (response.kind !== "ok") return archiveFailure(response);
      const entry = parsed.data.entry;
      const firstImage = entry.images[0];
      const advice = firstImage
        ? hint(
            invocation(imageGetCommand, {
              args: {
                "conversation-id": id,
                seq: firstImage.seq,
                "block-index": firstImage.contentBlockIndex,
              },
              flags: scopeFlags(metadata.target),
            }),
            "Export an original image displayed by this entry",
          )
        : entry.thinkingOmitted > 0
          ? hint(
              invocation(entryGetCommand, {
                args: { "conversation-id": id, seq },
                flags: {
                  ...scopeFlags(metadata.target),
                  "include-thinking": true,
                },
              }),
              "Include the omitted thinking blocks",
            )
          : undefined;
      return {
        ok: true,
        data: { entry, text: response.text },
        ...(advice ? { hint: advice } : {}),
      };
    },
    text: ({ entry, text }) =>
      `entry seq ${entry.seq} kind=${entry.kind} role=${entry.role ?? "-"} message #${entry.messageIndex}\n${entry.bytes} bytes sha256=${entry.sha256}\nThinking ${entry.includeThinking ? "included" : `omitted (${entry.thinkingOmitted} blocks)`}\n${entry.images.map((image) => `Image block ${image.contentBlockIndex} ${image.mediaType} — ${image.command}\n`).join("")}${quoteEvidence(text)}\n`,
  }),
};

type ImageSummary = {
  conversationId: string;
  seq: number;
  contentBlockIndex: number;
  mediaType: string;
};
export const imageGetHandler: Read<typeof imageGetSpec> = {
  run: runner<Input<typeof imageGetSpec>, ImageSummary, CcErrorCode>({
    async run({ app, ctx }) {
      const id = ctx.args["conversation-id"];
      const seq = ctx.args.seq;
      const block = ctx.args["block-index"];
      const response = await readInScope(
        app,
        id,
        (target) =>
          cliRequestBytes(app.host, {
            ...requestParams(target),
            method: "GET",
            path: `${basePath(target)}/history/images/${seq}/${block}`,
          }),
        archiveFailure,
      );
      if (!response.ok) return response;
      const mediaType = response.value.mediaType;
      const extension =
        mediaType === "image/png"
          ? "png"
          : mediaType === "image/jpeg"
            ? "jpg"
            : mediaType === "image/webp"
              ? "webp"
              : mediaType === "image/gif"
                ? "gif"
                : "bin";
      return {
        ok: true,
        binary: binaryArtifact<ImageSummary>({
          bytes: response.value.bytes,
          mediaType,
          basename: `image-${seq}-${block}.${extension}`,
          summary: {
            conversationId: id,
            seq,
            contentBlockIndex: block,
            mediaType,
          },
        }),
      };
    },
    text: (image) =>
      `image seq ${image.seq} block ${image.contentBlockIndex} ${image.mediaType}\n`,
  }),
};
