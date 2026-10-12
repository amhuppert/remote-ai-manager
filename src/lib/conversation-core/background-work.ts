/**
 * Background work a conversation kept between turns (its custody, design C5b
 * §5) could not be confirmed stopped, so what needed it stopped, deleting or
 * archiving the conversation, is refused: its processes may still write.
 */
export class BackgroundWorkUnstoppedError extends Error {
  readonly code = "BACKGROUND_WORK_UNSTOPPED" as const;
  /**
   * By name: the core composed at server startup throws its own bundle's copy
   * of this class, which a route's `instanceof` cannot see.
   */
  static is(error: unknown): error is BackgroundWorkUnstoppedError {
    return (
      error instanceof Error && error.name === "BackgroundWorkUnstoppedError"
    );
  }
  readonly statusCode = 409;
  /** The conversation whose processes are still unconfirmed, as every surface reports it beside the sentence. */
  readonly details: { conversationId: string };

  constructor(conversationId: string, failure: string) {
    super(
      `Background work in conversation ${conversationId} could not be confirmed stopped (${failure}); restart the server to collect its processes, then try again.`,
    );
    this.name = "BackgroundWorkUnstoppedError";
    this.details = { conversationId };
  }
}
