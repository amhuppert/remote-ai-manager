import {
  getHotkeySequences,
  HOTKEY_REGISTRY,
  isMacOS,
  type HotkeyDefinition,
  type HotkeyId,
} from "@/lib/shared/hotkeys";
import {
  createClientLogger,
  type ClientLogger,
} from "@/lib/logging/client-logger";

export interface HotkeyEventContext {
  readonly editable: boolean;
  readonly overlayOpen: boolean;
  readonly promptId: string | null;
}

export interface HotkeyInvocation {
  readonly id: HotkeyId;
  readonly event: KeyboardEvent | null;
  readonly context: HotkeyEventContext;
  readonly source: "keyboard" | "launcher";
}

export interface HotkeyRegistrationOptions {
  readonly enabled?: boolean;
  readonly keepActiveInOverlay?: boolean;
  readonly isAvailable?: (invocation: HotkeyInvocation) => boolean;
}

export interface HotkeySnapshot {
  readonly mode: "idle" | "leader" | "one-shot";
  readonly prefix: readonly string[];
  readonly promptId: string | null;
  readonly awaitingActivationRelease: boolean;
}

export interface HotkeyCommandView {
  readonly definition: HotkeyDefinition;
  readonly registered: boolean;
  readonly available: boolean;
}

interface Registration {
  readonly registrationId: number;
  readonly execute: (
    event: KeyboardEvent,
    invocation: HotkeyInvocation,
  ) => void;
  readonly options: HotkeyRegistrationOptions;
}

interface ResolvedRegistration {
  readonly registration: Registration | null;
  readonly ambiguous: boolean;
}

interface Match {
  readonly id: HotkeyId;
  readonly registration: Registration;
}

export interface HotkeyDispatcher {
  register(
    id: HotkeyId,
    execute: (event: KeyboardEvent, invocation: HotkeyInvocation) => void,
    options?: HotkeyRegistrationOptions,
  ): () => void;
  handleKeyDown(event: KeyboardEvent, context: HotkeyEventContext): void;
  handleKeyUp(event: KeyboardEvent): void;
  cancel(reason?: string): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): HotkeySnapshot;
  getCommands(context?: HotkeyEventContext): readonly HotkeyCommandView[];
  invoke(id: HotkeyId, context?: HotkeyEventContext): boolean;
}

interface CreateHotkeyDispatcherOptions {
  readonly leaderTimeoutMs?: number;
  readonly logger?: ClientLogger;
}

const IDLE_SNAPSHOT: HotkeySnapshot = {
  mode: "idle",
  prefix: [],
  promptId: null,
  awaitingActivationRelease: false,
};

const EMPTY_CONTEXT: HotkeyEventContext = {
  editable: false,
  overlayOpen: false,
  promptId: null,
};

const MODIFIER_KEYS = new Set(["alt", "altgraph", "control", "meta", "shift"]);

const SHIFTED_BASE_KEYS: Record<string, string> = {
  "?": "/",
  ">": ".",
  "<": ",",
  ":": ";",
  "{": "[",
  "}": "]",
  "|": "\\",
};

function normalizeDefinitionStroke(stroke: string): string {
  const parts = stroke.toLowerCase().split("+");
  return parts
    .map((part) => {
      if (part !== "mod") return part;
      return isMacOS() ? "meta" : "ctrl";
    })
    .join("+");
}

