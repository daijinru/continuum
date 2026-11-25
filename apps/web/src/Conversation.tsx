import React, { useState, useEffect, useRef } from "react";
import { api, useApp, useData, type Data } from "./lib.tsx";
import { tokenTotal } from "./TokenUsage.tsx";
import {
  ArrowUp,
  CornerUpLeft,
  Folder,
  Infinity as Loop,
  X,
} from "lucide-react";
import { Markdown } from "./Markdown.tsx";

export function Conversation({ focus }: { focus?: string }) {
  const { data: settings } = useData<Data>("/settings");
  const { update } = useApp();
  const [workspace, setWorkspace] = useState("");
  const [messages, setMessages] = useState<Data[]>([]),
    [more, setMore] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [text, setText] = useState(
      () => sessionStorage.getItem("main-draft") || "",
    ),
    [reply, setReply] = useState<Data | null>(null),
    [target, setTarget] = useState<Data | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [offline, setOffline] = useState(false);
  const requestKey = useRef(crypto.randomUUID()),
    stream = useRef<HTMLDivElement>(null),
    pinned = useRef(true),
    editor = useRef<HTMLTextAreaElement>(null);
  const merge = (rows: Data[]) =>
    setMessages((old) =>
      [...new Map([...old, ...rows].map((r) => [r.id, r])).values()].sort(
        (a, b) => a.seq - b.seq,
      ),
    );
  useEffect(() => {
    let alive = true,
      fetching = false,
      first = true;
    const load = async () => {
      if (fetching || document.hidden) return;
      fetching = true;
      try {
        const data = await api("/conversation");
        if (alive) {
          merge(data);
          setLoaded(true);
          setOffline(false);
          if (first) setMore(data.length === 80);
          first = false;
        }
      } catch {
        if (alive) setOffline(true);
      } finally {
        fetching = false;
      }
    };
    void load();
    const timer = setInterval(load, 2500);
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);
  useEffect(() => {
    let alive = true;
    setTarget(null);
    if (focus)
      api("/goals/" + focus)
        .then((g) => {
          if (alive) setTarget(g);
        })
        .catch(() => {
          if (alive) setError("找不到这项委托");
        });
    return () => {
      alive = false;
    };
  }, [focus]);
  useEffect(() => {
    const focusEditor = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "k" &&
        !document.querySelector("dialog[open]")
      ) {
        e.preventDefault();
        editor.current?.focus();
      }
    };
    window.addEventListener("keydown", focusEditor);
    return () => window.removeEventListener("keydown", focusEditor);
  }, []);
  useEffect(() => {
    if (pinned.current && messages.length && stream.current)
      stream.current.scrollTop = stream.current.scrollHeight;
  }, [messages.at(-1)?.seq]);
  const send = async (quick = false) => {
    if ((!quick && !text.trim()) || busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/conversation/messages", {
        key: quick ? crypto.randomUUID() : requestKey.current,
        text: quick ? "现在都怎么样了？" : text.trim(),
        ...(!quick && (reply ? { replyTo: reply.id } : focus ? { focus } : {})),
        ...(!quick && workspace ? { workspaceId: workspace } : {}),
      });
      if (!quick) {
        setText("");
        sessionStorage.removeItem("main-draft");
        setReply(null);
        setWorkspace("");
        requestKey.current = crypto.randomUUID();
        if (focus) location.hash = "chat";
      }
      pinned.current = true;
      merge(await api("/conversation"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      update();
    }
  };
  return (
    <div className="conversation">
      <div
        className="chat-stream"
        ref={stream}
        onScroll={(e) => {
          const s = e.currentTarget;
          pinned.current = s.scrollHeight - s.clientHeight - s.scrollTop < 65;
        }}
      >
        <div className="chat-column">
          {more && (
            <button
              onClick={async () => {
                try {
                  const rows = await api(
                    "/conversation?before=" + messages[0].seq,
                  );
                  merge(rows);
                  setMore(rows.length === 80);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              查看更早的消息
            </button>
          )}
          {loaded && !messages.length && (
            <section className="chat-empty">
              <Loop size={30} aria-hidden="true" />
              <h2>有什么事要我照看？</h2>
              <p>交代一件事，或问问现有委托的进度。</p>
            </section>
          )}
          {offline && <p role="status">暂时连不上工作台，正在重连。</p>}
          {messages.map((m, index) => (
            <React.Fragment key={m.id}>
              {(!index ||
                new Date(m.created).toDateString() !==
                  new Date(messages[index - 1].created).toDateString()) && (
                <div className="day-stamp">
                  <time>
                    {new Date(m.created).toLocaleDateString("zh-CN", {
                      month: "long",
                      day: "numeric",
                      weekday: "long",
                    })}
                  </time>
                </div>
              )}
              <article className={"chat-message " + m.role}>
                <div className="meta">
                  <b>
                    {m.role === "user"
                      ? "你"
                      : m.kind === "reminder"
                        ? "提醒"
                        : m.kind === "history"
                          ? "以往交付"
                          : "Continuum"}
                  </b>
                  <time dateTime={m.created}>
                    {new Date(m.created).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </time>
                </div>
                {m.body.length > 800 ? (
                  <>
                    <Markdown text={m.body.split(/\n\s*\n/)[0].slice(0, 360)} />
                    <details>
                      <summary>阅读全文</summary>
                      <Markdown text={m.body} />
                    </details>
                  </>
                ) : (
                  <Markdown text={m.body} />
                )}
                {m.role === "assistant" && (
                  <div className="links">
                    {m.origin?.startsWith("inbox:") && (
                      <a href={"#inbox/" + m.origin.slice(6)}>查看请求</a>
                    )}
                    {m.refs.length > 0 && (
                      <button
                        onClick={() => {
                          setReply(m);
                          requestKey.current = crypto.randomUUID();
                          editor.current?.focus();
                        }}
                      >
                        <CornerUpLeft size={13} /> 回复这条
                      </button>
                    )}
                    {(m.refs.length > 0 || m.origin?.startsWith("run:")) && (
                      <details className="chat-sources">
                        <summary>关联记录</summary>
                        <div>
                          {m.refs.map((g: Data) => (
                            <a key={g.id} href={"#goal/" + g.id}>
                              {g.title}
                            </a>
                          ))}
                          {m.origin?.startsWith("run:") && (
                            <a href={"#run/" + m.origin.slice(4)}>查看依据</a>
                          )}
                        </div>
                      </details>
                    )}
                  </div>
                )}
              </article>
            </React.Fragment>
          ))}
        </div>
      </div>
      <form
        className="main-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="compose-inner">
          {(reply || focus) && (
            <div className="reply-context">
              <CornerUpLeft size={14} />
              <span>
                回复：
                {reply ? reply.body.slice(0, 75) : target?.title || "这项委托"}
              </span>
              <button
                type="button"
                aria-label="取消关联"
                title="取消关联"
                onClick={() => {
                  setReply(null);
                  if (focus) location.hash = "chat";
                }}
              >
                <X size={14} />
              </button>
            </div>
          )}
          <div className="compose-entry">
            <textarea
              aria-label="发到主对话"
              name="message"
              ref={editor}
              value={text}
              readOnly={busy}
              aria-busy={busy}
              onKeyDown={(e) => {
                if (
                  !e.nativeEvent.isComposing &&
                  (e.metaKey || e.ctrlKey) &&
                  e.key === "Enter"
                ) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              onChange={(e) => {
                setText(e.target.value);
                sessionStorage.setItem("main-draft", e.target.value);
                requestKey.current = crypto.randomUUID();
              }}
              maxLength={4000}
              rows={1}
              placeholder="交代事情，或问问进度…"
            />
            <button
              className="send-btn"
              aria-label="发送"
              title="发送（⌘↵）"
              disabled={busy || !text.trim()}
            >
              <ArrowUp size={18} />
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
          <div className="compose-tools">
            <details>
              <summary>
                <Folder size={13} /> {workspace ? "已选项目" : "工作目录"}
              </summary>
              <label>
                新工作使用的目录
                <select
                  value={workspace}
                  onChange={(e) => setWorkspace(e.target.value)}
                >
                  <option value="">独立委托目录</option>
                  {settings?.workspaces
                    .filter((w: Data) => w.enabled)
                    .map((w: Data) => (
                      <option key={w.id} value={w.id}>
                        {w.path}
                      </option>
                    ))}
                </select>
              </label>
            </details>
            <button
              type="button"
              disabled={busy}
              onClick={() => void send(true)}
            >
              问进度
            </button>
            {settings?.usage && <a href="#settings" aria-label="查看主对话 token 用量明细">
              主对话用量：{tokenTotal(settings.usage.conversation)}
            </a>}
            <small role="status">
              {busy ? "正在处理…" : "⌘ K 输入　⌘ ↵ 发送"}
            </small>
          </div>
        </div>
      </form>
    </div>
  );
}
