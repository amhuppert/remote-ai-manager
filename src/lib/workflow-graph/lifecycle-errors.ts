export class GraphWorkflowResourceMissingError extends Error {
  /** By its name: see `lifecycleRefusalFromError`. */
  static is(error: unknown): error is GraphWorkflowResourceMissingError {
    return (
      error instanceof Error &&
      error.name === "GraphWorkflowResourceMissingError"
    );
  }

  constructor(
    readonly resource: "execution" | "definition" | "context",
    message: string,
  ) {
    super(message);
    this.name = "GraphWorkflowResourceMissingError";
  }
}
