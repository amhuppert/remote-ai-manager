"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type TouchEvent as ReactTouchEvent,
  type MutableRefObject,
} from "react";

interface LongPressPoint {
  x: number;
  y: number;
}

export interface UseLongPressOptions {
  onLongPress: (point: LongPressPoint) => void;
  thresholdMs?: number;
  slopPx?: number;
}

interface LongPressHandlers {
  onTouchStart: (event: ReactTouchEvent<HTMLElement>) => void;
  onTouchMove: (event: ReactTouchEvent<HTMLElement>) => void;
  onTouchEnd: (event: ReactTouchEvent<HTMLElement>) => void;
  onTouchCancel: (event: ReactTouchEvent<HTMLElement>) => void;
}

export interface UseLongPressResult {
  handlers: LongPressHandlers;
  didLongPressRef: MutableRefObject<boolean>;
}

const DEFAULT_THRESHOLD_MS = 500;
const DEFAULT_SLOP_PX = 10;

export function useLongPress({
  onLongPress,
  thresholdMs = DEFAULT_THRESHOLD_MS,
  slopPx = DEFAULT_SLOP_PX,
}: UseLongPressOptions): UseLongPressResult {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<LongPressPoint | null>(null);
  const didLongPressRef = useRef<boolean>(false);
  const onLongPressRef = useRef(onLongPress);

  useEffect(() => {
    onLongPressRef.current = onLongPress;
  }, [onLongPress]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearTimer();
    };
  }, [clearTimer]);

  const handlers = useMemo<LongPressHandlers>(
    () => ({
      onTouchStart: (event) => {
        const touch = event.touches[0];
        if (!touch) return;
        didLongPressRef.current = false;
        startRef.current = { x: touch.clientX, y: touch.clientY };
        clearTimer();
        timerRef.current = setTimeout(() => {
          const point = startRef.current;
          if (!point) return;
          didLongPressRef.current = true;
          onLongPressRef.current(point);
        }, thresholdMs);
      },
      onTouchMove: (event) => {
        const start = startRef.current;
        if (!start) return;
        const touch = event.touches[0];
        if (!touch) return;
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        if (dx * dx + dy * dy > slopPx * slopPx) {
          clearTimer();
          startRef.current = null;
        }
      },
      onTouchEnd: () => {
        clearTimer();
        startRef.current = null;
      },
      onTouchCancel: () => {
        clearTimer();
        startRef.current = null;
      },
    }),
    [clearTimer, slopPx, thresholdMs],
  );

  return { handlers, didLongPressRef };
}
