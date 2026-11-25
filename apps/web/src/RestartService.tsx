import React, { useEffect, useState } from "react";
import { api, Modal, useApp } from "./lib.tsx";

const pendingKey = "continuum-restarting-instance";
export function RestartService({
  instance,
  canRestart,
}: {
  instance: string;
  canRestart: boolean;
}) {
  const { notice } = useApp();
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [waiting, setWaiting] = useState(() => sessionStorage.getItem(pendingKey)),
    [error, setError] = useState("");

  useEffect(() => {
    if (!waiting) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 120_000;
    const check = async () => {
      try {
        const r = await fetch("/api/v1/health", {
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(3000),
          ]),
        });
        const h = r.ok && (await r.json()).data;
        if (
          h?.ready === true &&
          typeof h.instance === "string" &&
          h.instance !== waiting
        ) {
          sessionStorage.removeItem(pendingKey);
          sessionStorage.setItem("continuum-restarted", "1");
          location.reload(); // load current assets and discard the previous session token
          return;
        }
      } catch {
        /* Connection loss during shutdown is expected. */
      }
      if (controller.signal.aborted) return;
      if (Date.now() < deadline) timer = setTimeout(check, 750);
      else {
        sessionStorage.removeItem(pendingKey);
        setWaiting(null);
        setError(
          "尚未确认新服务就绪。请刷新页面重新检查，或查看本机服务日志。",
        );
      }
    };
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [waiting]);

  useEffect(() => {
    if (sessionStorage.getItem("continuum-restarted")) {
      sessionStorage.removeItem("continuum-restarted");
      notice("本地服务已重启并就绪");
    }
  }, [notice]);
  async function restart() {
    setConfirm(false);
    setBusy(true);
    setError("");
    sessionStorage.setItem(pendingKey, instance);
    try {
      const accepted = await api("/system/restart", { instance });
      setWaiting(accepted.instance);
    } catch (e) {
      if (e instanceof TypeError)
        setWaiting(instance); // lost response: check, don't resend
      else {
        sessionStorage.removeItem(pendingKey);
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        disabled={!canRestart || busy || !!waiting}
        onClick={() => setConfirm(true)}
      >
        {busy || waiting ? "等待服务重启…" : "重启服务"}
      </button>
      {!canRestart && <p className="muted">当前启动方式不支持页面重启。</p>}
      {waiting && !error && (
        <p role="status">正在等待新服务就绪，本页会自动刷新。</p>
      )}
      {error && <p role="alert">{error}</p>}
      {confirm && (
        <Modal title="重启本地服务？" close={() => setConfirm(false)}>
          <p>
            页面会短暂断开。已保存的委托和排期会保留，执行中的工作可能中断。
          </p>
          <div className="actions">
            <button onClick={() => setConfirm(false)}>取消</button>
            <button className="primary" onClick={restart}>
              确认重启
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
