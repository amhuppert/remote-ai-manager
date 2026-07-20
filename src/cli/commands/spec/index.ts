import { dispatchGroup } from "../../dispatch";
import type { CliEnv, CliHost, CliResult, GlobalFlags } from "../../shared";
import {
  runSpecExport,
  runSpecGet,
  runSpecList,
  runSpecMeasures,
  runSpecSearch,
  runSpecShow,
  runSpecStatus,
  runSpecVerify,
} from "./read";
import {
  runSpecAbandon,
  runSpecAnswer,
  runSpecAssume,
  runSpecCapture,
  runSpecCreate,
  runSpecDraft,
  runSpecPropose,
  runSpecQuestion,
  runSpecRename,
  runSpecRequestApproval,
  runSpecStart,
  runSpecTaskComplete,
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
      get: (next) => runSpecGet(next, flags, values, env, host),
      search: (next) => runSpecSearch(next, flags, values, env, host),
      export: (next) => runSpecExport(next, flags, values, env, host),
      verify: (next) => runSpecVerify(next, flags, values, env, host),
      create: (next) => runSpecCreate(next, flags, values, env, host),
      draft: (next) => runSpecDraft(next, flags, values, env, host),
      propose: (next) => runSpecPropose(next, flags, values, env, host),
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
      "request-approval": (next) =>
        runSpecRequestApproval(next, flags, values, env, host),
      start: (next) => runSpecStart(next, flags, values, env, host),
      capture: (next) => runSpecCapture(next, flags, values, env, host),
      rename: (next) => runSpecRename(next, flags, values, env, host),
      abandon: (next) => runSpecAbandon(next, flags, values, env, host),
    },
  });
}
