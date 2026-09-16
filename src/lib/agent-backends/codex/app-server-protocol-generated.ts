// Generated from codex-cli 0.153.3 by `app-server generate-ts` (stable surface).
// Relevant transport request types only; imports flattened without changing their definitions.
// Regenerate in a temporary directory and copy the same transitive subset on runtime upgrades.

// Source: ClientInfo.ts
export type ClientInfo = {
  name: string;
  title: string | null;
  version: string;
};

// Source: serde_json/JsonValue.ts
export type JsonValue =
  | number
  | string
  | boolean
  | Array<JsonValue>
  | { [key in string]?: JsonValue }
  | null;

// Source: InitializeCapabilities.ts
/**
 * Client-declared capabilities negotiated during initialize.
 */
export type InitializeCapabilities = {
  /**
   * Opt into receiving experimental API methods and fields.
   */
  experimentalApi: boolean;
  /**
   * Opt into `attestation/generate` requests for upstream `x-oai-attestation`.
   */
  requestAttestation: boolean;
  /**
   * Legacy opt-in for the `openai/form` MCP extension.
   *
   * New clients should declare `openai/form` in [`Self::extensions`].
   */
  mcpServerOpenaiFormElicitation?: boolean;
  /**
   * Exact notification method names that should be suppressed for this
   * connection (for example `thread/started`).
   */
  optOutNotificationMethods?: Array<string> | null;
  /**
   * MCP extension settings declared by the app-server client.
   */
  extensions?: { [key in string]?: JsonValue } | null;
};

// Source: InitializeParams.ts
export type InitializeParams = {
  clientInfo: ClientInfo;
  capabilities: InitializeCapabilities | null;
};

// Source: AbsolutePathBuf.ts
/**
 * A path that is guaranteed to be absolute and normalized (though it is not
 * guaranteed to be canonicalized or exist on the filesystem).
 *
 * IMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set
 * using [AbsolutePathBufGuard::new]. If no base path is set, the
 * deserialization will fail unless the path being deserialized is already
 * absolute.
 */
export type AbsolutePathBuf = string;

// Source: InitializeResponse.ts
export type InitializeResponse = {
  userAgent: string;
  /**
   * Absolute path to the server's $CODEX_HOME directory.
   */
  codexHome: AbsolutePathBuf;
  /**
   * Platform family for the running app-server target, for example
   * `"unix"` or `"windows"`.
   */
  platformFamily: string;
  /**
   * Operating system for the running app-server target, for example
   * `"macos"`, `"linux"`, or `"windows"`.
   */
  platformOs: string;
};

// Source: ImageDetail.ts
export type ImageDetail = "auto" | "low" | "high" | "original";

// Source: v2/ByteRange.ts
export type ByteRange = { start: number; end: number };

// Source: v2/TextElement.ts
export type TextElement = {
  /**
   * Byte range in the parent `text` buffer that this element occupies.
   */
  byteRange: ByteRange;
  /**
   * Optional human-readable placeholder for the element, displayed in the UI.
   */
  placeholder: string | null;
};

// Source: v2/UserInput.ts
export type UserInput =
  | {
      type: "text";
      text: string;
      /**
       * UI-defined spans within `text` used to render or persist special elements.
       */
      text_elements: Array<TextElement>;
    }
  | { type: "image"; detail?: ImageDetail; url: string }
  | { type: "localImage"; detail?: ImageDetail; path: string }
  | { type: "audio"; url: string }
  | { type: "localAudio"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

// Source: v2/TurnSteerParams.ts
export type TurnSteerParams = {
  threadId: string;
  clientUserMessageId?: string | null;
  input: Array<UserInput>; /**
   * Required active turn id precondition. The request fails when it does not
   * match the currently active turn.
   */
  expectedTurnId: string;
};

// Source: v2/TurnSteerResponse.ts
export type TurnSteerResponse = { turnId: string };

// Source: v2/TurnInterruptParams.ts
export type TurnInterruptParams = { threadId: string; turnId: string };

// Source: v2/ThreadInjectItemsParams.ts
export type ThreadInjectItemsParams = {
  threadId: string;
  /**
   * Raw Responses API items to append to the thread's model-visible history.
   */
  items: Array<JsonValue>;
};
