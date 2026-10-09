"use client";

import { useRef, useState } from "react";

/**
 * A person's action on the run: shown as working until the server answers,
 * one at a time, with the server's refusal kept beside the control that sent it.
 */
export function useAwaitedAction<Key extends string>() {
  const [pending, setPending] = useState<Key | null>(null);
  const [refusal, setRefusal] = useState<{
    key: Key;
    message: string;
  } | null>(null);
  // A second click in the same tick happens before `pending` renders.
  const inFlight = useRef(false);
  const act = async (
    key: Key,
    action: () => void | Promise<void>,
  ): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(key);
    setRefusal(null);
    try {
      await action();
    } catch (error) {
      setRefusal({
        key,
        message:
          error instanceof Error
            ? error.message
            : "The run did not take that. Refresh the run and try again.",
      });
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };
  return { pending, refusal, act };
}

/** Why the run refused what the person asked. */
export function Refusal({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="m-0 rounded-md border border-solid border-[var(--cc-red-a40)] bg-red-glow px-md py-sm font-mono text-[0.72rem] leading-[1.5] text-red-text"
    >
      {message}
    </p>
  );
}
