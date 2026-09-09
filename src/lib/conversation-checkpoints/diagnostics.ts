/**
 * Structural description of a thrown error, for checkpoint diagnostics.
 *
 * Checkpoint logs may not carry seed or source text, provider references, or
 * private reasoning (R9.2), and an exception is an unrestricted channel for all
 * three: a refused row echoes the value it rejected, a backend error quotes the
 * prompt it was handed, and a continuation failure names the resume token.
 * Redacting such a message is not a defence — the patterns that redaction knows
 * are credentials, not conversation.
 *
 * So the message never reaches the log. What does is the error's class and its
 * platform code — the two fields that separate a locked database from a
 * programming mistake — plus the length of what was elided, so a reader knows
 * detail existed and can find it in the layer that owns the failure.
 */
// A type alias rather than an interface: an interface has no implicit index
// signature, so it cannot be handed to a log-field projection typed
// `Record<string, unknown>`.
export type CheckpointErrorFields = {
  /** The error's own class name, or the runtime type of a non-Error throw. */
  errorKind: string;
  /** A platform code such as `SQLITE_BUSY` or `ENOENT`, when the error has one. */
  errorCode: string | null;
  /** Characters in the elided message. */
  errorChars: number;
};

export function checkpointErrorFields(error: unknown): CheckpointErrorFields {
  if (error instanceof Error) {
    const code: unknown = Reflect.get(error, "code");
    return {
      errorKind: error.name,
      errorCode: typeof code === "string" ? code : null,
      errorChars: error.message.length,
    };
  }
  return {
    errorKind: typeof error,
    errorCode: null,
    errorChars: typeof error === "string" ? error.length : 0,
  };
}
