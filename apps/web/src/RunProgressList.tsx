import React, { useSyncExternalStore } from "react";
import type { RunProgress } from "../../../packages/contracts/src/monitor.ts";
import { useData } from "./lib.tsx";

const visible = () => !document.hidden;
function subscribe(notify: () => void) {
  document.addEventListener("visibilitychange", notify);
  return () => document.removeEventListener("visibilitychange", notify);
}

export function RunProgressList() {
  const showing = useSyncExternalStore(subscribe, visible);
  return showing ? <ProgressRows /> : null;
}

function ProgressRows() {
  const { data, error } = useData<RunProgress>("/conversation/run-progress");
  if (!data?.length || error) return null;
  return (
    <section className="chat-column run-progress" aria-label="运行进展">
      {data.map(row => (
        <a key={row.runId} href={"#run/" + row.runId} title={row.title + " · " + row.detail}>
          <strong>{row.title}</strong>
          <span>{row.detail}</span>
        </a>
      ))}
    </section>
  );
}
