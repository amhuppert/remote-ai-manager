// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHotkeyDispatcher, type HotkeyEventContext } from "./dispatcher";

const PAGE_CONTEXT: HotkeyEventContext = {
  editable: false,
  overlayOpen: false,
  promptId: null,
};

const PROMPT_CONTEXT: HotkeyEventContext = {
  editable: true,
  overlayOpen: false,
  promptId: "prompt-a",
};

function press(
  key: string,
  {
    code,
    ctrlKey = false,
    metaKey = false,
    altKey = false,
    shiftKey = false,
    repeat = false,
    isComposing = false,
  }: {
    code: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    repeat?: boolean;
    isComposing?: boolean;
  },
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    code,
    ctrlKey,
    metaKey,
    altKey,
    shiftKey,
    repeat,
    isComposing,
    bubbles: true,
    cancelable: true,
  });
}

function release(key: string, code: string, ctrlKey: boolean): KeyboardEvent {
  return new KeyboardEvent("keyup", {
    key,
    code,
    ctrlKey,
    bubbles: true,
    cancelable: true,
  });
}

function armOneShot(
  dispatcher: ReturnType<typeof createHotkeyDispatcher>,
): void {
  const activation = press(";", {
    code: "Semicolon",
    ctrlKey: true,
  });
  dispatcher.handleKeyDown(activation, PROMPT_CONTEXT);
  dispatcher.handleKeyUp(release(";", "Semicolon", true));
  dispatcher.handleKeyUp(release("Control", "ControlLeft", false));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createHotkeyDispatcher", () => {
  it("invokes an available direct command outside editors and consumes the key", () => {
    const dispatcher = createHotkeyDispatcher();
    const toggleSidebar = vi.fn();
    dispatcher.register("toggleSidebar", toggleSidebar);

    const event = press("b", { code: "KeyB" });
    dispatcher.handleKeyDown(event, PAGE_CONTEXT);

    expect(toggleSidebar).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(dispatcher.getSnapshot().mode).toBe("idle");
  });

  it("does not consume normal app hotkeys while an editor has focus", () => {
    const dispatcher = createHotkeyDispatcher();
    const toggleSidebar = vi.fn();
    dispatcher.register("toggleSidebar", toggleSidebar);

    const event = press("b", { code: "KeyB" });
    dispatcher.handleKeyDown(event, PROMPT_CONTEXT);

    expect(toggleSidebar).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("executes a leader sequence and exposes the pending prefix", () => {
    const dispatcher = createHotkeyDispatcher();
    const switchProject = vi.fn();
    dispatcher.register("switchProject", switchProject);

    const leader = press("g", { code: "KeyG" });
    dispatcher.handleKeyDown(leader, PAGE_CONTEXT);

    expect(leader.defaultPrevented).toBe(true);
    expect(dispatcher.getSnapshot()).toMatchObject({
      mode: "leader",
      prefix: ["g"],
    });

    const command = press("p", { code: "KeyP" });
    dispatcher.handleKeyDown(command, PAGE_CONTEXT);

    expect(switchProject).toHaveBeenCalledOnce();
    expect(command.defaultPrevented).toBe(true);
    expect(dispatcher.getSnapshot().mode).toBe("idle");
  });

  it("times out an unfinished normal leader without invoking a command", () => {
    vi.useFakeTimers();
    const dispatcher = createHotkeyDispatcher();
    const switchProject = vi.fn();
    dispatcher.register("switchProject", switchProject);

    dispatcher.handleKeyDown(press("g", { code: "KeyG" }), PAGE_CONTEXT);
    vi.advanceTimersByTime(1_001);

    expect(dispatcher.getSnapshot().mode).toBe("idle");
    expect(switchProject).not.toHaveBeenCalled();
  });

  it("arms one complete command from a focused prompt with literal Control+;", () => {
    const dispatcher = createHotkeyDispatcher();
    const expand = vi.fn();
    dispatcher.register("expandThinkingBlocks", expand);

    const activation = press(";", {
      code: "Semicolon",
      ctrlKey: true,
    });
    dispatcher.handleKeyDown(activation, PROMPT_CONTEXT);

    expect(activation.defaultPrevented).toBe(true);
    expect(dispatcher.getSnapshot()).toMatchObject({
      mode: "one-shot",
      promptId: "prompt-a",
      awaitingActivationRelease: true,
    });

    dispatcher.handleKeyUp(release(";", "Semicolon", true));
    dispatcher.handleKeyUp(release("Control", "ControlLeft", false));

    const command = press("E", {
      code: "KeyE",
      shiftKey: true,
    });
    dispatcher.handleKeyDown(command, PROMPT_CONTEXT);

    expect(expand).toHaveBeenCalledOnce();
    expect(command.defaultPrevented).toBe(true);
    expect(dispatcher.getSnapshot().mode).toBe("idle");
  });

  it("keeps one-shot mode armed through a complete leader sequence", () => {
    const dispatcher = createHotkeyDispatcher();
    const switchProject = vi.fn();
    dispatcher.register("switchProject", switchProject);
    armOneShot(dispatcher);

    const leader = press("g", { code: "KeyG" });
    dispatcher.handleKeyDown(leader, PROMPT_CONTEXT);
    expect(leader.defaultPrevented).toBe(true);
    expect(dispatcher.getSnapshot()).toMatchObject({
      mode: "one-shot",
      prefix: ["g"],
    });

    const command = press("p", { code: "KeyP" });
    dispatcher.handleKeyDown(command, PROMPT_CONTEXT);

    expect(switchProject).toHaveBeenCalledOnce();
    expect(command.defaultPrevented).toBe(true);
    expect(dispatcher.getSnapshot().mode).toBe("idle");
  });

  it("cancels one-shot mode and lets invalid printable input reach the editor", () => {
    const dispatcher = createHotkeyDispatcher();
    dispatcher.register("switchProject", vi.fn());
    armOneShot(dispatcher);

    const invalid = press("z", { code: "KeyZ" });
    dispatcher.handleKeyDown(invalid, PROMPT_CONTEXT);

    expect(invalid.defaultPrevented).toBe(false);
    expect(dispatcher.getSnapshot().mode).toBe("idle");
  });

  it("cancels one-shot mode with Escape without invoking page Escape commands", () => {
    const dispatcher = createHotkeyDispatcher();
    const exitPanes = vi.fn();
    dispatcher.register("exitPanes", exitPanes);
    armOneShot(dispatcher);

    const escape = press("Escape", { code: "Escape" });
    dispatcher.handleKeyDown(escape, PROMPT_CONTEXT);

    expect(escape.defaultPrevented).toBe(true);
    expect(exitPanes).not.toHaveBeenCalled();
    expect(dispatcher.getSnapshot().mode).toBe("idle");
  });

  it("waits for the activation chord to be released before accepting a command", () => {
    const dispatcher = createHotkeyDispatcher();
    const closeTab = vi.fn();
    dispatcher.register("closeConversationTab", closeTab);

    dispatcher.handleKeyDown(
      press(";", { code: "Semicolon", ctrlKey: true }),
      PROMPT_CONTEXT,
    );

    const rolledKey = press("x", { code: "KeyX", ctrlKey: true });
    dispatcher.handleKeyDown(rolledKey, PROMPT_CONTEXT);

    expect(closeTab).not.toHaveBeenCalled();
    expect(rolledKey.defaultPrevented).toBe(false);
    expect(dispatcher.getSnapshot().mode).toBe("one-shot");
  });

  it("ignores repeat and composition events", () => {
    const dispatcher = createHotkeyDispatcher();
    const closeTab = vi.fn();
    dispatcher.register("closeConversationTab", closeTab);

    const repeated = press("x", { code: "KeyX", repeat: true });
    dispatcher.handleKeyDown(repeated, PAGE_CONTEXT);
    const composing = press("x", {
      code: "KeyX",
      isComposing: true,
    });
    dispatcher.handleKeyDown(composing, PAGE_CONTEXT);

    expect(closeTab).not.toHaveBeenCalled();
    expect(repeated.defaultPrevented).toBe(false);
    expect(composing.defaultPrevented).toBe(false);
  });

  it("suppresses page commands while an overlay is open", () => {
    const dispatcher = createHotkeyDispatcher();
    const closeTab = vi.fn();
    dispatcher.register("closeConversationTab", closeTab);

    const event = press("x", { code: "KeyX" });
    dispatcher.handleKeyDown(event, {
      ...PAGE_CONTEXT,
      overlayOpen: true,
    });

    expect(closeTab).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("allows an explicitly overlay-scoped command while an overlay is open", () => {
    const dispatcher = createHotkeyDispatcher();
    const voice = vi.fn();
    dispatcher.register("voiceToggle", voice, {
      keepActiveInOverlay: true,
    });

    const event = press(".", {
      code: "Period",
      ctrlKey: true,
      shiftKey: true,
    });
    dispatcher.handleKeyDown(event, {
      ...PROMPT_CONTEXT,
      overlayOpen: true,
    });

    expect(voice).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("matches exact shifted commands before unshifted leader prefixes", () => {
    const dispatcher = createHotkeyDispatcher();
    const collapse = vi.fn();
    const newConversation = vi.fn();
    dispatcher.register("collapseThinkingBlocks", collapse);
    dispatcher.register("newConversation", newConversation);

    const event = press("C", {
      code: "KeyC",
      shiftKey: true,
    });
    dispatcher.handleKeyDown(event, PAGE_CONTEXT);

    expect(collapse).toHaveBeenCalledOnce();
    expect(newConversation).not.toHaveBeenCalled();
    expect(dispatcher.getSnapshot().mode).toBe("idle");
  });

  it("does not consume a registered command when its handler is disabled", () => {
    const dispatcher = createHotkeyDispatcher();
    const closeTab = vi.fn();
    dispatcher.register("closeConversationTab", closeTab, { enabled: false });

    const event = press("x", { code: "KeyX" });
    dispatcher.handleKeyDown(event, PAGE_CONTEXT);

    expect(closeTab).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("disarms one-shot and falls through when a command is unavailable", () => {
    const dispatcher = createHotkeyDispatcher();
    const closeTab = vi.fn();
    dispatcher.register("closeConversationTab", closeTab, {
      isAvailable: () => false,
    });
    armOneShot(dispatcher);

    const event = press("x", { code: "KeyX" });
    dispatcher.handleKeyDown(event, PROMPT_CONTEXT);

    expect(closeTab).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(dispatcher.getSnapshot().mode).toBe("idle");
  });

  it("fails closed when two active handlers register the same command", () => {
    const dispatcher = createHotkeyDispatcher();
    const first = vi.fn();
    const second = vi.fn();
    dispatcher.register("toggleSidebar", first);
    dispatcher.register("toggleSidebar", second);

    const event = press("b", { code: "KeyB" });
    dispatcher.handleKeyDown(event, PAGE_CONTEXT);

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("contains and logs callback failures from launcher invocation", () => {
    const error = vi.fn();
    const dispatcher = createHotkeyDispatcher({
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error,
      },
    });
    dispatcher.register("toggleSidebar", () => {
      throw new Error("launcher failed");
    });

    expect(dispatcher.invoke("toggleSidebar", PAGE_CONTEXT)).toBe(true);
    expect(error).toHaveBeenCalledWith("hotkey.command.failed", {
      commandId: "toggleSidebar",
      error: "launcher failed",
      source: "launcher",
    });
  });

  it("stops considering a handler after its registration is cleaned up", () => {
    const dispatcher = createHotkeyDispatcher();
    const callback = vi.fn();
    const unregister = dispatcher.register("toggleSidebar", callback);
    unregister();

    const event = press("b", { code: "KeyB" });
    dispatcher.handleKeyDown(event, PAGE_CONTEXT);

    expect(callback).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not time out an armed one-shot layer", () => {
    vi.useFakeTimers();
    const dispatcher = createHotkeyDispatcher();
    const switchProject = vi.fn();
    dispatcher.register("switchProject", switchProject);
    armOneShot(dispatcher);

    vi.advanceTimersByTime(60_000);
    dispatcher.handleKeyDown(press("g", { code: "KeyG" }), PROMPT_CONTEXT);
    vi.advanceTimersByTime(60_000);
    dispatcher.handleKeyDown(press("p", { code: "KeyP" }), PROMPT_CONTEXT);

    expect(switchProject).toHaveBeenCalledOnce();
  });

  it("cancels one-shot with a second literal Control+; chord", () => {
    const dispatcher = createHotkeyDispatcher();
    armOneShot(dispatcher);

    const event = press(";", {
      code: "Semicolon",
      ctrlKey: true,
    });
    dispatcher.handleKeyDown(event, PROMPT_CONTEXT);

    expect(event.defaultPrevented).toBe(true);
    expect(dispatcher.getSnapshot().mode).toBe("idle");
  });

  it("cancels one-shot when focus moves to a different prompt", () => {
    const dispatcher = createHotkeyDispatcher();
    const closeTab = vi.fn();
    dispatcher.register("closeConversationTab", closeTab);
    armOneShot(dispatcher);

    const event = press("x", { code: "KeyX" });
    dispatcher.handleKeyDown(event, {
      ...PROMPT_CONTEXT,
      promptId: "prompt-b",
    });

    expect(closeTab).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(dispatcher.getSnapshot().mode).toBe("idle");
  });

  it("ignores modifier-only keys while one-shot is armed", () => {
    const dispatcher = createHotkeyDispatcher();
    armOneShot(dispatcher);

    dispatcher.handleKeyDown(
      press("Shift", { code: "ShiftLeft", shiftKey: true }),
      PROMPT_CONTEXT,
    );

    expect(dispatcher.getSnapshot().mode).toBe("one-shot");
  });

  it("runs direct prompt Control commands without arming", () => {
    const dispatcher = createHotkeyDispatcher();
    const stop = vi.fn();
    const voice = vi.fn();
    dispatcher.register("stopTurn", stop);
    dispatcher.register("voiceToggle", voice);

    const stopEvent = press(".", {
      code: "Period",
      ctrlKey: true,
    });
    dispatcher.handleKeyDown(stopEvent, PROMPT_CONTEXT);
    const voiceEvent = press(".", {
      code: "Period",
      ctrlKey: true,
      shiftKey: true,
    });
    dispatcher.handleKeyDown(voiceEvent, PROMPT_CONTEXT);

    expect(stop).toHaveBeenCalledOnce();
    expect(voice).toHaveBeenCalledOnce();
    expect(stopEvent.defaultPrevented).toBe(true);
    expect(voiceEvent.defaultPrevented).toBe(true);
  });
});
