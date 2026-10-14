import { Button } from "@/components/ui/Button";

interface ReadQuery {
  isError: boolean;
  isPending: boolean;
  isFetching: boolean;
  errorUpdateCount: number;
}

/**
 * Whether a run read failed, and whether reading it again is under way. A
 * query with nothing read yet goes back to pending when retried; it is still
 * the failed read, being retried.
 */
export function failedRead(query: ReadQuery): {
  failed: boolean;
  retrying: boolean;
} {
  const failed =
    query.isError || (query.isPending && query.errorUpdateCount > 0);
  return { failed, retrying: failed && query.isFetching };
}

/** A run read that failed, with the way to read it again. */
export function ReadFailure({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry(): void;
}) {
  return (
    <p
      role="alert"
      className="m-0 flex flex-wrap items-center gap-sm font-mono text-[0.72rem] text-red-text"
    >
      {message}
      <Button size="sm" loading={retrying} onClick={onRetry}>
        Try again
      </Button>
    </p>
  );
}
