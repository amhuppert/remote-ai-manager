import type {
  HostedConversation,
  RuntimeHostDeps,
  RuntimeRequirements,
} from "../runtime-host";
import type { ConversationTurnDependencies } from "./dependencies";
import type { ExecutePromptInput } from "./types";
import type { AdmittedConversationProfile } from "@/lib/conversations/profile-admission";
import { conversationTargetStoreSessionName } from "@/lib/conversations/conversation-target";
import { isEligibleOwner } from "@/lib/conversations/owner-eligibility";
import type { SessionState } from "@/lib/sessions/schemas";
import {
  CC_CONTEXT,
  CC_CLI_INSTRUCTIONS,
  TDD_INSTRUCTIONS,
  selectAskQuestionInstructions,
} from "@/lib/prompt/runtime-instruction-policy";
import {
  PROJECT_CC_CONTEXT,
  PROJECT_SPAWN_INSTRUCTIONS,
} from "@/lib/project-conversations/system-prompt";
import { MEMORY_ADVISORY_CONTRACT } from "@/lib/memory/advisory-contract";
import { registerFocusMemoryIfPresent } from "@/lib/conversation-core/contributions/focus-memory";
import { resolveAlignmentInstructionForNewRuntime } from "@/lib/conversation-core/contributions/alignment-gate";
import { resolveConversationProfileInjection } from "@/lib/conversation-core/contributions/profile-injection";
import { isPromptNotDeliveredFailure } from "@/lib/agent-backends/errors";
import type { PreparedSubscriptionBriefing } from "@/lib/subscriptions/service";

export type RuntimeRecoveryInstructions = Awaited<
  ReturnType<typeof prepareRuntimeRecoveryInstructions>
>;

/** Only operational loss context belongs in the new runtime's instructions. */
export async function prepareRuntimeRecoveryInstructions(
  deps: Pick<
    ConversationTurnDependencies["effects"],
    "prepareRuntimeLossNotice"
  >,
  input: {
    recipient: Parameters<typeof deps.prepareRuntimeLossNotice>[0]["recipient"];
    attemptId: string;
  },
  closeUnacceptedRuntime: () => Promise<void>,
  ownReceipt: (finish: () => Promise<void>) => void,
) {
  const briefing: PreparedSubscriptionBriefing =
    await deps.prepareRuntimeLossNotice(input);
  let accepted = false;
  let dispatched = false;
  let provenUndelivered = false;
  let finalized = false;
  const finish = async () => {
    finalized = true;
    try {
      await briefing.finish({
        disposition:
          !dispatched || provenUndelivered ? "not_sent" : "uncertain",
      });
    } finally {
      // A warmed runtime must never later carry context whose delivery was
      // finalized without acceptance. The receipt preserves whether input
      // was proven unsent or requires inspection as uncertain.
      if (briefing.block && !accepted) await closeUnacceptedRuntime();
    }
  };
  if (briefing.block) ownReceipt(finish);
  return {
    get block() {
      return accepted ? null : briefing.block;
    },
    async onInputAccepted() {
      accepted = true;
      await briefing.onInputAccepted();
    },
    markDispatched() {
      if (finalized && briefing.block)
        throw new Error("Runtime recovery input already finalized");
      dispatched = true;
      provenUndelivered = false;
    },
    markDispatchFailure(error: unknown) {
      provenUndelivered = isPromptNotDeliveredFailure(error);
    },
    finish,
  };
}

type RuntimeInstructionDependencies = {
  execution: Pick<
    ConversationTurnDependencies["execution"],
    | "getSessionState"
    | "fileExists"
    | "getConversation"
    | "getCodexToolPromptHint"
    | "getRunToolPromptHint"
  >;
  context: Pick<
    ConversationTurnDependencies["context"],
    | "getReferenceDocuments"
    | "getActiveAlignmentInjection"
    | "getWorkflowLaneInstructions"
  >;
  effects: Pick<
    ConversationTurnDependencies["effects"],
    "createReferenceDocument"
  >;
};

