import { NextResponse } from "next/server";
import { admitCommand } from "./admission";
import { BackendAdmissionError } from "@/lib/agent-backends/execution-admission";
import { readConfig } from "@/lib/config/loader";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  hasCollabPrefix,
  parseConversationCommand,
} from "@/lib/conversation-commands/parse";

/** Why the command a prompt names cannot run on the backend, as status and body; null when it may. */
export async function commandAdmissionRefusal(
  prompt: string,
  backend?: AgentBackendId,
): Promise<{
  status: number;
  body: { error: string; code: string; refusal: unknown };
} | null> {
  const command = hasCollabPrefix(prompt)
    ? "/collab"
    : parseConversationCommand(prompt)?.command;
  if (!command) return null;
  try {
    admitCommand(
      backend ?? (await readConfig()).defaultAgentBackend,
      command.startsWith("/") ? command : `/${command}`,
    );
    return null;
  } catch (error) {
    if (!(error instanceof BackendAdmissionError)) throw error;
    return {
      status: 400,
      body: { error: error.message, code: error.code, refusal: error.refusal },
    };
  }
}

export async function commandRequestRefusal(
  prompt: string,
  backend?: AgentBackendId,
): Promise<Response | null> {
  const refused = await commandAdmissionRefusal(prompt, backend);
  return refused === null
    ? null
    : NextResponse.json(refused.body, { status: refused.status });
}
