import type { AgentBackendId, SessionState } from "@/types";

export interface RuntimeTarget {
  projectPath: string;
  projectName: string;
  sessionName: string;
  conversationId: string;
  backend: AgentBackendId;
}

export interface RuntimeTargetProject {
  projectPath: string;
  projectName: string;
  sessions: readonly SessionState[];
}

export function collectRuntimeTargets(input: {
  projects: readonly RuntimeTargetProject[];
  getRuntime(
    conversationId: string,
  ): { status: "alive" | "dead"; backend: AgentBackendId } | undefined;
}): RuntimeTarget[] {
  const targets: RuntimeTarget[] = [];

  for (const project of input.projects) {
    for (const session of project.sessions) {
      for (const conversation of session.conversations) {
        const runtime = input.getRuntime(conversation.id);
        if (!runtime || runtime.status !== "alive") continue;
        targets.push({
          projectPath: project.projectPath,
          projectName: project.projectName,
          sessionName: session.sessionName,
          conversationId: conversation.id,
          backend: runtime.backend,
        });
      }
    }
  }

  return targets;
}
