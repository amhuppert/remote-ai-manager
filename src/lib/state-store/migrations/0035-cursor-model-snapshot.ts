export interface FrozenCursorModelSelection {
  readonly modelId: string;
  readonly parameters: Readonly<Record<string, string>>;
}

export interface FrozenCursorLegacyReasoningEffort {
  readonly parameterId: string;
  readonly selections: Readonly<Record<string, FrozenCursorModelSelection>>;
}

export interface FrozenCursorModelSnapshotEntry {
  readonly aliases: readonly string[];
  readonly defaultSelection: FrozenCursorModelSelection;
  readonly legacyReasoningEffort?: FrozenCursorLegacyReasoningEffort;
}

export const FROZEN_CURSOR_MODEL_VARIANT_PARAMETER_KEYS: Readonly<
  Record<string, readonly string[]>
> = {
  default: ["[]"],
  "grok-4.6": [
    '[["effort","low"],["fast","false"]]',
    '[["effort","low"],["fast","true"]]',
    '[["effort","medium"],["fast","false"]]',
    '[["effort","medium"],["fast","true"]]',
    '[["effort","high"],["fast","false"]]',
    '[["effort","high"],["fast","true"]]',
    '[["effort","xhigh"],["fast","false"]]',
    '[["effort","xhigh"],["fast","true"]]',
  ],
  "composer-2.5": ['[["fast","true"]]', '[["fast","false"]]'],
  "claude-opus-5": [
    '[["context","300k"],["cyber","false"],["effort","low"],["fast","false"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","low"],["fast","true"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","medium"],["fast","false"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","medium"],["fast","true"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","high"],["fast","false"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","high"],["fast","true"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","low"],["fast","false"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","low"],["fast","true"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","medium"],["fast","false"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","medium"],["fast","true"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","high"],["fast","false"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","high"],["fast","true"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","low"],["fast","false"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","low"],["fast","true"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","medium"],["fast","false"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","medium"],["fast","true"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","high"],["fast","false"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","high"],["fast","true"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","xhigh"],["fast","false"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","xhigh"],["fast","true"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","max"],["fast","false"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","max"],["fast","true"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","low"],["fast","false"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","low"],["fast","true"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","medium"],["fast","false"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","medium"],["fast","true"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","high"],["fast","false"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","high"],["fast","true"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","xhigh"],["fast","false"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","xhigh"],["fast","true"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","max"],["fast","false"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","max"],["fast","true"],["thinking","true"]]',
  ],
  "claude-opus-4-8": [
    '[["context","300k"],["cyber","false"],["effort","low"],["fast","false"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","low"],["fast","true"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","medium"],["fast","false"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","medium"],["fast","true"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","high"],["fast","false"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","high"],["fast","true"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","xhigh"],["fast","false"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","xhigh"],["fast","true"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","max"],["fast","false"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","max"],["fast","true"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","low"],["fast","false"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","low"],["fast","true"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","medium"],["fast","false"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","medium"],["fast","true"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","high"],["fast","false"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","high"],["fast","true"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","xhigh"],["fast","false"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","xhigh"],["fast","true"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","max"],["fast","false"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","max"],["fast","true"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","low"],["fast","false"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","low"],["fast","true"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","medium"],["fast","false"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","medium"],["fast","true"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","high"],["fast","false"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","high"],["fast","true"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","xhigh"],["fast","false"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","xhigh"],["fast","true"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","max"],["fast","false"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","max"],["fast","true"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","low"],["fast","false"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","low"],["fast","true"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","medium"],["fast","false"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","medium"],["fast","true"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","high"],["fast","false"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","high"],["fast","true"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","xhigh"],["fast","false"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","xhigh"],["fast","true"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","max"],["fast","false"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","max"],["fast","true"],["thinking","true"]]',
  ],
  "gpt-5.6-sol": [
    '[["context","272k"],["fast","false"],["reasoning","none"]]',
    '[["context","272k"],["fast","true"],["reasoning","none"]]',
    '[["context","272k"],["fast","false"],["reasoning","low"]]',
    '[["context","272k"],["fast","true"],["reasoning","low"]]',
    '[["context","272k"],["fast","false"],["reasoning","medium"]]',
    '[["context","272k"],["fast","true"],["reasoning","medium"]]',
    '[["context","272k"],["fast","false"],["reasoning","high"]]',
    '[["context","272k"],["fast","true"],["reasoning","high"]]',
    '[["context","272k"],["fast","false"],["reasoning","xhigh"]]',
    '[["context","272k"],["fast","true"],["reasoning","xhigh"]]',
    '[["context","272k"],["fast","false"],["reasoning","max"]]',
    '[["context","272k"],["fast","true"],["reasoning","max"]]',
    '[["context","1m"],["fast","false"],["reasoning","none"]]',
    '[["context","1m"],["fast","false"],["reasoning","low"]]',
    '[["context","1m"],["fast","false"],["reasoning","medium"]]',
    '[["context","1m"],["fast","false"],["reasoning","high"]]',
    '[["context","1m"],["fast","false"],["reasoning","xhigh"]]',
    '[["context","1m"],["fast","false"],["reasoning","max"]]',
  ],
  "gpt-5.5": [
    '[["context","272k"],["fast","false"],["reasoning","none"]]',
    '[["context","272k"],["fast","true"],["reasoning","none"]]',
    '[["context","272k"],["fast","false"],["reasoning","low"]]',
    '[["context","272k"],["fast","true"],["reasoning","low"]]',
    '[["context","272k"],["fast","false"],["reasoning","medium"]]',
    '[["context","272k"],["fast","true"],["reasoning","medium"]]',
    '[["context","272k"],["fast","false"],["reasoning","high"]]',
    '[["context","272k"],["fast","true"],["reasoning","high"]]',
    '[["context","272k"],["fast","false"],["reasoning","extra-high"]]',
    '[["context","272k"],["fast","true"],["reasoning","extra-high"]]',
    '[["context","1m"],["fast","false"],["reasoning","none"]]',
    '[["context","1m"],["fast","false"],["reasoning","low"]]',
    '[["context","1m"],["fast","false"],["reasoning","medium"]]',
    '[["context","1m"],["fast","false"],["reasoning","high"]]',
    '[["context","1m"],["fast","false"],["reasoning","extra-high"]]',
  ],
  "claude-fable-5": [
    '[["context","300k"],["effort","low"],["thinking","false"]]',
    '[["context","300k"],["effort","medium"],["thinking","false"]]',
    '[["context","300k"],["effort","high"],["thinking","false"]]',
    '[["context","300k"],["effort","xhigh"],["thinking","false"]]',
    '[["context","300k"],["effort","max"],["thinking","false"]]',
    '[["context","1m"],["effort","low"],["thinking","false"]]',
    '[["context","1m"],["effort","medium"],["thinking","false"]]',
    '[["context","1m"],["effort","high"],["thinking","false"]]',
    '[["context","1m"],["effort","xhigh"],["thinking","false"]]',
    '[["context","1m"],["effort","max"],["thinking","false"]]',
    '[["context","300k"],["effort","low"],["thinking","true"]]',
    '[["context","300k"],["effort","medium"],["thinking","true"]]',
    '[["context","300k"],["effort","high"],["thinking","true"]]',
    '[["context","300k"],["effort","xhigh"],["thinking","true"]]',
    '[["context","300k"],["effort","max"],["thinking","true"]]',
    '[["context","1m"],["effort","low"],["thinking","true"]]',
    '[["context","1m"],["effort","medium"],["thinking","true"]]',
    '[["context","1m"],["effort","high"],["thinking","true"]]',
    '[["context","1m"],["effort","xhigh"],["thinking","true"]]',
    '[["context","1m"],["effort","max"],["thinking","true"]]',
  ],
  "grok-4.5": [
    '[["effort","low"],["fast","false"]]',
    '[["effort","low"],["fast","true"]]',
    '[["effort","medium"],["fast","false"]]',
    '[["effort","medium"],["fast","true"]]',
    '[["effort","high"],["fast","false"]]',
    '[["effort","high"],["fast","true"]]',
  ],
  "gemini-3.7-flash": [
    '[["effort","low"]]',
    '[["effort","medium"]]',
    '[["effort","high"]]',
  ],
  "gpt-5.6-terra": [
    '[["context","272k"],["fast","false"],["reasoning","none"]]',
    '[["context","272k"],["fast","true"],["reasoning","none"]]',
    '[["context","272k"],["fast","false"],["reasoning","low"]]',
    '[["context","272k"],["fast","true"],["reasoning","low"]]',
    '[["context","272k"],["fast","false"],["reasoning","medium"]]',
    '[["context","272k"],["fast","true"],["reasoning","medium"]]',
    '[["context","272k"],["fast","false"],["reasoning","high"]]',
    '[["context","272k"],["fast","true"],["reasoning","high"]]',
    '[["context","272k"],["fast","false"],["reasoning","xhigh"]]',
    '[["context","272k"],["fast","true"],["reasoning","xhigh"]]',
    '[["context","272k"],["fast","false"],["reasoning","max"]]',
    '[["context","272k"],["fast","true"],["reasoning","max"]]',
    '[["context","1m"],["fast","false"],["reasoning","none"]]',
    '[["context","1m"],["fast","false"],["reasoning","low"]]',
    '[["context","1m"],["fast","false"],["reasoning","medium"]]',
    '[["context","1m"],["fast","false"],["reasoning","high"]]',
    '[["context","1m"],["fast","false"],["reasoning","xhigh"]]',
    '[["context","1m"],["fast","false"],["reasoning","max"]]',
  ],
  "claude-sonnet-5": [
    '[["context","300k"],["effort","low"],["thinking","false"]]',
    '[["context","300k"],["effort","medium"],["thinking","false"]]',
    '[["context","300k"],["effort","high"],["thinking","false"]]',
    '[["context","300k"],["effort","xhigh"],["thinking","false"]]',
    '[["context","300k"],["effort","max"],["thinking","false"]]',
    '[["context","1m"],["effort","low"],["thinking","false"]]',
    '[["context","1m"],["effort","medium"],["thinking","false"]]',
    '[["context","1m"],["effort","high"],["thinking","false"]]',
    '[["context","1m"],["effort","xhigh"],["thinking","false"]]',
    '[["context","1m"],["effort","max"],["thinking","false"]]',
    '[["context","300k"],["effort","low"],["thinking","true"]]',
    '[["context","300k"],["effort","medium"],["thinking","true"]]',
    '[["context","300k"],["effort","high"],["thinking","true"]]',
    '[["context","300k"],["effort","xhigh"],["thinking","true"]]',
    '[["context","300k"],["effort","max"],["thinking","true"]]',
    '[["context","1m"],["effort","low"],["thinking","true"]]',
    '[["context","1m"],["effort","medium"],["thinking","true"]]',
    '[["context","1m"],["effort","high"],["thinking","true"]]',
    '[["context","1m"],["effort","xhigh"],["thinking","true"]]',
    '[["context","1m"],["effort","max"],["thinking","true"]]',
  ],
  "claude-sonnet-4-6": [
    '[["context","200k"],["effort","low"],["thinking","false"]]',
    '[["context","200k"],["effort","medium"],["thinking","false"]]',
    '[["context","200k"],["effort","high"],["thinking","false"]]',
    '[["context","200k"],["effort","max"],["thinking","false"]]',
    '[["context","1m"],["effort","low"],["thinking","false"]]',
    '[["context","1m"],["effort","medium"],["thinking","false"]]',
    '[["context","1m"],["effort","high"],["thinking","false"]]',
    '[["context","1m"],["effort","max"],["thinking","false"]]',
    '[["context","200k"],["effort","low"],["thinking","true"]]',
    '[["context","200k"],["effort","medium"],["thinking","true"]]',
    '[["context","200k"],["effort","high"],["thinking","true"]]',
    '[["context","200k"],["effort","max"],["thinking","true"]]',
    '[["context","1m"],["effort","low"],["thinking","true"]]',
    '[["context","1m"],["effort","medium"],["thinking","true"]]',
    '[["context","1m"],["effort","high"],["thinking","true"]]',
    '[["context","1m"],["effort","max"],["thinking","true"]]',
  ],
  "composer-2": ['[["fast","true"]]', '[["fast","false"]]'],
  "gpt-5.3-codex": [
    '[["fast","false"],["reasoning","low"]]',
    '[["fast","true"],["reasoning","low"]]',
    '[["fast","false"],["reasoning","medium"]]',
    '[["fast","true"],["reasoning","medium"]]',
    '[["fast","false"],["reasoning","high"]]',
    '[["fast","true"],["reasoning","high"]]',
    '[["fast","false"],["reasoning","extra-high"]]',
    '[["fast","true"],["reasoning","extra-high"]]',
  ],
  "claude-opus-4-7": [
    '[["context","300k"],["cyber","false"],["effort","low"],["fast","false"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","low"],["fast","true"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","medium"],["fast","false"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","medium"],["fast","true"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","high"],["fast","false"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","high"],["fast","true"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","xhigh"],["fast","false"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","xhigh"],["fast","true"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","max"],["fast","false"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","max"],["fast","true"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","low"],["fast","false"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","low"],["fast","true"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","medium"],["fast","false"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","medium"],["fast","true"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","high"],["fast","false"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","high"],["fast","true"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","xhigh"],["fast","false"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","xhigh"],["fast","true"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","max"],["fast","false"],["thinking","false"]]',
    '[["context","1m"],["cyber","false"],["effort","max"],["fast","true"],["thinking","false"]]',
    '[["context","300k"],["cyber","false"],["effort","low"],["fast","false"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","low"],["fast","true"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","medium"],["fast","false"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","medium"],["fast","true"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","high"],["fast","false"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","high"],["fast","true"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","xhigh"],["fast","false"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","xhigh"],["fast","true"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","max"],["fast","false"],["thinking","true"]]',
    '[["context","300k"],["cyber","false"],["effort","max"],["fast","true"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","low"],["fast","false"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","low"],["fast","true"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","medium"],["fast","false"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","medium"],["fast","true"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","high"],["fast","false"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","high"],["fast","true"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","xhigh"],["fast","false"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","xhigh"],["fast","true"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","max"],["fast","false"],["thinking","true"]]',
    '[["context","1m"],["cyber","false"],["effort","max"],["fast","true"],["thinking","true"]]',
  ],
  "gpt-5.4": [
    '[["context","272k"],["fast","false"],["reasoning","none"]]',
    '[["context","272k"],["fast","true"],["reasoning","none"]]',
    '[["context","272k"],["fast","false"],["reasoning","low"]]',
    '[["context","272k"],["fast","true"],["reasoning","low"]]',
    '[["context","272k"],["fast","false"],["reasoning","medium"]]',
    '[["context","272k"],["fast","true"],["reasoning","medium"]]',
    '[["context","272k"],["fast","false"],["reasoning","high"]]',
    '[["context","272k"],["fast","true"],["reasoning","high"]]',
    '[["context","272k"],["fast","false"],["reasoning","extra-high"]]',
    '[["context","272k"],["fast","true"],["reasoning","extra-high"]]',
    '[["context","1m"],["fast","false"],["reasoning","none"]]',
    '[["context","1m"],["fast","false"],["reasoning","low"]]',
    '[["context","1m"],["fast","false"],["reasoning","medium"]]',
    '[["context","1m"],["fast","false"],["reasoning","high"]]',
    '[["context","1m"],["fast","false"],["reasoning","extra-high"]]',
  ],
  "claude-opus-4-6": [
    '[["context","200k"],["effort","low"],["thinking","false"]]',
    '[["context","200k"],["effort","medium"],["thinking","false"]]',
    '[["context","200k"],["effort","high"],["thinking","false"]]',
    '[["context","200k"],["effort","max"],["thinking","false"]]',
    '[["context","1m"],["effort","low"],["thinking","false"]]',
    '[["context","1m"],["effort","medium"],["thinking","false"]]',
    '[["context","1m"],["effort","high"],["thinking","false"]]',
    '[["context","1m"],["effort","max"],["thinking","false"]]',
    '[["context","200k"],["effort","low"],["thinking","true"]]',
    '[["context","200k"],["effort","medium"],["thinking","true"]]',
    '[["context","200k"],["effort","high"],["thinking","true"]]',
    '[["context","200k"],["effort","max"],["thinking","true"]]',
    '[["context","1m"],["effort","low"],["thinking","true"]]',
    '[["context","1m"],["effort","medium"],["thinking","true"]]',
    '[["context","1m"],["effort","high"],["thinking","true"]]',
    '[["context","1m"],["effort","max"],["thinking","true"]]',
  ],
  "claude-opus-4-5": ['[["thinking","false"]]', '[["thinking","true"]]'],
  "gpt-5.2": [
    '[["fast","false"],["reasoning","low"]]',
    '[["fast","true"],["reasoning","low"]]',
    '[["fast","false"],["reasoning","medium"]]',
    '[["fast","true"],["reasoning","medium"]]',
    '[["fast","false"],["reasoning","high"]]',
    '[["fast","true"],["reasoning","high"]]',
    '[["fast","false"],["reasoning","extra-high"]]',
    '[["fast","true"],["reasoning","extra-high"]]',
  ],
  "gpt-5.6-luna": [
    '[["context","272k"],["fast","false"],["reasoning","none"]]',
    '[["context","272k"],["fast","true"],["reasoning","none"]]',
    '[["context","272k"],["fast","false"],["reasoning","low"]]',
    '[["context","272k"],["fast","true"],["reasoning","low"]]',
    '[["context","272k"],["fast","false"],["reasoning","medium"]]',
    '[["context","272k"],["fast","true"],["reasoning","medium"]]',
    '[["context","272k"],["fast","false"],["reasoning","high"]]',
    '[["context","272k"],["fast","true"],["reasoning","high"]]',
    '[["context","272k"],["fast","false"],["reasoning","xhigh"]]',
    '[["context","272k"],["fast","true"],["reasoning","xhigh"]]',
    '[["context","272k"],["fast","false"],["reasoning","max"]]',
    '[["context","272k"],["fast","true"],["reasoning","max"]]',
    '[["context","1m"],["fast","false"],["reasoning","none"]]',
    '[["context","1m"],["fast","false"],["reasoning","low"]]',
    '[["context","1m"],["fast","false"],["reasoning","medium"]]',
    '[["context","1m"],["fast","false"],["reasoning","high"]]',
    '[["context","1m"],["fast","false"],["reasoning","xhigh"]]',
    '[["context","1m"],["fast","false"],["reasoning","max"]]',
  ],
  "gemini-3.6-flash": [
    '[["effort","minimal"]]',
    '[["effort","low"]]',
    '[["effort","medium"]]',
    '[["effort","high"]]',
  ],
  "gemini-3.1-pro": ["[]"],
  "gpt-5.4-mini": [
    '[["reasoning","none"]]',
    '[["reasoning","low"]]',
    '[["reasoning","medium"]]',
    '[["reasoning","high"]]',
    '[["reasoning","xhigh"]]',
  ],
  "gpt-5.4-nano": [
    '[["reasoning","none"]]',
    '[["reasoning","low"]]',
    '[["reasoning","medium"]]',
    '[["reasoning","high"]]',
    '[["reasoning","xhigh"]]',
  ],
  "claude-haiku-4-5": ['[["thinking","false"]]', '[["thinking","true"]]'],
  "claude-sonnet-4-5": [
    '[["context","200k"],["thinking","false"]]',
    '[["context","200k"],["thinking","true"]]',
  ],
  "gpt-5.1": [
    '[["reasoning","low"]]',
    '[["reasoning","medium"]]',
    '[["reasoning","high"]]',
  ],
  "gemini-3-flash": ["[]"],
  "gemini-3.5-flash": ["[]"],
  "claude-sonnet-4": [
    '[["context","200k"],["thinking","false"]]',
    '[["context","200k"],["thinking","true"]]',
  ],
  "gpt-5-mini": ["[]"],
  "gemini-2.5-flash": ["[]"],
  "kimi-k3": [
    '[["reasoning","low"]]',
    '[["reasoning","high"]]',
    '[["reasoning","max"]]',
  ],
  "kimi-k2.7-code": ["[]"],
  "glm-5.2": ['[["reasoning","high"]]', '[["reasoning","max"]]'],
};

