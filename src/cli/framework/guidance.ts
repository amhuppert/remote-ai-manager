import {
  decodeEvaluatedGuidance,
  defineReminderRule,
  evaluateGuidance,
} from "cli-for-agents/guidance";
import type { GuidanceProvider } from "cli-for-agents/runtime";
import { createLogger } from "@/lib/logging";
import type { CcContexts } from "./family";
import { CLIENT_ADVISORIES, ccTempPayloadAdvisory } from "./payload-location";

const logger = createLogger("cli.guidance");
const guidance: GuidanceProvider<CcContexts> = async (input) => {
  const batches = (
    input.requires === "none" ? [] : (input.app.guidance ?? [])
  ).map((value) => {
    const batch = decodeEvaluatedGuidance(value);
    if (batch.authority !== "cc-server-lane")
      throw new Error(`Unexpected CC guidance authority: ${batch.authority}`);
    return batch;
  });
  const scratchInputs = input.inputFiles.filter(
    (source) =>
      source.kind === "payload" ||
      (source.kind === "flag" &&
        (source.name === "inputs" ||
          input.command.spec.flags[source.name]?.fileSource !== undefined)),
  );
  const reminders = scratchInputs
    .map((source) => ccTempPayloadAdvisory(source.path))
    .filter((text) => text !== undefined);
  const localRule = defineReminderRule<readonly string[]>({
    id: "payload-outside-cc",
    appliesTo: [input.command],
    priority: 0,
    evidence: CLIENT_ADVISORIES.payload_outside_cc.evidence,
    when: (texts) => input.outcome.result.ok && texts.length > 0,
    text: (texts) => texts[0] ?? "",
  });
  const local = await evaluateGuidance({
    command: input.command,
    authority: "cc-client-filesystem",
    state: reminders,
    rules: [localRule],
    eventSink: (event) =>
      logger.info(event.type, {
        commandPath: event.commandPath,
        ruleId: event.ruleId,
        tier: event.tier,
        authority: "cc-client-filesystem",
      }),
  });
  return [...batches, local];
};
export default guidance;
