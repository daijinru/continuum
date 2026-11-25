import React from "react";
import type { Data } from "./lib.tsx";

export const tokenTotal = (u: Data) =>
  u.total === null ? "暂无记录" : `${u.total.toLocaleString("zh-CN")} tokens`;

export function TokenUsage({ label, usage }: { label: string; usage: Data }) {
  return (
    <div className="listrow">
      <div className="grow">
        <strong>{label}</strong>
        {usage.total !== null && (
          <p>
            输入 {usage.input.toLocaleString("zh-CN")} · 输出{" "}
            {usage.output.toLocaleString("zh-CN")}
          </p>
        )}
      </div>
      <span>{tokenTotal(usage)}</span>
    </div>
  );
}
