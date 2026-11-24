import React, {
  useEffect,
  useState,
  createContext,
  useContext,
  useRef,
} from "react";
export type Data = Record<string, any>;
let token = "";
export async function api(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  if (method !== "GET" && !token) token = (await api("/session")).token;
  const res = await fetch("/api/v1" + path, {
    method,
    headers:
      body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-Continuum-Token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await res.json();
  if (!res.ok) throw Error(value.error || "请求失败");
  return value.data;
}
export type Scope = {
  kind: "all" | "goal" | "story" | "approval";
  ref: string;
  goalId?: string;
  title: string;
};
export const globalScope: Scope = {
  kind: "all",
  ref: "all",
  title: "全部工作",
};
export const AppCtx = createContext({
  revision: 0,
  update: () => {},
  notice: (_s: string) => {},
  chat: (_s: Scope) => {},
});
export const useApp = () => useContext(AppCtx);
export function useLoad<T>(key: string, load: () => Promise<T>) {
  const { revision } = useApp(),
    [state, set] = useState<{ key: string; data?: T; error?: string }>({ key });
  const ref = useRef(load);
  ref.current = load;
  useEffect(() => {
    let active = true;
    ref
      .current()
      .then((data) => {
        if (active) set({ key, data });
      })
      .catch((e) => {
        if (active) set({ key, error: e.message });
      });
    return () => {
      active = false;
    };
  }, [key, revision]);
  return state.key === key ? state : { key };
}
export function useData<T = Data[]>(path: string) {
  return useLoad<T>(path, () => api(path));
}
export function Status({ error }: { error?: string }) {
  return (
    <div className="empty" role="status">
      {error || "正在读取本地记录…"}
    </div>
  );
}
export const dt = (s: string) =>
  new Date(s).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
export const clock = (s: string) =>
  new Date(s).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
export const names: Record<string, string> = {
  active: "进行中",
  draft: "草稿",
  paused: "已暂停",
  blocked: "受阻",
  completed: "已完成",
  archived: "已归档",
  running: "执行中",
  starting: "启动中",
  queued: "排队中",
  waiting_approval: "等待审批",
  succeeded: "执行成功",
  interrupted: "已中断",
  unknown: "待核对",
  failed: "执行失败",
  pending: "待处理",
  deferred: "稍后处理",
  approved: "已批准",
  denied: "已拒绝",
  expired: "已过期",
  cancelled: "已取消",
  resolved: "已解决",
  verified: "已验证",
  disputed: "验证失败",
  reported: "代理报告",
  unverified: "待验证",
  outcome: "成果",
  risk: "风险",
  change: "变更",
  insight: "发现",
  decision: "决策",
  enabled: "已启用",
  disabled: "已停止",
  sent: "已发送",
  dispatching: "发送中",
  ready: "可用",
  unchecked: "尚未检查",
  unavailable: "连接不可用",
  info: "信息",
  warning: "警告",
  error: "错误",
};
export function Badge({ value }: { value: string }) {
  return <span className={"badge b-" + value}>{names[value] || value}</span>;
}
export function Provider({ value }: { value: string }) {
  return (
    <span className="provider">{value === "demo" ? "DEMO" : "CODEX"}</span>
  );
}
export function Action({
  children,
  run,
  className = "",
  disabled = false,
}: {
  children: React.ReactNode;
  run: () => Promise<unknown>;
  className?: string;
  disabled?: boolean;
}) {
  const [busy, set] = useState(false),
    { update, notice } = useApp();
  return (
    <button
      className={className}
      disabled={disabled || busy}
      onClick={async () => {
        set(true);
        try {
          await run();
          update();
        } catch (e) {
          notice((e as Error).message);
        } finally {
          set(false);
        }
      }}
    >
      {children}
    </button>
  );
}
export function Head({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      <div className="actions">{children}</div>
    </header>
  );
}
export function Form({
  onSubmit,
  children,
}: {
  onSubmit: (f: FormData) => Promise<void>;
  children: React.ReactNode;
}) {
  const [err, setErr] = useState(""),
    [busy, setBusy] = useState(false),
    { update } = useApp();
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setBusy(true);
        setErr("");
        try {
          await onSubmit(f);
          update();
        } catch (e) {
          setErr((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={busy}>{children}</fieldset>
      {err && (
        <p role="alert" className="error">
          {err}
        </p>
      )}
    </form>
  );
}
export const field = (f: FormData, key: string) =>
  String(f.get(key) || "").trim();
export function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section className="dialog">
        <div className="section-head">
          <h2>{title}</h2>
          <button aria-label="关闭" onClick={close}>
            关闭
          </button>
        </div>
        {children}
      </section>
    </dialog>
  );
}
