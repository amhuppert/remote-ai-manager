import { createClientLogger } from "@/lib/logging/client-logger";
import type { HotkeyEventContext } from "./dispatcher";

const logger = createClientLogger("hotkey-prompt-focus");
const ACTIVE_PROMPT_SELECTOR = '[contenteditable="true"][data-cc-prompt-id]';

export function isPromptEventTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest(ACTIVE_PROMPT_SELECTOR) !== null
  );
}

export function shouldRestoreActivePromptFocus(
  target: EventTarget | null,
  context: HotkeyEventContext,
): boolean {
  return context.promptId !== null || isPromptEventTarget(target);
}

export function scheduleActivePromptFocus(): void {
  window.setTimeout(() => {
    const prompt = document.querySelector<HTMLElement>(ACTIVE_PROMPT_SELECTOR);
    if (!prompt) {
      logger.debug("hotkey.prompt_focus.restore_skipped", {
        reason: "no_active_prompt",
      });
      return;
    }
    prompt.focus({ preventScroll: true });
    logger.debug("hotkey.prompt_focus.restored", {
      promptId: prompt.dataset.ccPromptId ?? null,
    });
  }, 0);
}
