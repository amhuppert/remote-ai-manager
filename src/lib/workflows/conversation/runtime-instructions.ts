import type { ConversationActorDependencies } from "./actor-dependencies";
import type { ExecutePromptInput } from "./types";
import type { AdmittedConversationProfile } from "@/lib/conversations/profile-admission";
import { conversationTargetStoreSessionName } from "@/lib/conversations/conversation-target";
import {
  CC_CONTEXT,
  CC_CLI_INSTRUCTIONS,
  TDD_INSTRUCTIONS,
  selectAskQuestionInstructions,
} from "@/lib/prompt/sdk-driver";
import {
  PROJECT_CC_CONTEXT,
  PROJECT_SPAWN_INSTRUCTIONS,
} from "@/lib/project-conversations/system-prompt";
import { MEMORY_ADVISORY_CONTRACT } from "@/lib/memory/advisory-contract";
import { registerFocusMemoryIfPresent } from "./pre-turn/focus-memory";
import { resolveAlignmentInstructionForNewRuntime } from "./pre-turn/alignment-gate";
import { resolveConversationProfileInjection } from "./pre-turn/profile-injection";
import {
  readPendingAgentNotices,
  buildPendingNoticesInstruction,
  drainConsumedAgentNotices,
} from "./pre-turn/notices-drain";

type RuntimeInstructionDependencies = {
  execution: Pick<
    ConversationActorDependencies["execution"],
    | "getSessionState"
    | "fileExists"
    | "getConversation"
    | "getCodexToolPromptHint"
  >;
  context: Pick<
    ConversationActorDependencies["context"],
    "getReferenceDocuments" | "getActiveAlignmentInjection"
  >;
  effects: Pick<
    ConversationActorDependencies["effects"],
    "createReferenceDocument" | "mutateConversation"
  >;
};

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
    deps.execution.getCodexToolPromptHint(),
    referenceDocsPrompt,
  ].filter((s): s is string => s != null && s.length > 0);

  function renderSessionInstructions(notices?: string | null): string[] {
    return [
      ...beforeProfile,
      notices,
      // LAST by design. The profile is level 5 of the composer's precedence
      // contract — a subordinate specialization lens — so it is delivered after
      // every CC-owned layer it must not override.
      profileInjection.instructionBlock,
    ].filter((s): s is string => s != null && s.length > 0);
  }
  return {
    repeatableInstructions: renderSessionInstructions(),
    renderSessionInstructions,
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
  // Pending agent notices — messages recorded while the conversation had no
  // live backend session (e.g. background tasks lost with a dead session).
  // Injected into this runtime's instructions and drained below once the
  // runtime exists, so a notice is delivered exactly once.
  const pendingAgentNotices = isProjectConversation
    ? []
    : await readPendingAgentNotices(deps.execution, {
        projectPath: input.projectPath,
        sessionName: conversationTargetStoreSessionName(input.target),
        conversationId: input.target.conversationId,
      });
  const pendingNoticesInstruction =
    buildPendingNoticesInstruction(pendingAgentNotices);

  return {
    ...projection,
    sessionInstructions: projection.renderSessionInstructions(
      pendingNoticesInstruction,
    ),
    async consumeNotices() {
      if (isProjectConversation) return;
      await drainConsumedAgentNotices(
        deps.effects,
        {
          projectPath: input.projectPath,
          sessionName: conversationTargetStoreSessionName(input.target),
          conversationId: input.target.conversationId,
        },
        pendingAgentNotices,
      );
    },
  };
}
