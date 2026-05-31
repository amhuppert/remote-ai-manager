/** Error thrown when an API call fails. Carries optional structured fields. */
export class ApiCallError extends Error {
  readonly code?: string;
  readonly output?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code?: string,
    output?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiCallError";
    this.code = code;
    this.output = output;
    this.details = details;
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
  /** Optional structured details consumers can use for richer UI handling */
  details?: Record<string, unknown>;
}
