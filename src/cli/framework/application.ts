import { invocation } from "cli-for-agents";
import { createCli, type ArtifactPolicySource } from "cli-for-agents/runtime";
import { BUILD_INFO } from "@/lib/build-info/build-info.generated";
import { formatBuildStamp } from "@/lib/build-info/stamp-value";
import { localArtifactPolicy } from "./artifact-policy";
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
import {
  subscriptionCommands,
  subscriptionGroups,
} from "../commands/subscription/definitions";
import { ticketCommands, ticketGroups } from "../commands/ticket/definitions";
import {
  conversationCommands,
  conversationGroups,
} from "../commands/conversation/definitions";
import { agentCommands, agentGroups } from "../commands/agent/definitions";
import { runCommands, runGroups } from "../commands/run/definitions";
import {
  runTemplateCommands,
  runTemplateGroups,
} from "../commands/run/template-definitions";
import {
  validateCommands,
  validateGroups,
} from "../commands/validate/definitions";
import { specCommands, specGroups } from "../commands/spec/native-definitions";
import {
  specWriteCommands,
  specWriteGroups,
} from "../commands/spec/native-write-definitions";

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
    description:
      "Act on the running Command Center server with this session's identity. Help, exit-codes, and local log analysis work offline.",
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
      ...subscriptionCommands,
      ...ticketCommands,
      ...conversationCommands,
      ...agentCommands,
      ...runCommands,
      ...runTemplateCommands,
      ...validateCommands,
      ...specCommands,
      ...specWriteCommands,
      ...devCommands,
      ...fixtureCommands,
      ...logsCommands,
    ],
    groups: [
      ...docsGroups,
      ...notepadGroups,
      ...alignmentGroups,
      ...memoryGroups,
      ...subscriptionGroups,
      ...ticketGroups,
      ...conversationGroups,
      ...agentGroups,
      ...runGroups,
      ...runTemplateGroups,
      ...validateGroups,
      ...specGroups,
      ...specWriteGroups,
      ...devGroups,
      ...fixtureGroups,
      ...logsGroups,
    ],
    contexts: {
      cc: async ({ env, globals, signal }) => {
        const transport = await resolveCcHost(host, env, signal);
        let inboxHintState: unknown;
        return {
          ok: true,
          app: {
            env,
            globals,
            get inboxHintState() {
              return inboxHintState;
            },
            host: {
              ...transport,
              onJsonResponse(body: unknown) {
                transport.onJsonResponse?.(body);
                if (
                  typeof body === "object" &&
                  body !== null &&
                  "inboxHintState" in body
                )
                  inboxHintState = body.inboxHintState;
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
    output: { artifacts: options.artifacts ?? localArtifactPolicy() },
  });
}