/**
 * A conversation that may own a run is told to launch one. A project
 * conversation has no session to launch into, a finished session takes no new
 * run, and a run seat cannot own a run, so each keeps the one-shot
 * `cctl agent run` hint.
 */
async function delegationHint(
  execution: RuntimeInstructionDependencies["execution"],
  input: Pick<ExecutePromptInput, "projectPath" | "target">,
  sessionState: SessionState | null,
): Promise<string> {
  if (
    input.target.scope === "project" ||
    sessionState === null ||
    sessionState.finished
  )
    return execution.getCodexToolPromptHint();
  const conversation = await execution.getConversation(
    input.projectPath,
    input.target.sessionName,
    input.target.conversationId,
  );
  return conversation !== null &&
    isEligibleOwner(conversation, sessionState.archived)
    ? execution.getRunToolPromptHint()
    : execution.getCodexToolPromptHint();
}

export async function readRuntimeInstructions(
  deps: Pick<RuntimeInstructionDependencies, "execution" | "context">,
  input: Pick<ExecutePromptInput, "projectPath" | "worktreePath" | "target"> & {
    turn: Pick<
      ExecutePromptInput["turn"],
      "askUserQuestionsEnabled" | "autonomous"
    >;
  },
  profile: AdmittedConversationProfile | undefined,
) {
  const isProjectConversation = input.target.scope === "project";
  const sessionState = await deps.execution.getSessionState(
    input.projectPath,
    conversationTargetStoreSessionName(input.target),
  );

  // Build reference documents system prompt section
  const referenceDocs = isProjectConversation
    ? []
    : await deps.context.getReferenceDocuments(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
      );
  const referenceDocsPrompt =
    referenceDocs.length > 0
      ? [
          "## Reference Documents",
          "The following reference documents provide additional context. Read them when relevant to your current task.",
          "",
          ...referenceDocs.map((d) => `- **${d.filePath}**: ${d.description}`),
        ].join("\n")
      : null;

  // Alignment governs only attended normal sessions (R12.1/R12.2). Return
  // eligibility with the instructions for the post-turn seen-version record.
  const alignment = await resolveAlignmentInstructionForNewRuntime(
    deps.context,
    {
      projectPath: input.projectPath,
      sessionName: conversationTargetStoreSessionName(input.target),
      creationMode: sessionState?.creationMode,
      isProjectConversation,
      autonomous: input.turn.autonomous,
    },
  );
  const activeAlignmentVersion = alignment.activeAlignmentVersion;
  const alignmentInstruction = alignment.alignmentInstruction;

  // The conversation's agent profile, replayed from its snapshot (R6). Null
  // for a legacy conversation, which therefore receives no injection (R6.5).
  // Both scopes read the same way: `getConversation` is session-keyed storage
  // and the sentinel addresses the project repo.
  const profileInjection =
    profile ??
    (await resolveConversationProfileInjection(deps.execution, {
      projectPath: input.projectPath,
      sessionName: conversationTargetStoreSessionName(input.target),
      conversationId: input.target.conversationId,
    }));

  const workflowLaneInstructions = isProjectConversation
    ? null
    : await deps.context.getWorkflowLaneInstructions({
        projectPath: input.projectPath,
        sessionName: conversationTargetStoreSessionName(input.target),
        conversationId: input.target.conversationId,
      });

  // Build session instructions (baked into the runtime once). Project
  // conversations run in the main worktree, so they use a CC context that
  // omits the per-session dev-server promise.
  const ccContext = isProjectConversation ? PROJECT_CC_CONTEXT : CC_CONTEXT;
  const beforeProfile = [
    ccContext,
    // `cctl ask` works for session and project conversations alike, so the
    // ask-at-real-forks encouragement applies to every CC agent. Workflow
    // lanes whose effective toggle is on get the enabled variant (tool
    // available, protocol, context pauses); everyone else keeps the default.
    selectAskQuestionInstructions(input.turn.askUserQuestionsEnabled),
    // cctl is on PATH for every CC agent (session env contract), so the
    // CLI nudge applies to session and project conversations alike.
    CC_CLI_INSTRUCTIONS,
    // The static half of memory delivery (spec `memory` R5.4, D4): advisory
    // framing, verification duty, and capture bar, delivered once through
    // each backend's privileged instruction channel. The changing
    // <memory-index> block is a per-turn prompt prefix and must never be
    // baked in here — Codex and Cursor read these instructions on turn one only.
    MEMORY_ADVISORY_CONTRACT,
    // Spawn-proposal convention is a project-conversation-only capability:
    // session agents cannot propose sibling sessions from a conversation.
    isProjectConversation ? PROJECT_SPAWN_INSTRUCTIONS : null,
    alignmentInstruction,
    sessionState?.tddEnabled ? TDD_INSTRUCTIONS : null,
    await delegationHint(deps.execution, input, sessionState),
    referenceDocsPrompt,
    workflowLaneInstructions,
  ].filter((s): s is string => s != null && s.length > 0);

  const sessionInstructions = [
    ...beforeProfile,
    // LAST by design. The profile is level 5 of the composer's precedence
    // contract — a subordinate specialization lens — so it is delivered after
    // every CC-owned layer it must not override.
    profileInjection.instructionBlock,
  ].filter((s): s is string => s != null && s.length > 0);
  return {
    repeatableInstructions: sessionInstructions,
    alignmentEligible: alignment.eligible,
    alignmentVersion: activeAlignmentVersion,
  };
}