function eventStroke(event: KeyboardEvent): string | null {
  if (
    event.key === "Process" ||
    event.keyCode === 229 ||
    event.getModifierState?.("AltGraph")
  ) {
    return null;
  }

  const rawKey = event.key.toLowerCase();
  if (MODIFIER_KEYS.has(rawKey)) return null;

  let key = rawKey === " " ? "space" : rawKey;
  if (event.shiftKey) key = SHIFTED_BASE_KEYS[key] ?? key;

  const parts: string[] = [];
  if (event.ctrlKey) parts.push("ctrl");
  if (event.metaKey) parts.push("meta");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

function isActivationStroke(stroke: string | null): boolean {
  return stroke === "ctrl+;";
}

function consume(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

export function createHotkeyDispatcher(
  options: CreateHotkeyDispatcherOptions = {},
): HotkeyDispatcher {
  const logger = options.logger ?? createClientLogger("hotkey-dispatcher");
  const leaderTimeoutMs = options.leaderTimeoutMs ?? 1_000;
  const registrations = new Map<HotkeyId, Map<number, Registration>>();
  const listeners = new Set<() => void>();
  let registrationCounter = 0;
  let snapshot = IDLE_SNAPSHOT;
  let leaderTimer: ReturnType<typeof setTimeout> | null = null;
  let activationControlDown = false;
  let activationSemicolonDown = false;
  let lastContext = EMPTY_CONTEXT;

  function emitSnapshot(next: HotkeySnapshot): void {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function clearLeaderTimer(): void {
    if (leaderTimer === null) return;
    clearTimeout(leaderTimer);
    leaderTimer = null;
  }

  function cancel(reason = "cancelled"): void {
    clearLeaderTimer();
    activationControlDown = false;
    activationSemicolonDown = false;
    if (snapshot.mode === "idle") return;
    logger.debug("hotkey.pending.cancelled", {
      mode: snapshot.mode,
      prefix: snapshot.prefix.join(">"),
      reason,
    });
    emitSnapshot(IDLE_SNAPSHOT);
  }

  function isRegistrationAvailable(
    id: HotkeyId,
    registration: Registration,
    context: HotkeyEventContext,
    event: KeyboardEvent | null,
    source: HotkeyInvocation["source"],
  ): boolean {
    if (registration.options.enabled === false) {
      return false;
    }
    if (
      context.overlayOpen &&
      source === "keyboard" &&
      !registration.options.keepActiveInOverlay
    ) {
      return false;
    }
    if (!registration.options.isAvailable) return true;
    return registration.options.isAvailable({
      id,
      event,
      context,
      source,
    });
  }

  function resolveRegistration(
    id: HotkeyId,
    context: HotkeyEventContext,
    event: KeyboardEvent | null,
    source: HotkeyInvocation["source"],
  ): ResolvedRegistration {
    const commandRegistrations = registrations.get(id);
    if (!commandRegistrations) {
      return { registration: null, ambiguous: false };
    }

    const available = [...commandRegistrations.values()].filter(
      (registration) =>
        isRegistrationAvailable(id, registration, context, event, source),
    );
    if (available.length === 1) {
      return { registration: available[0] ?? null, ambiguous: false };
    }
    return {
      registration: null,
      ambiguous: available.length > 1,
    };
  }

  function commandMatches(
    prefix: readonly string[],
    context: HotkeyEventContext,
    event: KeyboardEvent,
    oneShot: boolean,
  ): { exact: Match[]; hasPrefix: boolean; ambiguousIds: HotkeyId[] } {
    const exact: Match[] = [];
    const ambiguousIds: HotkeyId[] = [];
    let hasPrefix = false;

    for (const definition of Object.values(HOTKEY_REGISTRY)) {
      if (context.editable && !oneShot && !definition.allowInEditable) {
        continue;
      }

      const resolved = resolveRegistration(
        definition.id,
        context,
        event,
        "keyboard",
      );
      if (!resolved.registration) {
        if (resolved.ambiguous) ambiguousIds.push(definition.id);
        continue;
      }

      for (const sequence of getHotkeySequences(definition.keys)) {
        const normalizedSequence = sequence.map(normalizeDefinitionStroke);
        if (
          prefix.some((stroke, index) => normalizedSequence[index] !== stroke)
        ) {
          continue;
        }
        if (normalizedSequence.length === prefix.length) {
          exact.push({
            id: definition.id,
            registration: resolved.registration,
          });
        } else if (normalizedSequence.length > prefix.length) {
          hasPrefix = true;
        }
      }
    }

    return { exact, hasPrefix, ambiguousIds };
  }

  function startLeader(
    prefix: readonly string[],
    context: HotkeyEventContext,
  ): void {
    clearLeaderTimer();
    emitSnapshot({
      mode: "leader",
      prefix,
      promptId: null,
      awaitingActivationRelease: false,
    });
    leaderTimer = setTimeout(() => {
      logger.debug("hotkey.leader.timed_out", {
        prefix: prefix.join(">"),
      });
      emitSnapshot(IDLE_SNAPSHOT);
      leaderTimer = null;
    }, leaderTimeoutMs);
    lastContext = context;
  }

  function updateOneShotPrefix(prefix: readonly string[]): void {
    emitSnapshot({
      ...snapshot,
      prefix,
    });
  }

  function executeRegistration(
    id: HotkeyId,
    registration: Registration,
    event: KeyboardEvent,
    context: HotkeyEventContext,
    source: HotkeyInvocation["source"],
  ): void {
    logger.info("hotkey.command.invoked", {
      commandId: id,
      source,
    });
    try {
      registration.execute(event, {
        id,
        event,
        context,
        source,
      });
    } catch (error) {
      logger.error("hotkey.command.failed", {
        commandId: id,
        error: error instanceof Error ? error.message : String(error),
        source,
      });
    }
  }

  function invokeKeyboardMatch(
    match: Match,
    event: KeyboardEvent,
    context: HotkeyEventContext,
  ): void {
    clearLeaderTimer();
    emitSnapshot(IDLE_SNAPSHOT);
    consume(event);
    executeRegistration(
      match.id,
      match.registration,
      event,
      context,
      "keyboard",
    );
  }

  function armOneShot(event: KeyboardEvent, context: HotkeyEventContext): void {
    consume(event);
    clearLeaderTimer();
    activationControlDown = true;
    activationSemicolonDown = true;
    emitSnapshot({
      mode: "one-shot",
      prefix: [],
      promptId: context.promptId,
      awaitingActivationRelease: true,
    });
    logger.info("hotkey.one_shot.armed", {
      promptId: context.promptId,
    });
  }

  function handlePendingStroke(
    event: KeyboardEvent,
    context: HotkeyEventContext,
    stroke: string,
  ): void {
    const oneShot = snapshot.mode === "one-shot";

    if (oneShot && isActivationStroke(stroke)) {
      consume(event);
      cancel("activation_repeated");
      return;
    }

    if (oneShot && snapshot.awaitingActivationRelease) return;

    if (stroke === "escape") {
      consume(event);
      cancel("escape");
      return;
    }

    const prefix = [...snapshot.prefix, stroke];
    const matches = commandMatches(prefix, context, event, oneShot);

    if (matches.exact.length === 1) {
      const match = matches.exact[0];
      if (match) invokeKeyboardMatch(match, event, context);
      return;
    }

    if (matches.exact.length > 1 || matches.ambiguousIds.length > 0) {
      logger.warn("hotkey.command.ambiguous", {
        commandIds: [
          ...matches.exact.map((match) => match.id),
          ...matches.ambiguousIds,
        ],
        sequence: prefix.join(">"),
      });
      cancel("ambiguous");
      return;
    }

    if (matches.hasPrefix) {
      consume(event);
      if (oneShot) {
        updateOneShotPrefix(prefix);
      } else {
        startLeader(prefix, context);
      }
      return;
    }

    cancel("invalid");
  }

  function handleKeyDown(
    event: KeyboardEvent,
    context: HotkeyEventContext,
  ): void {
    lastContext = context;
    if (event.repeat || event.isComposing) return;

    const stroke = eventStroke(event);
    if (!stroke) return;

    if (context.overlayOpen && snapshot.mode !== "idle") {
      cancel("overlay_open");
      return;
    }

    if (
      snapshot.mode === "one-shot" &&
      snapshot.promptId !== context.promptId
    ) {
      cancel("prompt_changed");
    }

    if (
      snapshot.mode === "idle" &&
      isActivationStroke(stroke) &&
      context.editable &&
      context.promptId !== null
    ) {
      armOneShot(event, context);
      return;
    }

    if (snapshot.mode !== "idle") {
      handlePendingStroke(event, context, stroke);
      return;
    }

    const matches = commandMatches([stroke], context, event, false);
    if (matches.exact.length === 1) {
      const match = matches.exact[0];
      if (match) invokeKeyboardMatch(match, event, context);
      return;
    }

    if (matches.exact.length > 1 || matches.ambiguousIds.length > 0) {
      logger.warn("hotkey.command.ambiguous", {
        commandIds: [
          ...matches.exact.map((match) => match.id),
          ...matches.ambiguousIds,
        ],
        sequence: stroke,
      });
      return;
    }

    if (matches.hasPrefix) {
      consume(event);
      startLeader([stroke], context);
    }
  }

  function handleKeyUp(event: KeyboardEvent): void {
    if (snapshot.mode !== "one-shot") return;

    if (event.key === ";" || event.code === "Semicolon") {
      activationSemicolonDown = false;
    }
    if (event.key === "Control" || event.code.startsWith("Control")) {
      activationControlDown = false;
    }
    const awaitingActivationRelease =
      activationControlDown || activationSemicolonDown;
    if (awaitingActivationRelease === snapshot.awaitingActivationRelease) {
      return;
    }
    emitSnapshot({
      ...snapshot,
      awaitingActivationRelease,
    });
  }

  function register(
    id: HotkeyId,
    execute: (event: KeyboardEvent, invocation: HotkeyInvocation) => void,
    registrationOptions: HotkeyRegistrationOptions = {},
  ): () => void {
    registrationCounter += 1;
    const registration: Registration = {
      registrationId: registrationCounter,
      execute,
      options: registrationOptions,
    };
    const commandRegistrations =
      registrations.get(id) ?? new Map<number, Registration>();
    commandRegistrations.set(registration.registrationId, registration);
    registrations.set(id, commandRegistrations);
    for (const listener of listeners) listener();

    return () => {
      const current = registrations.get(id);
      if (!current) return;
      current.delete(registration.registrationId);
      if (current.size === 0) registrations.delete(id);
      for (const listener of listeners) listener();
    };
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function getCommands(
    context: HotkeyEventContext = lastContext,
  ): readonly HotkeyCommandView[] {
    return Object.values(HOTKEY_REGISTRY).map((definition) => {
      const resolved = resolveRegistration(
        definition.id,
        context,
        null,
        "launcher",
      );
      return {
        definition,
        registered: registrations.has(definition.id),
        available: resolved.registration !== null,
      };
    });
  }

  function invoke(
    id: HotkeyId,
    context: HotkeyEventContext = lastContext,
  ): boolean {
    const resolved = resolveRegistration(id, context, null, "launcher");
    if (!resolved.registration) {
      if (resolved.ambiguous) {
        logger.warn("hotkey.command.ambiguous", {
          commandIds: [id],
          source: "launcher",
        });
      }
      return false;
    }

    const event =
      typeof KeyboardEvent === "undefined"
        ? null
        : new KeyboardEvent("keydown", { cancelable: true });
    if (!event) return false;

    executeRegistration(id, resolved.registration, event, context, "launcher");
    return true;
  }

  return {
    register,
    handleKeyDown,
    handleKeyUp,
    cancel,
    subscribe,
    getSnapshot: () => snapshot,
    getCommands,
    invoke,
  };
}
