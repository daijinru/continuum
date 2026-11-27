import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { remarkMessageFiles } from "../../../packages/contracts/src/message-files.ts";
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
            if (messageId && typeof file === "string")
              return (
                <button
                  type="button"
                  className="message-file"
                  title={"打开文件 " + file}
                  onClick={() => void openFile(file)}
                >
                  {children}
                </button>
              );
            return href && /^https?:\/\//i.test(href) ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <>{children}</>
            );
          },
          img: ({ alt }) => <>{alt}</>,
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
