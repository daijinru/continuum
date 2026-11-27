import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, dt, Head, Status } from "./lib.tsx";
import type { MonitorSnapshot, WorkStatus } from "../../../packages/contracts/src/monitor.ts";

type Task = MonitorSnapshot["tasks"][number];
const labels: Record<Task["state"], string> = {
  starting: "正在启动",
  running: "执行中",
  watching: "正在检查热榜",
  queued: "等待派发",
  waiting_approval: "等待你的决定",
  unknown: "失联，需核对",
  scheduled: "等待排期",
  idle: "暂无运行",
  paused: "已暂停后续工作",
  blocked: "受阻",
};
const groups: [string, Task["state"][]][] = [
  ["正在工作", ["starting", "running", "watching"]],
  ["需要留意", ["unknown", "waiting_approval", "blocked"]],
  ["等待派发或排期", ["queued", "scheduled"]],
  ["其余委托", ["idle", "paused"]],
];
const number = (n: number) =>
  n.toLocaleString("zh-CN", { maximumFractionDigits: 1 });

function useMonitorSnapshot<T>(path: string) {
  const [data, setData] = useState<T>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const active = useRef(false),
    loading = useRef(false);
  const refresh = useCallback(async () => {
    if (!active.current || loading.current || document.hidden) return;
    loading.current = true;
    setBusy(true);
    try {
      const snapshot: T = await api(path);
      if (active.current) {
        setData(snapshot);
        setError("");
      }
    } catch {
      if (active.current) setError("未能刷新监测数据");
    } finally {
      loading.current = false;
      if (active.current) setBusy(false);
    }
  }, [path]);
  useEffect(() => {
    active.current = true;
    void refresh();
    const timer = setInterval(refresh, 5000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refresh]);
  return { data, error, busy, refresh };
}

export function WorkStatusLink() {
  const { data, error } = useMonitorSnapshot<WorkStatus>("/conversation/work-status");
  if (!data || error) return null;
  const { kind, count, targetId } = data;
  const decision = kind === "decision";
  let href = "#monitor";
  if (decision) href = targetId ? "#inbox/" + targetId : "#inbox";
  else if (targetId) href = "#goal/" + targetId;
  return (
    <a className={"toolbar-link work-status" + (decision ? " needs-decision" : "")} href={href}>
      {count} 项{decision ? "待你决定" : "执行中"}
    </a>
  );
}

export function Monitor() {
  const { data, error, busy, refresh } = useMonitorSnapshot<MonitorSnapshot>("/system/monitor");
  const procs = data?.processes;
  const working = data?.tasks.filter((t) =>
    groups[0][1].includes(t.state),
  ).length;
  const byRun = new Map(
    data?.tasks.filter((t) => t.runId).map((t) => [t.runId, t]),
  );
  return (
    <>
      <Head title="运行监测" sub="查看此刻的本机资源，以及每项委托在做什么。">
        <button onClick={refresh} disabled={busy}>
          {busy ? "正在刷新…" : "刷新"}
        </button>
      </Head>
      {!data ? (
        <Status error={error} />
      ) : (
        <>
          <p className="meta">
            {error ? error + "，以下是上次快照。" : "本页可见时每 5 秒刷新。"}{" "}
            采样于{" "}
            {new Date(data.sampledAt).toLocaleTimeString("zh-CN", {
              hour12: false,
            })}
          </p>
          <section className="panel pad">
            <h2>
              {working
                ? `${working} 项委托正在工作`
                : "当前没有已确认在执行的委托"}
            </h2>
            {procs ? (
              <p>
                <strong>
                  CPU {number(procs.reduce((n, p) => n + p.cpu, 0))}%
                </strong>{" "}
                · 常驻内存 {number(procs.reduce((n, p) => n + p.rssMiB, 0))} MiB
                · {procs.length} 个进程
              </p>
            ) : (
              <p role="status">本次无法读取进程占用；委托状态仍可查看。</p>
            )}
            {!data.tasks.length ? (
              <p>目前没有需要照看的委托。</p>
            ) : (
              groups.map(([group, states]) => {
                const tasks = data.tasks.filter((t) =>
                  states.includes(t.state),
                );
                if (!tasks.length) return null;
                return (
                  <details key={group} open={group !== "其余委托"}>
                    <summary>
                      {group} · {tasks.length}
                    </summary>
                    {tasks.map((t) => (
                      <div className="listrow" key={t.id}>
                        <div className="grow">
                          <a href={"#goal/" + t.id}>{t.title}</a>
                          <p>
                            {labels[t.state]}
                            {t.demo ? " · DEMO" : ""}
                            {t.nextAt && t.state === "scheduled"
                              ? " · 原定 " + dt(t.nextAt)
                              : ""}
                          </p>
                        </div>
                        {t.runId && <a href={"#run/" + t.runId}>查看运行</a>}
                      </div>
                    ))}
                  </details>
                );
              })
            )}
          </section>
          <section className="panel pad">
            <h2>本机进程</h2>
            {procs && (
              <details>
                <summary>查看进程明细</summary>
                {procs.map((p) => (
                  <div className="listrow" key={p.pid}>
                    <div className="grow">
                      <strong>
                        {
                          {
                            service: "工作台服务与调度器",
                            executor: "Codex 执行器",
                            helper: "工作台子进程",
                          }[p.role]
                        }
                      </strong>
                      <p>
                        PID {p.pid} · CPU {number(p.cpu)}% · {number(p.rssMiB)}{" "}
                        MiB
                      </p>
                      {p.runId && (
                        <a href={"#run/" + p.runId}>
                          {byRun.get(p.runId)?.title || "关联运行"}
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </details>
            )}
            <p className="muted">
              只统计本服务及其当前子进程，不含浏览器和其他 Codex 会话。CPU
              为系统报告值，100% 约为一个核心；内存按进程相加，共享页可能重复。
            </p>
            <p className="muted">
              等待排期不会为每项委托常驻一个执行器；等待决定时，已有执行器可能仍保留在内存中。
            </p>
          </section>
        </>
      )}
    </>
  );
}
