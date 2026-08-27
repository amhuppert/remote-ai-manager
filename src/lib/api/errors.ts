/** A structured validation issue: a JSON-path location and its message. */
export interface RequestIssue {
  path: string;
  message: string;
}

/** Error thrown when an API call fails. Carries optional structured fields. */
export class ApiCallError extends Error {
  readonly code?: string;
  readonly output?: string;
  readonly details?: Record<string, unknown>;
  /** HTTP status of the failed response, when known. */
  readonly status?: number;
  /** Structured validation issues, when the server supplies an `issues` array. */
  readonly issues?: RequestIssue[];

  constructor(
    message: string,
    code?: string,
    output?: string,
    details?: Record<string, unknown>,
    status?: number,
    issues?: RequestIssue[],
  ) {
    super(message);
    this.name = "ApiCallError";
    this.code = code;
    this.output = output;
    this.details = details;
    this.status = status;
    this.issues = issues;
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
  /**
   * Optional server-authored reason the request was refused. `cctl` classifies
   * it off the response body and renders it as its `why:` line, above the
   * instruction — so a refusal can explain itself rather than only naming a
   * remedy the caller has no reason to trust.
   */
  rationale?: string;
  /**
   * Optional server-authored next step. `cctl` renders it as its load-bearing
   * `instruction:` line, so a read miss with an exact recovery command can
   * hand the caller that command instead of only naming what is absent.
   */
  instruction?: string;
}
