import { NextResponse } from "next/server";
import { admitCommand } from "./admission";
import { BackendAdmissionError } from "@/lib/agent-backends/execution-admission";
import { readConfig } from "@/lib/config/loader";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  hasCollabPrefix,
  parseConversationCommand,
} from "@/lib/conversation-commands/parse";

export async function commandRequestRefusal(
  prompt: string,
  backend?: AgentBackendId,
): Promise<Response | null> {
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
    return NextResponse.json(
      { error: error.message, code: error.code, refusal: error.refusal },
      { status: 400 },
    );
  }
}
