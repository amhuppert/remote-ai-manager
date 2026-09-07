export class GraphWorkflowResourceMissingError extends Error {
  constructor(
    readonly resource: "execution" | "definition" | "context",
    message: string,
  ) {
    super(message);
    this.name = "GraphWorkflowResourceMissingError";
  }
}
