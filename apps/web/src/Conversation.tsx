import React, { useState, useEffect, useRef } from "react";
import { api, dt, Head, useData, type Data } from "./lib.tsx";
import { Markdown } from "./Markdown.tsx";

export function Conversation({ focus }: { focus?: string }) {
  const { data: settings } = useData<Data>("/settings");
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
    end = useRef<HTMLDivElement>(null),
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
    const scroll = () => {
      pinned.current =
        document.documentElement.scrollHeight -
          window.innerHeight -
          window.scrollY <
        200;
    };
    window.addEventListener("scroll", scroll);
    return () => window.removeEventListener("scroll", scroll);
  }, []);
  useEffect(() => {
    if (pinned.current && messages.length)
      end.current?.scrollIntoView({ block: "end" });
  }, [messages.at(-1)?.seq]);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/conversation/messages", {
        key: requestKey.current,
        text: text.trim(),
        ...(reply ? { replyTo: reply.id } : focus ? { focus } : {}),
        ...(workspace ? { workspaceId: workspace } : {}),
      });
      setText("");
      sessionStorage.removeItem("main-draft");
      setReply(null);
      setWorkspace("");
      requestKey.current = crypto.randomUUID();
      if (focus) location.hash = "chat";
      pinned.current = true;
      merge(await api("/conversation"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Head title="主对话" sub="在这里交代事情、问进度，或接着上一次的结果说。">
        <a className="btn" href="#today">
          今天的简报
        </a>
      </Head>
      <div className="conversation">
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
          <section className="panel pad">
            <h2>有什么事要我照看？</h2>
            <p>可以从一句「现在有哪些委托，进度怎么样？」开始。</p>
          </section>
        )}
        {offline && <p role="status">暂时连不上工作台，正在重连。</p>}
        {messages.map((m) => (
          <article key={m.id} className={"chat-message " + m.role}>
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
              <time>{dt(m.created)}</time>
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
                {m.refs.map((g: Data) => (
                  <a key={g.id} href={"#goal/" + g.id}>
                    {g.title}
                  </a>
                ))}
                {m.origin?.startsWith("inbox:") && (
                  <a href={"#inbox/" + m.origin.slice(6)}>查看请求</a>
                )}
                {m.origin?.startsWith("run:") && (
                  <a href={"#run/" + m.origin.slice(4)}>查看依据</a>
                )}
                {m.refs.length > 0 && (
                  <button
                    onClick={() => {
                      setReply(m);
                      requestKey.current = crypto.randomUUID();
                      editor.current?.focus();
                    }}
                  >
                    回复这条
                  </button>
                )}
              </div>
            )}
          </article>
        ))}
        <div ref={end} />
        <form className="main-composer panel pad" onSubmit={send}>
          {(reply || focus) && (
            <div className="meta">
              接着说：
              {reply ? reply.body.slice(0, 75) : target?.title || "这项委托"}{" "}
              <button
                type="button"
                onClick={() => {
                  setReply(null);
                  if (focus) location.hash = "chat";
                }}
              >
                取消关联
              </button>
            </div>
          )}
          <label>
            发到主对话
            <textarea
              aria-label="发到主对话"
              name="message"
              ref={editor}
              value={text}
              disabled={busy}
              onChange={(e) => {
                setText(e.target.value);
                sessionStorage.setItem("main-draft", e.target.value);
                requestKey.current = crypto.randomUUID();
              }}
              maxLength={4000}
              rows={2}
              placeholder="例如：留意 GitHub 热榜上适合普通人用的工具。另外，周五上午提醒我准备周会。"
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <details>
            <summary>使用已有项目（可选）</summary>
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
          <button className="primary" disabled={busy || !text.trim()}>
            {busy ? "正在理解…" : "发送"}
          </button>
        </form>
      </div>
    </>
  );
}
