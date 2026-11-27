import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { markMessageFiles } from "./message-files.ts";

export { documentFile } from "./message-files.ts";
const markdown = unified().use(remarkParse).use(remarkGfm);
export function parseMessageFilePaths(text: string) {
  const files = new Set<string>();
  markMessageFiles(markdown.parse(text), files);
  return files;
}
