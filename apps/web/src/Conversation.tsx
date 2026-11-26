import { ProjectFolder } from "./ProjectFolder.tsx";
import React, { useState, useEffect, useRef } from "react";
import { api, Form, field, useData, type Data } from "./lib.tsx";
import { ChatApprovals } from "./ChatApprovals.tsx";
import { outgoingRow, queueMessage, reconcileOutbox, retryMessage, useOutbox } from "./conversation-outbox.ts";
import { tokenTotal } from "./TokenUsage.tsx";
import { ArrowUp, ArrowUpRight, ChevronDown, CornerUpLeft, Infinity as Loop, Link2, X } from "lucide-react";
import { Markdown } from "./Markdown.tsx";

export function Conversation({ focus }: { focus?: string }) {
  const { data: settings } = useData<Data>("/settings");
  const outbox = useOutbox();
  const [messages, setMessages] = useState<Data[]>([]),
    [more, setMore] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [text, setText] = useState(
      () => sessionStorage.getItem("main-draft") || "",
    ),
    [reply, setReply] = useState<Data | null>(null),
    [target, setTarget] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [offline, setOffline] = useState(false);
  const draftKey = useRef(crypto.randomUUID()),
    refresh = useRef<() => void>(() => {}),
    earlier = useRef<() => void>(() => {}),
    floor = useRef(0),
    stream = useRef<HTMLDivElement>(null),
    pinned = useRef(true),
    editor = useRef<HTMLTextAreaElement>(null);
  const merge = (rows: Data[], mode: "latest" | "changes" | "history" = "latest") => {
    setMessages(old => {
      const unique = new Map<string, Data>();
      for (const row of old) unique.set(row.approvalGoal ? "approval:" + row.approvalGoal : row.id, row);
      for (const row of rows) {
        if (mode === "changes" && row.seq < floor.current) continue;
        const key = row.approvalGoal ? "approval:" + row.approvalGoal : row.id;
        const known = unique.get(key);
        if (!known || known.seq < row.seq || (known.seq === row.seq && mode !== "history")) unique.set(key, row);
      }
      return [...unique.values()].sort((a, b) => a.seq - b.seq);
    });
    reconcileOutbox(rows);
  };
  const ids = new Set(messages.map(m => m.id));
  const visible = [...messages, ...outbox.filter(e => !ids.has(e.submission.key)).map(outgoingRow)]
    .sort((a, b) => a.seq - b.seq);
  const resolved = async (id: string) => {
    setMessages((old) =>
      old.map((row) => (row.id === id ? { ...row, resolvedBy: true } : row)),
    );
    refresh.current();
  };
  useEffect(() => {
    let alive = true, fetching = false, pending = false, older = false, version: number | undefined;
    let loadedOnce = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (!alive || document.hidden) return;
      if (fetching) { pending = true; return; }
      fetching = true;
      clearTimeout(retry);
      try {
        do {
          pending = false;
          if (older && floor.current) {
            const rows = await api("/conversation?before=" + floor.current);
            older = false;
            if (!alive) return;
            merge(rows, "history");
            floor.current = rows.length === 80 ? rows[0].seq : 0;
            setMore(!!floor.current);
          }
          if (version === undefined) {
            let cursor: string | null = null;
            const rows = await api("/conversation", undefined, "GET", headers => {
              cursor = headers.get("X-Conversation-Version");
            });
            if (!alive) return;
            merge(rows);
            if (!loadedOnce) {
              floor.current = rows.length === 80 ? rows[0].seq : 0;
              setMore(!!floor.current);
              loadedOnce = true;
            }
            setLoaded(true);
            if (cursor !== null) version = Number(cursor);
          } else {
            const batch = await api("/conversation/changes?since=" + version);
            if (!alive) return;
            if (batch.version < version) {
              setMessages([]);
              loadedOnce = false;
              version = undefined;
              pending = true;
            } else {
              if (batch.rows.length) merge(batch.rows.map((row: Data) =>
                row.approvalGoal ? { ...row, approvalRevision: batch.version } : row
              ), "changes");
              version = batch.version;
              pending ||= batch.more;
            }
          }
        } while (pending && !document.hidden);
        setOffline(false);
        // An older local service supplies neither a cursor nor change events.
        if (version === undefined) retry = setTimeout(load, 2500);
      } catch {
        if (alive) {
          setOffline(true);
          retry = setTimeout(load, 2500);
        }
      } finally {
        fetching = false;
      }
    };
    const changed = (event: Event) => {
      setOffline(false);
      if ((event as CustomEvent<number>).detail !== version) void load();
    };
    const disconnected = () => setOffline(true);
    refresh.current = load;
    earlier.current = () => { older = true; void load(); };
    window.addEventListener("conversation-changed", changed);
    window.addEventListener("conversation-disconnected", disconnected);
    document.addEventListener("visibilitychange", load);
    void load();
    return () => {
      alive = false;
      clearTimeout(retry);
      window.removeEventListener("conversation-changed", changed);
      window.removeEventListener("conversation-disconnected", disconnected);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);
  const receipt = outbox.findLast(entry => entry.status === "sent")?.submission.key;
  useEffect(() => { if (receipt) refresh.current(); }, [receipt]);
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
    if (pinned.current && stream.current)
      stream.current.scrollTop = stream.current.scrollHeight;
  }, [visible.at(-1)?.id, visible.at(-1)?.seq]);
  const send = (quick = false) => {
    if (!quick && !text.trim()) return;
    pinned.current = true;
    setError("");
    queueMessage({
      key: quick ? crypto.randomUUID() : draftKey.current, text: quick ? "现在都怎么样了？" : text.trim(),
      ...(!quick && (reply ? { replyTo: reply.id } : focus ? { focus } : {})),
    });
    if (!quick) {
      setText("");
      sessionStorage.removeItem("main-draft");
      setReply(null);
      if (focus) location.hash = "chat";
      editor.current?.focus();
    }
  };
  const replyTo = (m: Data) => { setReply(m); editor.current?.focus(); };
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
              onClick={() => earlier.current()}
            >
              查看更早的消息
            </button>
          )}
          {loaded && !visible.length && (
            <section className="chat-empty">
              <Loop size={30} aria-hidden="true" />
              <h2>有什么事要我照看？</h2>
              <p>交代一件事，或问问现有委托的进度。</p>
            </section>
          )}
          {offline && <p role="status">暂时连不上工作台，正在重连。</p>}
          {visible.map((m, index) => (
            <React.Fragment key={m.approvalGoal ? "approval:" + m.approvalGoal : m.id}>
              {(!index ||
                new Date(m.created).toDateString() !==
                  new Date(visible[index - 1].created).toDateString()) && (
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
              {m.approvalGoal ? <ChatApprovals message={m} reply={() => replyTo(m)} /> : <article className={"chat-message " + m.role}>
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
                  {m.delivery && <span role="status">
                    {{queued: "等待发送", sending: "发送中…", sent: "已发送", failed: "发送未确认"}[m.delivery as string]}
                  </span>}
                </div>
                {m.body.length > 800 ? (
                  <div className="long-message">
                    <div className="excerpt"><Markdown text={m.body.split(/\n\s*\n/)[0].slice(0, 360)} /></div>
                    <details className="read-more">
                      <summary>阅读全文</summary>
                      <Markdown text={m.body} />
                    </details>
                  </div>
                ) : (
                  <Markdown text={m.body} />
                )}
                {m.delivery === "failed" && <div className="links">
                  <span role="alert">{m.error}</span>
                  <button onClick={() => retryMessage(m.id)}>重试发送</button>
                </div>}
                {m.kind === "project" && !m.resolvedBy && settings && (
                  <ProjectQuestion
                    message={m}
                    projects={settings.workspaces}
                    canChooseFolder={settings.service.canChooseFolder}
                    onResolved={() => resolved(m.id)}
                  />
                )}
                {m.kind === "directory" && (
                  <>
                    <p>
                      原项目目录 <code>{m.directoryPath}</code>
                    </p>
                    {m.directoryResolvedAt || m.resolvedBy ? (
                      <small>目录已确认</small>
                    ) : (
                      !!m.canRecover && (
                        <DirectoryQuestion
                          message={m}
                          canChooseFolder={!!settings?.service.canChooseFolder}
                          onResolved={() => resolved(m.id)}
                        />
                      )
                    )}
                  </>
                )}
                {m.role === "assistant" && <MessageLinks message={m} reply={() => replyTo(m)} />}
              </article>}
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
                draftKey.current = crypto.randomUUID();
                setText(e.target.value);
                sessionStorage.setItem("main-draft", e.target.value);
              }}
              maxLength={4000}
              rows={1}
              placeholder="交代事情，或问问进度…"
            />
            <button
              className="send-btn"
              aria-label="发送"
              title="发送（⌘↵）"
              disabled={!text.trim()}
            >
              <ArrowUp size={18} />
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
          <div className="compose-tools">
            <button
              type="button"
              disabled={outbox.some(entry => entry.submission.text === "现在都怎么样了？" && ["queued","sending"].includes(entry.status))}
              onClick={() => void send(true)}
            >
              问进度
            </button>
            {settings?.usage && (
              <a href="#settings" aria-label="查看主对话 token 用量明细">
                主对话用量：{tokenTotal(settings.usage.conversation)}
              </a>
            )}
            <small role="status">
              ⌘ K 输入　⌘ ↵ 发送
            </small>
          </div>
        </div>
      </form>
    </div>
  );
}

function MessageLinks({
  message: m,
  reply,
}: {
  message: Data;
  reply: () => void;
}) {
  const [open, setOpen] = useState(false);
  const run = m.origin?.startsWith("run:") && m.origin.slice(4);
  const inbox = m.origin?.startsWith("inbox:") && m.origin.slice(6);
  const canReply = m.refs.length > 0 || (m.kind === "project" && !m.resolvedBy);
  if (!inbox && !canReply && !run) return null;
  return (
    <footer>
      <div className="links message-links">
        {inbox && <a href={"#inbox/" + inbox}>查看请求</a>}
        {canReply && (
          <button onClick={reply}>
            <CornerUpLeft size={14} />
            回复这条
          </button>
        )}
        {(m.refs.length > 0 || run) && (
          <button
            aria-expanded={open}
            aria-controls={"sources-" + m.id}
            onClick={() => setOpen(!open)}
          >
            <Link2 size={14} />
            关联记录 <ChevronDown size={12} className="disclosure-arrow" />
          </button>
        )}
      </div>
      <div className="chat-sources" id={"sources-" + m.id} hidden={!open}>
        {m.refs.map((g: Data) => (
          <a key={g.id} href={"#goal/" + g.id}>
            <span>委托</span>
            <strong>{g.title}</strong>
            <ArrowUpRight size={14} />
          </a>
        ))}
        {run && (
          <a href={"#run/" + run}>
            <span>运行</span>
            <strong>查看依据</strong>
            <ArrowUpRight size={14} />
          </a>
        )}
      </div>
    </footer>
  );
}

function DirectoryQuestion({
  message,
  canChooseFolder,
  onResolved,
}: {
  message: Data;
  canChooseFolder: boolean;
  onResolved: () => Promise<void>;
}) {
  const [moving, setMoving] = useState(false);
  return (
    <Form
      onSubmit={async (form) => {
        await api(
          "/conversation/directories/" + message.id,
          moving ? { path: field(form, "path") } : {},
        );
        await onResolved();
      }}
    >
      {moving && <ProjectFolder canChoose={canChooseFolder} />}
      <button>{moving ? "确认新位置并继续" : "原目录已恢复，继续"}</button>
      <button type="button" onClick={() => setMoving(!moving)}>
        {moving ? "返回" : "更换这项委托的目录"}
      </button>
    </Form>
  );
}

function ProjectQuestion({
  message,
  projects,
  canChooseFolder,
  onResolved,
}: {
  message: Data;
  projects: Data[];
  canChooseFolder: boolean;
  onResolved: () => Promise<void>;
}) {
  const matching = projects.filter(
    (p) => p.name.toLowerCase() === message.project?.toLowerCase(),
  );
  const [selection, select] = useState(
    matching.length === 1
      ? matching[0].id
      : projects.length && (matching.length || message.project === "?")
        ? ""
        : "new",
  );
  const selected = projects.find((p) => p.id === selection);
  return (
    <Form
      onSubmit={async (f) => {
        const decision =
          selection === "new"
            ? {
                kind: "authorize",
                path: field(f, "path"),
                name: field(f, "name") || undefined,
              }
            : selection === "independent"
              ? { kind: "independent" }
              : selection === "cancel"
                ? { kind: "cancel" }
                : {
                    kind: "select",
                    workspaceId: selection,
                    enable: selected?.enabled === 0,
                  };
        await api("/conversation/projects/" + message.id, decision);
        await onResolved();
      }}
    >
      <label>
        这项委托使用的项目
        <select
          value={selection}
          onChange={(e) => select(e.target.value)}
          required
        >
          <option value="" disabled>
            请选择项目
          </option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.path}
              {p.enabled ? "" : "（已停用）"}
            </option>
          ))}
          <option value="independent">作为独立委托处理</option>
          <option value="new">授权新的本地项目…</option>
          <option value="cancel">取消这项委托</option>
        </select>
      </label>
      {selection === "new" && (
        <>
          <label>
            项目名称
            <input
              name="name"
              maxLength={160}
              defaultValue={message.project === "?" ? "" : message.project}
            />
          </label>
          <ProjectFolder canChoose={canChooseFolder} />
          <small>授权后，以后提到这个项目即可使用。</small>
        </>
      )}
      <button disabled={!selection}>
        {selection === "new"
          ? "授权并继续"
          : selection === "independent"
            ? "独立执行"
            : selection === "cancel"
              ? "确认取消"
              : selected && !selected.enabled
                ? "重新启用并继续"
                : "使用这个项目"}
      </button>
    </Form>
  );
}
