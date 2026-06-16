import { type Components } from "react-markdown";

// Shared anchor renderer for every markdown surface: links open in a new tab,
// with rel="noopener noreferrer" to prevent the opened page from accessing
// window.opener and to suppress referrer leakage.
const MarkdownLink: NonNullable<Components["a"]> = function MarkdownLink({
  node: _node,
  ...props
}) {
  return <a {...props} target="_blank" rel="noopener noreferrer" />;
};

export default MarkdownLink;
