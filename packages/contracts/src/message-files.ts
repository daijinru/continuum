import type { Link, Root, PhrasingContent } from "mdast";
import { SKIP, visit } from "unist-util-visit";

// Launch document formats with a viewer. A reply must never launch a program.
export const documentFile =
  /\.(?:md|markdown|txt|log|csv|tsv|json|ya?ml|xml|pdf|rtf|docx?|xlsx?|pptx?|od[tsp]|png|jpe?g|gif|webp|heic|tiff?|bmp|mp[34]|wav|mov)$/i;

function localDocument(path: string) {
  return (
    path &&
    !/^[a-z][\w+.-]*:|^\/\/|\\/i.test(path) &&
    !Array.from(path).some((char) => char.charCodeAt(0) < 32) &&
    !path.split("/").includes("..") &&
    documentFile.test(path)
  );
}

function linkPath(url: string) {
  try {
    if (/^file:\/\//i.test(url)) {
      const file = new URL(url);
      if (file.hostname || file.search || file.hash) return;
      url = file.pathname;
    }
    const path = decodeURIComponent(url);
    if (localDocument(path)) return path;
  } catch {
    /* An invalid URL stays ordinary Markdown. */
  }
}

// Both the renderer and the open action interpret the saved reply with this
// transform. Code blocks and labels inside external links remain untouched.
export const remarkMessageFiles = () => (tree: Root) => markMessageFiles(tree);

export function markMessageFiles(tree: Root, found?: Set<string>) {
  function mark(link: Link, path: string) {
    found?.add(path);
    link.data = { ...link.data, hProperties: { "data-message-file": path } };
    return link;
  }
  const definitions = new Map<string, string>();
  visit(tree, "definition", (definition) => {
    if (!definitions.has(definition.identifier))
      definitions.set(definition.identifier, definition.url);
  });
  visit(tree, (node, index, parent) => {
    if (node.type === "link") {
      const path = linkPath(node.url);
      if (path) mark(node, path);
      return SKIP;
    }
    if (!parent || index === undefined) return;
    if (node.type === "linkReference") {
      const url = definitions.get(node.identifier);
      const path = url && linkPath(url);
      if (path)
        parent.children[index] = mark({ type: "link", url, children: node.children }, path);
      return SKIP;
    }
    if (node.type === "inlineCode" && localDocument(node.value)) {
      parent.children[index] = mark(
        { type: "link", url: "", children: [node] },
        node.value,
      );
      return SKIP;
    }
    if (node.type !== "text") return;
    const parts: PhrasingContent[] = [];
    let end = 0;
    for (const match of node.value.matchAll(
      /(?<![\p{L}\p{N}_./%-])[\p{L}\p{N}_./%-]+\.[a-zA-Z0-9]+/gu,
    )) {
      const path = match[0];
      if (!localDocument(path)) continue;
      parts.push(
        { type: "text", value: node.value.slice(end, match.index) },
        mark(
          { type: "link", url: "", children: [{ type: "text", value: path }] },
          path,
        ),
      );
      end = match.index + path.length;
    }
    if (!parts.length) return;
    parts.push({ type: "text", value: node.value.slice(end) });
    parent.children.splice(index, 1, ...parts);
    return index + parts.length;
  });
}
