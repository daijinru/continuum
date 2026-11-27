import React, { useEffect, useState } from "react";
import { useApp } from "./lib.tsx";

type UpdateState = "pending" | "restarting" | "updated";
declare global {
  interface Window {
    continuumDevUpdate?: {
      subscribe(listener: (state: UpdateState) => void): () => void;
      requestRestart(): Promise<void>;
    };
  }
}

export function DevUpdateNotice() {
  const [state, setState] = useState<UpdateState>();
  const { notice } = useApp();
  useEffect(() => window.continuumDevUpdate?.subscribe(setState), []);
  useEffect(() => {
    if (state !== "updated") return;
    const timer = setTimeout(() => setState(undefined), 4500);
    return () => clearTimeout(timer);
  }, [state]);
  if (!state) return null;
  return (
    <div className="dev-update">
      <span role="status">
        {state === "pending"
          ? "开发版有更新，当前委托结束后会自动重启。"
          : state === "restarting"
            ? "正在重启更新…"
            : "开发版已更新。"}
      </span>
      {state === "pending" && (
        <button
          onClick={() =>
            void window.continuumDevUpdate
              ?.requestRestart()
              .catch(() => notice("未能请求重启，请再试一次。"))
          }
        >
          立即重启更新
        </button>
      )}
    </div>
  );
}
