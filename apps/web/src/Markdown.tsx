import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) =>
            href && /^https?:\/\//i.test(href) ? (
              <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
            ) : <>{children}</>,
          img: ({ alt }) => <>{alt}</>,
          table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
        }}
      >{text}</ReactMarkdown>
    </div>
  );
}
