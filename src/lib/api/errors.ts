/** Error thrown when an API call fails. Carries optional structured fields. */
export class ApiCallError extends Error {
  readonly code?: string;
  readonly output?: string;

  constructor(message: string, code?: string, output?: string) {
    super(message);
    this.name = "ApiCallError";
    this.code = code;
    this.output = output;
  }
}

/** Generic API error response */
export interface ApiError {
  /** Error message */
  error: string;
  /** Optional error code for programmatic handling */
  code?: string;
  /** Raw terminal output (stderr/stdout) from a failed git command */
  output?: string;
}
