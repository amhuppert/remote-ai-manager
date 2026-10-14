import {
  defineReminderRule,
  defineSteering,
  evaluateGuidance,
} from "cli-for-agents/guidance";
import type { GuidanceProvider } from "cli-for-agents/runtime";
import { createLogger } from "@/lib/logging";
import type { CcContexts } from "./family";
import { CLIENT_ADVISORIES, ccTempPayloadAdvisory } from "./payload-location";
import { loadInboxHint } from "./inbox-hint";

const logger = createLogger("cli.guidance");
const guidance: GuidanceProvider<CcContexts> = async (input) => {
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
  const localRule = defineReminderRule<undefined>({
    id: "payload-outside-cc",
    appliesTo: [input.command],
    priority: 0,
    evidence: CLIENT_ADVISORIES.payload_outside_cc.evidence,
    when: () => input.outcome.result.ok && reminders.length > 0,
    text: () => reminders[0] ?? "",
  });
  const inboxHint =
    input.requires !== "none" &&
    input.outcome.result.ok &&
    !input.outcome.result.hint &&
    !input.outcome.result.instruction &&
    !input.command.spec.path.startsWith("inbox ") &&
    !input.command.spec.path.startsWith("subscription ") &&
    !input.command.spec.path.startsWith("conversation ") &&
    !input.command.spec.path.startsWith("fixture ")
      ? await loadInboxHint(input.app)
      : undefined;
  const inboxRules = inboxHint
    ? [
        defineSteering<undefined>({
          id: "pending-inbox",
          tier: "hint",
          appliesTo: [input.command],
          when: () => true,
          render: () => inboxHint,
        }),
      ]
    : [];
  return evaluateGuidance({
    command: input.command,
    state: undefined,
    rules: [localRule, ...inboxRules],
    eventSink: (event) =>
      logger.info(event.type, {
        commandPath: event.commandPath,
        ruleId: event.ruleId,
        tier: event.tier,
      }),
  });
};
export default guidance;
