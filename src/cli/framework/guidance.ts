import { defineReminderRule, evaluateGuidance } from "cli-for-agents/guidance";
import type { GuidanceProvider } from "cli-for-agents/runtime";
import { createLogger } from "@/lib/logging";
import { LANE_REMINDER_RULES } from "@/lib/workflow-graph/lane-reminders";
import {
  laneReminderInputSchema,
  type LaneReminderInput,
} from "@/lib/workflow-graph/lane-reminder-schemas";
import {
  taskCompleteCommand,
  taskAddCommand,
  sharedDocUpsertCommand,
  collabRequestCommand,
} from "../commands/workflow/definitions";
import type { CcContexts } from "./family";
import { CLIENT_ADVISORIES, ccTempPayloadAdvisory } from "./payload-location";

const logger = createLogger("cli.guidance");
const laneCommands = {
  "task-complete": taskCompleteCommand,
  "task-add": taskAddCommand,
  "shared-doc-upsert": sharedDocUpsertCommand,
  "collab-request": collabRequestCommand,
};
const guidance: GuidanceProvider<CcContexts> = async (input) => {
  const rawState =
    input.requires === "none" ? undefined : input.app.laneReminderState;
  let laneState: LaneReminderInput | undefined;
  if (rawState !== undefined) {
    const parsed = laneReminderInputSchema.safeParse(rawState);
    if (!parsed.success) throw new Error("Invalid CC lane reminder state.");
    if (laneCommands[parsed.data.verb].spec.path !== input.command.spec.path)
      throw new Error(
        "CC lane reminder state does not match the invoked command.",
      );
    laneState = parsed.data;
  }
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
  const localRule = defineReminderRule<LaneReminderInput | undefined>({
    id: "payload-outside-cc",
    appliesTo: [input.command],
    priority: 0,
    evidence: CLIENT_ADVISORIES.payload_outside_cc.evidence,
    when: () => input.outcome.result.ok && reminders.length > 0,
    text: () => reminders[0] ?? "",
  });
  const laneRules = LANE_REMINDER_RULES.map((rule, index) =>
    defineReminderRule<LaneReminderInput | undefined>({
      id: rule.id,
      appliesTo: [input.command],
      priority: LANE_REMINDER_RULES.length - index,
      evidence: rule.evidence,
      when: (state) =>
        state !== undefined &&
        rule.verbs.includes(state.verb) &&
        rule.when(state),
      text: (state) => (state === undefined ? "" : rule.text(state)),
    }),
  );
  return evaluateGuidance({
    command: input.command,
    state: laneState,
    rules: [localRule, ...laneRules],
    eventSink: (event) =>
      logger.info(event.type, {
        commandPath: event.commandPath,
        ruleId: event.ruleId,
        tier: event.tier,
      }),
  });
};
export default guidance;
