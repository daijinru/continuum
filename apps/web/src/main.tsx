import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PanelTop,
  Target,
  Inbox as Tray,
  Activity as Pulse,
  Settings as Gear,
  Monitor,
  ChevronRight,
  Sun,
  Moon,
  PanelLeftClose,
  Menu,
  Send,
  Infinity as Loop,
} from "lucide-react";
import {
  api,
  AppCtx,
  Form,
  field,
  Modal,
  useData,
  type Scope,
} from "./lib.tsx";
import { Today } from "./Feed.tsx";
import { Planner } from "./Planner.tsx";
import { Goal, Goals } from "./Goals.tsx";
import { Activity, Inbox, Run, Settings } from "./Inspect.tsx";
import "./style.css";
const routes = [
  ["today", "今天", PanelTop],
  ["goals", "我的委托", Target],
  ["inbox", "收件箱", Tray],
  ["activity", "活动记录", Pulse],
  ["settings", "设置", Gear],
] as const;
function Composer({ scope, close }: { scope: Scope; close: () => void }) {
  const { data } = useData("/goals");
  return (
    <Modal title="发送跟进指令" close={close}>
      <div className="scope">上下文 · {scope.title}</div>
      <Form
        onSubmit={async (f) => {
          const goalId = scope.goalId || field(f, "goalId");
          await api("/chat/messages", {
            scope: scope.kind,
            ref: scope.ref,
            goalId,
            content: field(f, "content"),
          });
          close();
          location.hash = "goal/" + goalId;
        }}
      >
        {!scope.goalId && (
          <label>
            发送到目标
            <select required name="goalId" defaultValue="">
              <option value="" disabled>
                选择接收指令的目标
              </option>
              {data?.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          跟进指令
          <textarea
            autoFocus
            required
            name="content"
            rows={5}
            placeholder="希望下一轮执行什么？"
          />
        </label>
        <p className="muted">
          指令会保存在目标历史中，并在当前运行结束后执行。
        </p>
        <button className="primary">
          <Send size={15} />
          发送指令
        </button>
      </Form>
    </Modal>
  );
}
function App() {
  const [route, setRoute] = useState(location.hash.slice(1) || "today"),
    [revision, setRev] = useState(0),
    [scope, setScope] = useState<Scope | null>(null),
    [notice, setNotice] = useState(""),
    [live, setLive] = useState(false),
    [menu, setMenu] = useState(false);
  const [dark, setDark] = useState(
    localStorage.getItem("continuum-theme") === "dark",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("continuum-theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    const change = () => {
      setRoute(location.hash.slice(1) || "today");
      setMenu(false);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const es = new EventSource(
      "/api/v1/stream?cursor=" +
        Number(sessionStorage.getItem("continuum-seq") || 0),
    );
    es.onopen = () => {
      setLive(true);
      setRev((v) => v + 1);
    };
    es.onerror = () => setLive(false);
    es.addEventListener("change", (e) => {
      sessionStorage.setItem("continuum-seq", e.lastEventId);
      clearTimeout(timer);
      timer = setTimeout(() => setRev((x) => x + 1), 80);
    });
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, []);
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(""), 5000);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  const [page, id] = route.split("/"),
    section = page === "goal" ? "goals" : page === "run" ? "activity" : page;
  const label = routes.find((r) => r[0] === section)?.[1] || "本地工作台";
  return (
    <AppCtx.Provider
      value={{
        revision,
        update: () => setRev((v) => v + 1),
        notice: setNotice,
        chat: setScope,
      }}
    >
      <div className="shell">
        <aside className={menu ? "open" : ""}>
          <a className="brand" href="#today">
            <span className="symbol">
              <Loop size={27} strokeWidth={2.4} />
            </span>
            Continuum
          </a>
          <div className="workspace-tag">
            <Monitor size={16} />
            <span>本地工作台</span>
          </div>
          <nav>
            {routes
              .filter(([key]) => key === "today" || key === "goals")
              .map(([key, title, Icon]) => (
                <a
                  className={section === key ? "active" : ""}
                  href={"#" + key}
                  key={key}
                >
                  <Icon size={18} />
                  {title}
                </a>
              ))}
          </nav>
          <div className="aside-bottom">
            <details className="secondary-nav">
              <summary>更多工具</summary>
              <nav>
                <a href="#inbox">
                  <Tray size={16} />
                  收件箱
                </a>
                <a href="#activity">
                  <Pulse size={16} />
                  活动记录
                </a>
              </nav>
            </details>
            <nav>
              <a
                className={section === "settings" ? "active" : ""}
                href="#settings"
              >
                <Gear size={18} />
                设置
              </a>
            </nav>
            <div className="connection">
              <span className={"light " + (live ? "on" : "")} />
              {live ? "本地服务在线" : "正在连接本地服务"}
            </div>
          </div>
        </aside>
        <div className="surface">
          <div className="topbar">
            <div>
              <button
                className="mobile"
                aria-label="切换导航"
                onClick={() => setMenu(!menu)}
              >
                {menu ? <PanelLeftClose size={18} /> : <Menu size={18} />}
              </button>
              <Monitor size={16} />
              <span>工作台</span>
              <ChevronRight size={13} />
              <b>{label}</b>
            </div>
            <button aria-label="切换明暗主题" onClick={() => setDark(!dark)}>
              {dark ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </div>
          <main key={page}>
            {page === "today" ? (
              <Today />
            ) : page === "goals" ? (
              <Goals />
            ) : page === "goal" ? (
              <Goal key={id} id={id} />
            ) : page === "inbox" ? (
              <Inbox id={id} />
            ) : page === "activity" ? (
              <Activity />
            ) : page === "planner" ? (
              <Planner />
            ) : page === "run" ? (
              <Run id={id} />
            ) : page === "settings" ? (
              <Settings />
            ) : (
              <a href="#today">返回今日简报</a>
            )}
          </main>
        </div>
      </div>
      {scope && <Composer scope={scope} close={() => setScope(null)} />}{" "}
      {notice && (
        <div role="status" className="toast">
          {notice}
        </div>
      )}
    </AppCtx.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
