"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";

const LazyMarkdownContentImpl = dynamic(() => import("./MarkdownContent"), {
  ssr: false,
});

export default function LazyMarkdownContent({
  content,
}: {
  content: string;
}): React.JSX.Element {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void import("./MarkdownContent").then(() => {
      if (!cancelled) setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!loaded) {
    return <pre className="markdown-loading">{content}</pre>;
  }
  return <LazyMarkdownContentImpl content={content} />;
}
