"use client";

import { useEffect, useState, type RefObject } from "react";

export function useCollabPassageVisibility(
  collabRowEl: HTMLDivElement | null,
  panelBodyRef: RefObject<HTMLDivElement | null>,
): boolean {
  const [observerReportedInView, setObserverReportedInView] = useState(false);

  useEffect(() => {
    if (!collabRowEl) return;
    const root = panelBodyRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setObserverReportedInView(entry.isIntersecting);
      },
      { root, threshold: 0 },
    );
    observer.observe(collabRowEl);
    return () => observer.disconnect();
  }, [collabRowEl, panelBodyRef]);

  return collabRowEl !== null && observerReportedInView;
}
