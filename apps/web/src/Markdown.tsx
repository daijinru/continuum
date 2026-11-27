import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { ImagePreview } from "./ImagePreview.tsx";
import {
  documentFile,
  previewImage,
  remarkMessageFiles,
} from "../../../packages/contracts/src/message-files.ts";
import { api } from "./lib.tsx";

export function Markdown({
  text,
  messageId,
}: {
  text: string;
  messageId?: string;
}) {
  const [error, setError] = useState("");
  async function openFile(path: string) {
    setError("");
    try {
      await api("/conversation/messages/" + messageId + "/open-file", { path });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function preview(path: string, alt?: string) {
    return (
      <ImagePreview
        src={
          "/api/v1/conversation/messages/" +
          messageId +
          "/image?path=" +
          encodeURIComponent(path)
        }
        alt={alt || path.split("/").pop() || path}
      />
    );
  }
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={
          messageId ? [remarkGfm, remarkMessageFiles] : [remarkGfm]
        }
        skipHtml
        components={{
          a: ({ href, children, node }) => {
            const file = node?.properties["data-message-file"];
            if (messageId && typeof file === "string") {
              const open = documentFile.test(file) ? (
                <button
                  type="button"
                  className="message-file"
                  title={"打开文件 " + file}
                  onClick={() => void openFile(file)}
                >
                  {children}
                </button>
              ) : (
                children
              );
              return previewImage.test(file) ? (
                <span className="reply-image">
                  {preview(file)}
                  {open}
                </span>
              ) : (
                open
              );
            }
            return href && /^https?:\/\//i.test(href) ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <>{children}</>
            );
          },
          img: ({ alt, node }) => {
            const path = node?.properties["data-message-file"];
            return messageId && typeof path === "string" ? (
              preview(path, alt)
            ) : (
              <>{alt}</>
            );
          },
          table: ({ children }) => (
            <div className="markdown-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
