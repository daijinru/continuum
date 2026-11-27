import { logPage, pageId } from "./conversation-log.ts";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PanelTop,
  Target,
  Inbox as Tray,
  Activity as Pulse,
  Settings as Gear,
  MessageCircle,
  Sun,
  Moon,
  PanelLeftClose,
  Menu,
} from "lucide-react";
import { AppCtx } from "./lib.tsx";
import { Monitor, WorkStatusLink } from "./Monitor.tsx";
import { DevUpdateNotice } from "./DevUpdateNotice.tsx";
import { Today } from "./Feed.tsx";
import { Conversation } from "./Conversation.tsx";
import { Goal, Goals } from "./Goals.tsx";
import { Activity, Inbox, Run, Settings } from "./Inspect.tsx";
import "./style.css";
const routes = [
  ["chat", "主对话", MessageCircle],
  ["today", "今天", PanelTop],
  ["goals", "我的委托", Target],
  ["inbox", "收件箱", Tray],
  ["activity", "活动记录", Pulse],
  ["monitor", "运行监测", Pulse],
  ["settings", "设置", Gear],
] as const;
function App() {
  const [route, setRoute] = useState(location.hash.slice(1) || "chat"),
    [revision, setRev] = useState(0),
    [notice, setNotice] = useState(""),
    [live, setLive] = useState(false),
    [menu, setMenu] = useState(false);
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem("continuum-theme");
    return saved
      ? saved === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
  });
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      if (!localStorage.getItem("continuum-theme")) setDark(mq.matches);
    };
    mq.addEventListener("change", sync);
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    window.addEventListener("keydown", esc);
    return () => {
      mq.removeEventListener("change", sync);
      window.removeEventListener("keydown", esc);
    };
  }, []);
  useEffect(() => {
    const change = () => {
      setRoute(location.hash.slice(1) || "chat");
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
        Number(sessionStorage.getItem("continuum-seq") || 0) + "&page=" + pageId,
    );
    es.onopen = () => {
      logPage("connected");
      setLive(true);
      setRev((v) => v + 1);
    };
    es.onerror = () => {
      logPage("disconnected");
      setLive(false);
      window.dispatchEvent(new Event("conversation-disconnected"));
    };
    es.addEventListener("conversation", e => {
      logPage("notice", { version: Number(e.data) });
      window.dispatchEvent(new CustomEvent("conversation-changed", { detail: Number(e.data) }));
    });
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
        chat: (s) => {
          location.hash = s.goalId ? "chat/" + s.goalId : "chat";
        },
      }}
    >
      <div className="shell">
        <aside id="navigation" className={menu ? "open" : ""}>
          <a className="brand" href="#chat">
            <img src="/favicon.png" width="30" height="30" alt="" />
            Continuum
          </a>
          <div className="workspace-tag">
            <span>工作台</span>
          </div>
          <nav>
            {routes
              .filter(([key]) => key === "chat" || key === "goals")
              .map(([key, title, Icon]) => (
                <a
                  className={section === key ? "active" : ""}
                  aria-current={section === key ? "page" : undefined}
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
                <a
                  href="#today"
                  aria-current={section === "today" ? "page" : undefined}
                >
                  <PanelTop size={16} />
                  今天
                </a>
                <a
                  href="#inbox"
                  aria-current={section === "inbox" ? "page" : undefined}
                >
                  <Tray size={16} />
                  收件箱
                </a>
                <a
                  href="#activity"
                  aria-current={section === "activity" ? "page" : undefined}
                >
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
            <a className="connection" href="#monitor" aria-current={section === "monitor" ? "page" : undefined}>
              <span className={"light " + (live ? "on" : "")} />
              <span className="connection-copy">
                运行监测
                <small>{live ? "本地服务在线" : "正在连接本地服务"}</small>
              </span>
            </a>
          </div>
        </aside>
        {menu && (
          <button
            className="nav-scrim"
            onClick={() => setMenu(false)}
            aria-label="关闭导航"
          />
        )}
        <div className={"surface" + (page === "chat" ? " chat-surface" : "")}>
          <div className="topbar">
            <div>
              <button
                className="mobile"
                aria-label="切换导航"
                aria-expanded={menu}
                aria-controls="navigation"
                onClick={() => setMenu(!menu)}
              >
                {menu ? <PanelLeftClose size={18} /> : <Menu size={18} />}
              </button>
              {page === "chat" ? <h1>{label}</h1> : <b>{label}</b>}
            </div>
            <div>
              {page === "chat" && (
                <>
                  <WorkStatusLink />
                  <a className="toolbar-link" href="#today" aria-label="今日简报" title="今日简报">
                    <PanelTop size={15} /> <span className="brief-label">今日简报</span>
                  </a>
                </>
              )}
              <button
                aria-label="切换明暗主题"
                title="切换明暗主题"
                onClick={() => {
                  localStorage.setItem(
                    "continuum-theme",
                    dark ? "light" : "dark",
                  );
                  setDark(!dark);
                }}
              >
                {dark ? <Sun size={17} /> : <Moon size={17} />}
              </button>
            </div>
          </div>
          {import.meta.env.MODE === "desktop-dev" && <DevUpdateNotice />}
          <main key={page}>
            {page === "chat" ? (
              <Conversation focus={id} live={live} />
            ) : page === "today" ? (
              <Today />
            ) : page === "goals" ? (
              <Goals />
            ) : page === "goal" ? (
              <Goal key={id} id={id} />
            ) : page === "inbox" ? (
              <Inbox id={id} />
            ) : page === "activity" ? (
              <Activity />
            ) : page === "monitor" ? (
              <Monitor />
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
      {notice && (
        <div role="status" className="toast">
          {notice}
        </div>
      )}
    </AppCtx.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
