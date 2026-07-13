import type { ComponentPropsWithoutRef } from "react";
import type { ExtraProps } from "react-markdown";

// Shared anchor renderer for every markdown surface: links open in a new tab,
// with rel="noopener noreferrer" to prevent the opened page from accessing
// window.opener and to suppress referrer leakage.
export default function MarkdownLink({
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"a"> & ExtraProps) {
  return <a {...props} target="_blank" rel="noopener noreferrer" />;
}
