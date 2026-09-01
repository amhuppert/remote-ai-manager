import { dispatchGroup } from "../../dispatch";
import type { CliEnv, CliHost, CliResult, GlobalFlags } from "../../shared";
import {
  runSpecComments,
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
  runSpecSectionGet,
  runSpecShow,
  runSpecStatus,
  runSpecVerify,
} from "./read";
import { runSpecSchema } from "./schema";
import {
  runSpecAbandon,
  runSpecAdvance,
  runSpecAttentionCite,
  runSpecAttentionEdit,
  runSpecAttentionSupersede,
  runSpecAttentionUncite,
  runSpecAttentionWithdraw,
  runSpecAmend,
  runSpecAnswer,
  runSpecAssume,
  runSpecCapture,
  runSpecCreate,
  runSpecDismissSuperseded,
  runSpecDraft,
  runSpecImport,
  runSpecPlanAbandon,
  runSpecPlanEdit,
  runSpecPlanOpen,
  runSpecPlanPropose,
  runSpecPlanReopen,
  runSpecPlanSignOff,
  runSpecPropose,
  runSpecQuestion,
  runSpecRemove,
  runSpecRename,
  runSpecReply,
  runSpecRequestApproval,
  runSpecReturnToRequirements,
  runSpecStart,
  runSpecWithdrawProposal,
} from "./write";

export async function runSpec(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  _lists: Record<string, string[]>,
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
      comments: (next) => runSpecComments(next, flags, values, env, host),
      lint: (next) => runSpecLint(next, flags, values, env, host),
      get: (next) => runSpecGet(next, flags, values, env, host),
      section: (next) =>
        dispatchGroup({
          group: ["spec", "section"],
          rest: next,
          json: flags.json,
          handlers: {
            get: (sectionRest) =>
              runSpecSectionGet(sectionRest, flags, values, env, host),
          },
        }),
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
      "return-to-requirements": (next) =>
        runSpecReturnToRequirements(next, flags, values, env, host),
      question: (next) => runSpecQuestion(next, flags, values, env, host),
      answer: (next) => runSpecAnswer(next, flags, values, env, host),
      reply: (next) => runSpecReply(next, flags, values, env, host),
      assume: (next) => runSpecAssume(next, flags, values, env, host),
      attention: (next) =>
        dispatchGroup({
          group: ["spec", "attention"],
          rest: next,
          json: flags.json,
          handlers: {
            edit: (attentionRest) =>
              runSpecAttentionEdit(attentionRest, flags, values, env, host),
            withdraw: (attentionRest) =>
              runSpecAttentionWithdraw(attentionRest, flags, values, env, host),
            supersede: (attentionRest) =>
              runSpecAttentionSupersede(
                attentionRest,
                flags,
                values,
                env,
                host,
              ),
            cite: (attentionRest) =>
              runSpecAttentionCite(attentionRest, flags, values, env, host),
            uncite: (attentionRest) =>
              runSpecAttentionUncite(attentionRest, flags, values, env, host),
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
            abandon: (planRest) =>
              runSpecPlanAbandon(planRest, flags, values, env, host),
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
