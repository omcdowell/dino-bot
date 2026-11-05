import type { ComponentType } from "react";
import type { MarkdownProps } from "@getpaseo/plugin/client/ui";

// Upstream 995ad2f87 (feat(plugin): render Markdown content with host UI), backported. The renderer
// loads on first render, as dictation does, so evaluating the plugin runtime pulls in no markdown
// stack (react-native-markdown-display cannot load under vitest) and adds no import cycle.
function loadRenderer(): ComponentType<{ text: string }> {
  return (
    require("../../components/markdown/renderer") as {
      MarkdownRenderer: ComponentType<{ text: string }>;
    }
  ).MarkdownRenderer;
}

export function Markdown({ children }: MarkdownProps) {
  if (!children) return null;
  const MarkdownRenderer = loadRenderer();
  return <MarkdownRenderer text={children} />;
}