export const FROZEN_CURSOR_MODEL_SNAPSHOT = {
  default: {
    aliases: ["auto"],
    defaultSelection: {
      modelId: "default",
      parameters: {},
    },
  },
  "grok-4.6": {
    aliases: [],
    defaultSelection: {
      modelId: "grok-4.6",
      parameters: {
        effort: "high",
        fast: "true",
      },
    },
    legacyReasoningEffort: {
      parameterId: "effort",
      selections: {
        low: {
          modelId: "grok-4.6",
          parameters: {
            effort: "low",
            fast: "true",
          },
        },
        medium: {
          modelId: "grok-4.6",
          parameters: {
            effort: "medium",
            fast: "true",
          },
        },
        high: {
          modelId: "grok-4.6",
          parameters: {
            effort: "high",
            fast: "true",
          },
        },
        xhigh: {
          modelId: "grok-4.6",
          parameters: {
            effort: "xhigh",
            fast: "true",
          },
        },
      },
    },
  },
  "composer-2.5": {
    aliases: ["composer-latest", "composer", "composer-2-5"],
    defaultSelection: {
      modelId: "composer-2.5",
      parameters: {
        fast: "true",
      },
    },
  },
  "claude-opus-5": {
    aliases: ["opus-5"],
    defaultSelection: {
      modelId: "claude-opus-5",
      parameters: {
        context: "1m",
        cyber: "false",
        effort: "high",
        fast: "false",
        thinking: "true",
      },
    },
    legacyReasoningEffort: {
      parameterId: "effort",
      selections: {
        low: {
          modelId: "claude-opus-5",
          parameters: {
            context: "1m",
            cyber: "false",
            effort: "low",
            fast: "false",
            thinking: "true",
          },
        },
        medium: {
          modelId: "claude-opus-5",
          parameters: {
            context: "1m",
            cyber: "false",
            effort: "medium",
            fast: "false",
            thinking: "true",
          },
        },
        high: {
          modelId: "claude-opus-5",
          parameters: {
            context: "1m",
            cyber: "false",
            effort: "high",
            fast: "false",
            thinking: "true",
          },
        },
        max: {
          modelId: "claude-opus-5",
          parameters: {
            context: "1m",
            cyber: "false",
            effort: "max",
            fast: "false",
            thinking: "true",
          },
        },
        xhigh: {
          modelId: "claude-opus-5",
          parameters: {
            context: "1m",
            cyber: "false",
            effort: "xhigh",
            fast: "false",
            thinking: "true",
          },
        },
      },
    },
  },
  "claude-opus-4-8": {
    aliases: ["opus-4.8", "opus-4-8"],
    defaultSelection: {
      modelId: "claude-opus-4-8",
      parameters: {
        context: "1m",
        cyber: "false",
        effort: "high",
        fast: "false",
        thinking: "true",
      },
    },
    legacyReasoningEffort: {
      parameterId: "effort",
      selections: {
        low: {
          modelId: "claude-opus-4-8",
          parameters: {
            context: "1m",
            cyber: "false",
            effort: "low",
            fast: "false",
            thinking: "true",
          },
        },
        medium: {
          modelId: "claude-opus-4-8",
          parameters: {
            context: "1m",
            cyber: "false",
            effort: "medium",
            fast: "false",
            thinking: "true",
          },
        },
        high: {
          modelId: "claude-opus-4-8",
          parameters: {
            context: "1m",
            cyber: "false",
            effort: "high",
            fast: "false",
            thinking: "true",
          },
        },
        max: {
          modelId: "claude-opus-4-8",
          parameters: {
            context: "1m",
            cyber: "false",
            effort: "max",
            fast: "false",
            thinking: "true",
          },
        },
        xhigh: {
          modelId: "claude-opus-4-8",
          parameters: {
            context: "1m",
            cyber: "false",
            effort: "xhigh",
            fast: "false",
            thinking: "true",
          },
        },
      },
    },
  },
  "gpt-5.6-sol": {
    aliases: ["gpt-latest", "gpt-5-6-sol", "gpt-5.6"],
    defaultSelection: {
      modelId: "gpt-5.6-sol",
      parameters: {
        context: "1m",
        fast: "false",
        reasoning: "medium",
      },
    },
    legacyReasoningEffort: {
      parameterId: "reasoning",
      selections: {
        low: {
          modelId: "gpt-5.6-sol",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "low",
          },
        },
        medium: {
          modelId: "gpt-5.6-sol",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "medium",
          },
        },
        high: {
          modelId: "gpt-5.6-sol",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "high",
          },
        },
        max: {
          modelId: "gpt-5.6-sol",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "max",
          },
        },
        xhigh: {
          modelId: "gpt-5.6-sol",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "xhigh",
          },
        },
      },
    },
  },
  "gpt-5.5": {
    aliases: ["gpt-5-5"],
    defaultSelection: {
      modelId: "gpt-5.5",
      parameters: {
        context: "1m",
        fast: "false",
        reasoning: "medium",
      },
    },
    legacyReasoningEffort: {
      parameterId: "reasoning",
      selections: {
        low: {
          modelId: "gpt-5.5",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "low",
          },
        },
        medium: {
          modelId: "gpt-5.5",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "medium",
          },
        },
        high: {
          modelId: "gpt-5.5",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "high",
          },
        },
      },
    },
  },
  "claude-fable-5": {
    aliases: ["fable", "fable-5"],
    defaultSelection: {
      modelId: "claude-fable-5",
      parameters: {
        context: "1m",
        effort: "high",
        thinking: "true",
      },
    },
    legacyReasoningEffort: {
      parameterId: "effort",
      selections: {
        low: {
          modelId: "claude-fable-5",
          parameters: {
            context: "1m",
            effort: "low",
            thinking: "true",
          },
        },
        medium: {
          modelId: "claude-fable-5",
          parameters: {
            context: "1m",
            effort: "medium",
            thinking: "true",
          },
        },
        high: {
          modelId: "claude-fable-5",
          parameters: {
            context: "1m",
            effort: "high",
            thinking: "true",
          },
        },
        max: {
          modelId: "claude-fable-5",
          parameters: {
            context: "1m",
            effort: "max",
            thinking: "true",
          },
        },
        xhigh: {
          modelId: "claude-fable-5",
          parameters: {
            context: "1m",
            effort: "xhigh",
            thinking: "true",
          },
        },
      },
    },
  },
  "grok-4.5": {
    aliases: [],
    defaultSelection: {
      modelId: "grok-4.5",
      parameters: {
        effort: "high",
        fast: "true",
      },
    },
    legacyReasoningEffort: {
      parameterId: "effort",
      selections: {
        low: {
          modelId: "grok-4.5",
          parameters: {
            effort: "low",
            fast: "true",
          },
        },
        medium: {
          modelId: "grok-4.5",
          parameters: {
            effort: "medium",
            fast: "true",
          },
        },
        high: {
          modelId: "grok-4.5",
          parameters: {
            effort: "high",
            fast: "true",
          },
        },
      },
    },
  },
  "gemini-3.7-flash": {
    aliases: [],
    defaultSelection: {
      modelId: "gemini-3.7-flash",
      parameters: {
        effort: "high",
      },
    },
    legacyReasoningEffort: {
      parameterId: "effort",
      selections: {
        low: {
          modelId: "gemini-3.7-flash",
          parameters: {
            effort: "low",
          },
        },
        medium: {
          modelId: "gemini-3.7-flash",
          parameters: {
            effort: "medium",
          },
        },
        high: {
          modelId: "gemini-3.7-flash",
          parameters: {
            effort: "high",
          },
        },
      },
    },
  },
  "gpt-5.6-terra": {
    aliases: ["gpt-5-6-terra"],
    defaultSelection: {
      modelId: "gpt-5.6-terra",
      parameters: {
        context: "1m",
        fast: "false",
        reasoning: "medium",
      },
    },
    legacyReasoningEffort: {
      parameterId: "reasoning",
      selections: {
        low: {
          modelId: "gpt-5.6-terra",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "low",
          },
        },
        medium: {
          modelId: "gpt-5.6-terra",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "medium",
          },
        },
        high: {
          modelId: "gpt-5.6-terra",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "high",
          },
        },
        max: {
          modelId: "gpt-5.6-terra",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "max",
          },
        },
        xhigh: {
          modelId: "gpt-5.6-terra",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "xhigh",
          },
        },
      },
    },
  },
  "claude-sonnet-5": {
    aliases: ["sonnet-5"],
    defaultSelection: {
      modelId: "claude-sonnet-5",
      parameters: {
        context: "1m",
        effort: "high",
        thinking: "true",
      },
    },
    legacyReasoningEffort: {
      parameterId: "effort",
      selections: {
        low: {
          modelId: "claude-sonnet-5",
          parameters: {
            context: "1m",
            effort: "low",
            thinking: "true",
          },
        },
        medium: {
          modelId: "claude-sonnet-5",
          parameters: {
            context: "1m",
            effort: "medium",
            thinking: "true",
          },
        },
        high: {
          modelId: "claude-sonnet-5",
          parameters: {
            context: "1m",
            effort: "high",
            thinking: "true",
          },
        },
        max: {
          modelId: "claude-sonnet-5",
          parameters: {
            context: "1m",
            effort: "max",
            thinking: "true",
          },
        },
        xhigh: {
          modelId: "claude-sonnet-5",
          parameters: {
            context: "1m",
            effort: "xhigh",
            thinking: "true",
          },
        },
      },
    },
  },
  "claude-sonnet-4-6": {
    aliases: ["sonnet-4.6", "sonnet-4-6"],
    defaultSelection: {
      modelId: "claude-sonnet-4-6",
      parameters: {
        context: "1m",
        effort: "medium",
        thinking: "true",
      },
    },
    legacyReasoningEffort: {
      parameterId: "effort",
      selections: {
        low: {
          modelId: "claude-sonnet-4-6",
          parameters: {
            context: "1m",
            effort: "low",
            thinking: "true",
          },
        },
        medium: {
          modelId: "claude-sonnet-4-6",
          parameters: {
            context: "1m",
            effort: "medium",
            thinking: "true",
          },
        },
        high: {
          modelId: "claude-sonnet-4-6",
          parameters: {
            context: "1m",
            effort: "high",
            thinking: "true",
          },
        },
        max: {
          modelId: "claude-sonnet-4-6",
          parameters: {
            context: "1m",
            effort: "max",
            thinking: "true",
          },
        },
      },
    },
  },
  "composer-2": {
    aliases: [],
    defaultSelection: {
      modelId: "composer-2",
      parameters: {
        fast: "true",
      },
    },
  },
  "gpt-5.3-codex": {
    aliases: ["codex-latest", "codex", "codex-5.3"],
    defaultSelection: {
      modelId: "gpt-5.3-codex",
      parameters: {
        fast: "true",
        reasoning: "high",
      },
    },
    legacyReasoningEffort: {
      parameterId: "reasoning",
      selections: {
        low: {
          modelId: "gpt-5.3-codex",
          parameters: {
            fast: "true",
            reasoning: "low",
          },
        },
        medium: {
          modelId: "gpt-5.3-codex",
          parameters: {
            fast: "true",
            reasoning: "medium",
          },
        },
        high: {
          modelId: "gpt-5.3-codex",
          parameters: {
            fast: "true",
            reasoning: "high",
          },
        },
      },
    },
  },
  "claude-opus-4-7": {
    aliases: ["opus-4.7", "opus-4-7"],
    defaultSelection: {
      modelId: "claude-opus-4-7",
      parameters: {
        context: "1m",
        cyber: "false",
        effort: "xhigh",
        fast: "false",
        thinking: "true",
      },
    },
    legacyReasoningEffort: {
      parameterId: "effort",
      selections: {
        low: {
          modelId: "claude-opus-4-7",
          parameters: {
            context: "1m",
            cyber: "false",
            effort: "low",
            fast: "false",
            thinking: "true",
          },
        },
        medium: {
          modelId: "claude-opus-4-7",
          parameters: {
            context: "1m",
            cyber: "false",
            effort: "medium",
            fast: "false",
            thinking: "true",
          },
        },
        high: {
          modelId: "claude-opus-4-7",
          parameters: {
            context: "1m",
            cyber: "false",
            effort: "high",
            fast: "false",
            thinking: "true",
          },
        },
        max: {
          modelId: "claude-opus-4-7",
          parameters: {
            context: "1m",
            cyber: "false",
            effort: "max",
            fast: "false",
            thinking: "true",
          },
        },
        xhigh: {
          modelId: "claude-opus-4-7",
          parameters: {
            context: "1m",
            cyber: "false",
            effort: "xhigh",
            fast: "false",
            thinking: "true",
          },
        },
      },
    },
  },
  "gpt-5.4": {
    aliases: [],
    defaultSelection: {
      modelId: "gpt-5.4",
      parameters: {
        context: "1m",
        fast: "false",
        reasoning: "medium",
      },
    },
    legacyReasoningEffort: {
      parameterId: "reasoning",
      selections: {
        low: {
          modelId: "gpt-5.4",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "low",
          },
        },
        medium: {
          modelId: "gpt-5.4",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "medium",
          },
        },
        high: {
          modelId: "gpt-5.4",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "high",
          },
        },
      },
    },
  },
  "claude-opus-4-6": {
    aliases: ["opus-4.6", "opus-4-6"],
    defaultSelection: {
      modelId: "claude-opus-4-6",
      parameters: {
        context: "1m",
        effort: "high",
        thinking: "true",
      },
    },
    legacyReasoningEffort: {
      parameterId: "effort",
      selections: {
        low: {
          modelId: "claude-opus-4-6",
          parameters: {
            context: "1m",
            effort: "low",
            thinking: "true",
          },
        },
        medium: {
          modelId: "claude-opus-4-6",
          parameters: {
            context: "1m",
            effort: "medium",
            thinking: "true",
          },
        },
        high: {
          modelId: "claude-opus-4-6",
          parameters: {
            context: "1m",
            effort: "high",
            thinking: "true",
          },
        },
        max: {
          modelId: "claude-opus-4-6",
          parameters: {
            context: "1m",
            effort: "max",
            thinking: "true",
          },
        },
      },
    },
  },
  "claude-opus-4-5": {
    aliases: ["opus-4.5", "opus-4-5"],
    defaultSelection: {
      modelId: "claude-opus-4-5",
      parameters: {
        thinking: "true",
      },
    },
  },
  "gpt-5.2": {
    aliases: [],
    defaultSelection: {
      modelId: "gpt-5.2",
      parameters: {
        fast: "true",
        reasoning: "high",
      },
    },
    legacyReasoningEffort: {
      parameterId: "reasoning",
      selections: {
        low: {
          modelId: "gpt-5.2",
          parameters: {
            fast: "true",
            reasoning: "low",
          },
        },
        medium: {
          modelId: "gpt-5.2",
          parameters: {
            fast: "true",
            reasoning: "medium",
          },
        },
        high: {
          modelId: "gpt-5.2",
          parameters: {
            fast: "true",
            reasoning: "high",
          },
        },
      },
    },
  },
  "gpt-5.6-luna": {
    aliases: ["gpt-5-6-luna"],
    defaultSelection: {
      modelId: "gpt-5.6-luna",
      parameters: {
        context: "1m",
        fast: "false",
        reasoning: "medium",
      },
    },
    legacyReasoningEffort: {
      parameterId: "reasoning",
      selections: {
        low: {
          modelId: "gpt-5.6-luna",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "low",
          },
        },
        medium: {
          modelId: "gpt-5.6-luna",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "medium",
          },
        },
        high: {
          modelId: "gpt-5.6-luna",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "high",
          },
        },
        max: {
          modelId: "gpt-5.6-luna",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "max",
          },
        },
        xhigh: {
          modelId: "gpt-5.6-luna",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "xhigh",
          },
        },
      },
    },
  },
  "gemini-3.6-flash": {
    aliases: [],
    defaultSelection: {
      modelId: "gemini-3.6-flash",
      parameters: {
        effort: "high",
      },
    },
    legacyReasoningEffort: {
      parameterId: "effort",
      selections: {
        minimal: {
          modelId: "gemini-3.6-flash",
          parameters: {
            effort: "minimal",
          },
        },
        low: {
          modelId: "gemini-3.6-flash",
          parameters: {
            effort: "low",
          },
        },
        medium: {
          modelId: "gemini-3.6-flash",
          parameters: {
            effort: "medium",
          },
        },
        high: {
          modelId: "gemini-3.6-flash",
          parameters: {
            effort: "high",
          },
        },
      },
    },
  },
  "gemini-3.1-pro": {
    aliases: ["gemini-latest", "gemini-pro-latest", "gemini", "gemini-pro"],
    defaultSelection: {
      modelId: "gemini-3.1-pro",
      parameters: {},
    },
  },
  "gpt-5.4-mini": {
    aliases: ["gpt-mini-latest"],
    defaultSelection: {
      modelId: "gpt-5.4-mini",
      parameters: {
        reasoning: "medium",
      },
    },
    legacyReasoningEffort: {
      parameterId: "reasoning",
      selections: {
        low: {
          modelId: "gpt-5.4-mini",
          parameters: {
            reasoning: "low",
          },
        },
        medium: {
          modelId: "gpt-5.4-mini",
          parameters: {
            reasoning: "medium",
          },
        },
        high: {
          modelId: "gpt-5.4-mini",
          parameters: {
            reasoning: "high",
          },
        },
        xhigh: {
          modelId: "gpt-5.4-mini",
          parameters: {
            reasoning: "xhigh",
          },
        },
      },
    },
  },
  "gpt-5.4-nano": {
    aliases: ["gpt-nano-latest", "gpt-nano"],
    defaultSelection: {
      modelId: "gpt-5.4-nano",
      parameters: {
        reasoning: "medium",
      },
    },
    legacyReasoningEffort: {
      parameterId: "reasoning",
      selections: {
        low: {
          modelId: "gpt-5.4-nano",
          parameters: {
            reasoning: "low",
          },
        },
        medium: {
          modelId: "gpt-5.4-nano",
          parameters: {
            reasoning: "medium",
          },
        },
        high: {
          modelId: "gpt-5.4-nano",
          parameters: {
            reasoning: "high",
          },
        },
        xhigh: {
          modelId: "gpt-5.4-nano",
          parameters: {
            reasoning: "xhigh",
          },
        },
      },
    },
  },
  "claude-haiku-4-5": {
    aliases: ["haiku-latest", "haiku", "haiku-4.5", "haiku-4-5"],
    defaultSelection: {
      modelId: "claude-haiku-4-5",
      parameters: {
        thinking: "true",
      },
    },
  },
  "claude-sonnet-4-5": {
    aliases: ["sonnet-4.5", "sonnet-4-5"],
    defaultSelection: {
      modelId: "claude-sonnet-4-5",
      parameters: {
        context: "200k",
        thinking: "true",
      },
    },
  },
  "gpt-5.1": {
    aliases: [],
    defaultSelection: {
      modelId: "gpt-5.1",
      parameters: {
        reasoning: "medium",
      },
    },
    legacyReasoningEffort: {
      parameterId: "reasoning",
      selections: {
        low: {
          modelId: "gpt-5.1",
          parameters: {
            reasoning: "low",
          },
        },
        medium: {
          modelId: "gpt-5.1",
          parameters: {
            reasoning: "medium",
          },
        },
        high: {
          modelId: "gpt-5.1",
          parameters: {
            reasoning: "high",
          },
        },
      },
    },
  },
  "gemini-3-flash": {
    aliases: [],
    defaultSelection: {
      modelId: "gemini-3-flash",
      parameters: {},
    },
  },
  "gemini-3.5-flash": {
    aliases: [],
    defaultSelection: {
      modelId: "gemini-3.5-flash",
      parameters: {},
    },
  },
  "claude-sonnet-4": {
    aliases: ["sonnet-4"],
    defaultSelection: {
      modelId: "claude-sonnet-4",
      parameters: {
        context: "200k",
        thinking: "false",
      },
    },
  },
  "gpt-5-mini": {
    aliases: [],
    defaultSelection: {
      modelId: "gpt-5-mini",
      parameters: {},
    },
  },
  "gemini-2.5-flash": {
    aliases: [],
    defaultSelection: {
      modelId: "gemini-2.5-flash",
      parameters: {},
    },
  },
  "kimi-k3": {
    aliases: [],
    defaultSelection: {
      modelId: "kimi-k3",
      parameters: {
        reasoning: "max",
      },
    },
    legacyReasoningEffort: {
      parameterId: "reasoning",
      selections: {
        low: {
          modelId: "kimi-k3",
          parameters: {
            reasoning: "low",
          },
        },
        high: {
          modelId: "kimi-k3",
          parameters: {
            reasoning: "high",
          },
        },
        max: {
          modelId: "kimi-k3",
          parameters: {
            reasoning: "max",
          },
        },
      },
    },
  },
  "kimi-k2.7-code": {
    aliases: ["kimi-latest", "kimi"],
    defaultSelection: {
      modelId: "kimi-k2.7-code",
      parameters: {},
    },
  },
  "glm-5.2": {
    aliases: [],
    defaultSelection: {
      modelId: "glm-5.2",
      parameters: {
        reasoning: "high",
      },
    },
    legacyReasoningEffort: {
      parameterId: "reasoning",
      selections: {
        high: {
          modelId: "glm-5.2",
          parameters: {
            reasoning: "high",
          },
        },
        max: {
          modelId: "glm-5.2",
          parameters: {
            reasoning: "max",
          },
        },
      },
    },
  },
} as const satisfies Readonly<Record<string, FrozenCursorModelSnapshotEntry>>;
