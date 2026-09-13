"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { mutationFetch } from "@/lib/api/fetcher";
import { publicConversationStateSchema } from "@/lib/conversations/schemas";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { checkpointReceiptSchema } from "./receipt";
import {
  checkpointForkRequestSchema,
  type CheckpointForkRequest,
} from "./fork-schemas";
import type { CheckpointTarget } from "./query-keys";
import { checkpointUrl } from "./queries";
import { publishCheckpointReceipt } from "./sse-cache";

const responseSchema = z.object({
  conversation: publicConversationStateSchema,
  receipt: checkpointReceiptSchema,
  reused: z.boolean(),
});
export function useCheckpointForkMutation(
  target: CheckpointTarget,
  operationId: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CheckpointForkRequest) =>
      mutationFetch(
        `${checkpointUrl(target, operationId)}/fork`,
        "fork-conversation-checkpoint",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(checkpointForkRequestSchema.parse(request)),
        },
        responseSchema,
      ),
    onSuccess: async ({ conversation, receipt }) => {
      publishCheckpointReceipt(
        client,
        { ...target, conversationId: conversation.id },
        receipt,
      );
      if (target.scope === "project") {
        await client.invalidateQueries({
          queryKey: projectConversationKeys.list(target.projectName),
        });
        return;
      }
      await Promise.all([
        client.invalidateQueries({
          queryKey: conversationKeys.list(
            target.projectName,
            target.sessionName,
          ),
        }),
        client.invalidateQueries({
          queryKey: sessionKeys.detail(target.projectName, target.sessionName),
        }),
      ]);
    },
  });
}