export async function prepareRuntimeInstructions(
  deps: RuntimeInstructionDependencies,
  input: Pick<ExecutePromptInput, "projectPath" | "worktreePath" | "target"> & {
    turn: Pick<
      ExecutePromptInput["turn"],
      "askUserQuestionsEnabled" | "autonomous"
    >;
  },
  profile: AdmittedConversationProfile | undefined,
) {
  const isProjectConversation = input.target.scope === "project";
  // Project conversations are session-less: the focus-memory registration and
  // reference-document loading are session-scoped (they read/write through the
  // session aggregate, which the project sentinel cannot address — a write
  // would fail because `__project__` is not a real session). Skip both for a
  // project turn so a repo-root with `memory-bank/focus.md` does not break
  // turn startup.
  if (!isProjectConversation) {
    await registerFocusMemoryIfPresent({
      worktreePath: input.worktreePath,
      projectPath: input.projectPath,
      sessionName: conversationTargetStoreSessionName(input.target),
      conversationId: input.target.conversationId,
      fileExists: deps.execution.fileExists,
      registerReferenceDocument: deps.effects.createReferenceDocument,
    });
  }

  const projection = await readRuntimeInstructions(deps, input, profile);
  return {
    ...projection,
    sessionInstructions: projection.repeatableInstructions,
  };
}

/**
 * The runtime host's two instruction readers: `instructions` prepares a
 * turn's runtime (registering the session's focus memory first), and
 * `readInstructions` reads the same composition at rest for a reader outside
 * a turn, the memory index preview (design C5b §5), writing nothing.
 */
export function createRuntimeInstructionReaders(
  deps: RuntimeInstructionDependencies,
): Pick<RuntimeHostDeps, "instructions" | "readInstructions"> {
  const inputOf = (
    conversation: HostedConversation,
    selection: RuntimeRequirements["instructionSelection"],
  ) => ({
    projectPath: conversation.projectPath,
    worktreePath: conversation.worktreePath,
    target: conversation.target,
    turn: selection,
  });
  return {
    async instructions(conversation, selection) {
      const prepared = await prepareRuntimeInstructions(
        deps,
        inputOf(conversation, selection),
        conversation.profile,
      );
      return {
        sessionInstructions: prepared.sessionInstructions,
        alignmentVersion: prepared.alignmentVersion,
        alignmentEligible: prepared.alignmentEligible,
      };
    },
    async readInstructions(conversation, selection) {
      const read = await readRuntimeInstructions(
        deps,
        inputOf(conversation, selection),
        conversation.profile,
      );
      return {
        sessionInstructions: read.repeatableInstructions,
        alignmentVersion: read.alignmentVersion,
        alignmentEligible: read.alignmentEligible,
      };
    },
  };
}
