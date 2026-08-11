import { dispatchGroup } from "../../dispatch";
import type { CliEnv, CliHost, CliResult, GlobalFlags } from "../../shared";
import {
  runSpecDelta,
  runSpecDiff,
  runSpecExport,
  runSpecGet,
  runSpecLint,
  runSpecList,
  runSpecMeasures,
  runSpecPlanGet,
  runSpecPlanPreview,
  runSpecPlanStatus,
  runSpecSearch,
  runSpecShow,
  runSpecStatus,
  runSpecVerify,
} from "./read";
import { runSpecSchema } from "./schema";
import {
  runSpecAbandon,
  runSpecAdvance,
  runSpecAmend,
  runSpecAnswer,
  runSpecAssume,
  runSpecCapture,
  runSpecCreate,
  runSpecDismissSuperseded,
  runSpecDraft,
  runSpecImport,
  runSpecPlanEdit,
  runSpecPlanOpen,
  runSpecPlanPropose,
  runSpecPlanReopen,
  runSpecPlanSignOff,
  runSpecPropose,
  runSpecQuestion,
  runSpecRemove,
  runSpecRename,
  runSpecRequestApproval,
  runSpecStart,
  runSpecTaskComplete,
  runSpecWithdrawProposal,
} from "./write";

export async function runSpec(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  lists: Record<string, string[]>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  return dispatchGroup({
    group: ["spec"],
    rest,
    json: flags.json,
    handlers: {
      list: (next) => runSpecList(next, flags, values, env, host),
      measures: (next) => runSpecMeasures(next, flags, values, env, host),
      show: (next) => runSpecShow(next, flags, values, env, host),
      status: (next) => runSpecStatus(next, flags, values, env, host),
      lint: (next) => runSpecLint(next, flags, values, env, host),
      get: (next) => runSpecGet(next, flags, values, env, host),
      search: (next) => runSpecSearch(next, flags, values, env, host),
      diff: (next) => runSpecDiff(next, flags, values, env, host),
      schema: (next) => Promise.resolve(runSpecSchema(next, flags, values)),
      delta: (next) => runSpecDelta(next, flags, values, env, host),
      export: (next) => runSpecExport(next, flags, values, env, host),
      verify: (next) => runSpecVerify(next, flags, values, env, host),
      create: (next) => runSpecCreate(next, flags, values, env, host),
      import: (next) => runSpecImport(next, flags, values, env, host),
      amend: (next) => runSpecAmend(next, flags, values, env, host),
      draft: (next) => runSpecDraft(next, flags, values, env, host),
      remove: (next) => runSpecRemove(next, flags, values, env, host),
      propose: (next) => runSpecPropose(next, flags, values, env, host),
      "withdraw-proposal": (next) =>
        runSpecWithdrawProposal(next, flags, values, env, host),
      "dismiss-superseded": (next) =>
        runSpecDismissSuperseded(next, flags, values, env, host),
      advance: (next) => runSpecAdvance(next, flags, values, env, host),
      question: (next) => runSpecQuestion(next, flags, values, env, host),
      answer: (next) => runSpecAnswer(next, flags, values, env, host),
      assume: (next) => runSpecAssume(next, flags, values, env, host),
      task: (next) =>
        dispatchGroup({
          group: ["spec", "task"],
          rest: next,
          json: flags.json,
          handlers: {
            complete: (taskRest) =>
              runSpecTaskComplete(taskRest, flags, values, lists, env, host),
          },
        }),
      plan: (next) =>
        dispatchGroup({
          group: ["spec", "plan"],
          rest: next,
          json: flags.json,
          handlers: {
            open: (planRest) =>
              runSpecPlanOpen(planRest, flags, values, env, host),
            edit: (planRest) =>
              runSpecPlanEdit(planRest, flags, values, env, host),
            propose: (planRest) =>
              runSpecPlanPropose(planRest, flags, values, env, host),
            reopen: (planRest) =>
              runSpecPlanReopen(planRest, flags, values, env, host),
            "sign-off": (planRest) =>
              runSpecPlanSignOff(planRest, flags, values, env, host),
            get: (planRest) =>
              runSpecPlanGet(planRest, flags, values, env, host),
            status: (planRest) =>
              runSpecPlanStatus(planRest, flags, values, env, host),
            preview: (planRest) =>
              runSpecPlanPreview(planRest, flags, values, env, host),
          },
        }),
      "request-approval": (next) =>
        runSpecRequestApproval(next, flags, values, env, host),
      start: (next) => runSpecStart(next, flags, values, env, host),
      capture: (next) => runSpecCapture(next, flags, values, env, host),
      rename: (next) => runSpecRename(next, flags, values, env, host),
      abandon: (next) => runSpecAbandon(next, flags, values, env, host),
    },
  });
}
