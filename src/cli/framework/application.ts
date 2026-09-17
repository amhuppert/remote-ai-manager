import { invocation } from "cli-for-agents";
import { createCli, type ArtifactPolicySource } from "cli-for-agents/runtime";
import { BUILD_INFO } from "@/lib/build-info/build-info.generated";
import { formatBuildStamp } from "@/lib/build-info/stamp-value";
import { resolveCcHost, type CcHostSource } from "./host-source";
import type { CcContexts } from "./family";
import { ccCommands } from "./family";
import { notifyCommand } from "./notify.definition";
import { createDoctorCommand } from "./doctor.definition";
import { docsCommands, docsGroups } from "../commands/docs/definitions";
import {
  notepadCommands,
  notepadGroups,
} from "../commands/notepad/definitions";
import { askCommands } from "../commands/ask/definitions";
import {
  alignmentCommands,
  alignmentGroups,
} from "../commands/alignment/definitions";
import { memoryCommands, memoryGroups } from "../commands/memory/definitions";
import { ticketCommands, ticketGroups } from "../commands/ticket/definitions";
import {
  conversationCommands,
  conversationGroups,
} from "../commands/conversation/definitions";
import { agentCommands, agentGroups } from "../commands/agent/definitions";
import {
  validateCommands,
  validateGroups,
} from "../commands/validate/definitions";
import { specCommands, specGroups } from "../commands/spec/native-definitions";
import {
  specWriteCommands,
  specWriteGroups,
} from "../commands/spec/native-write-definitions";
import {
  workflowCommands,
  workflowGroups,
} from "../commands/workflow/definitions";

import { devCommands, devGroups } from "../commands/dev/definitions";
import {
  fixtureCommands,
  fixtureGroups,
} from "../commands/fixture/definitions";

import { logsCommands, logsGroups } from "../commands/logs/definitions";

const nodeHostSource: CcHostSource = async (env, signal) =>
  (await import("./node-host")).createNodeCliHost(env, signal);

export function createCommandCenterCli(
  host: CcHostSource = nodeHostSource,
  options: { artifacts?: ArtifactPolicySource<CcContexts> } = {},
) {
  const doctor = createDoctorCommand(host);
  return createCli({
    name: "cctl",
    version: formatBuildStamp(BUILD_INFO),
    family: ccCommands,
    commands: [
      doctor,
      notifyCommand,
      ...docsCommands,
      ...notepadCommands,
      ...askCommands,
      ...alignmentCommands,
      ...memoryCommands,
      ...ticketCommands,
      ...conversationCommands,
      ...agentCommands,
      ...validateCommands,
      ...specCommands,
      ...specWriteCommands,
      ...workflowCommands,
      ...devCommands,
      ...fixtureCommands,
      ...logsCommands,
    ],
    groups: [
      ...docsGroups,
      ...notepadGroups,
      ...alignmentGroups,
      ...memoryGroups,
      ...ticketGroups,
      ...conversationGroups,
      ...agentGroups,
      ...validateGroups,
      ...specGroups,
      ...specWriteGroups,
      ...workflowGroups,
      ...devGroups,
      ...fixtureGroups,
      ...logsGroups,
    ],
    contexts: {
      cc: async ({ env, globals, signal }) => {
        const transport = await resolveCcHost(host, env, signal);
        const guidance: unknown[] = [];
        return {
          ok: true,
          app: {
            env,
            globals,
            guidance,
            host: {
              ...transport,
              onJsonResponse(body: unknown) {
                transport.onJsonResponse?.(body);
                if (
                  typeof body === "object" &&
                  body !== null &&
                  "guidance" in body
                )
                  guidance.push(body.guidance);
              },
            },
          },
        };
      },
    },
    doctor: invocation(doctor, {}),
    guidance: {
      load: async () => import("./guidance"),
      conflictSink: async (event) => {
        const { createLogger } = await import("@/lib/logging");
        createLogger("cli.guidance").error(event.type, {
          commandPath: event.commandPath,
          conflict: event.conflict,
        });
      },
    },
    output: {
      artifacts: options.artifacts ?? {
        resolve: async () =>
          (await import("./artifact-policy")).localArtifactPolicy(),
      },
    },
  });
}
