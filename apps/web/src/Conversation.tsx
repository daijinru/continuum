import { RunProgressList } from "./RunProgressList.tsx";
import { logPage } from "./conversation-log.ts";
import { messageQuote, type ReplyQuote } from "./reply-quote.ts";
import { messageKey } from "./chat-row-state.ts";
import type { VirtuosoHandle } from "react-virtuoso";
import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { api, useData, type Data } from "./lib.tsx";
import { conversationStorage, outgoingRow, queueMessage, reconcileOutbox, useOutbox } from "./conversation-outbox.ts";
import { tokenTotal } from "./TokenUsage.tsx";
import { ArrowUp, CornerUpLeft, X } from "lucide-react";

const ChatHistory = React.lazy(() => import("./ChatHistory.tsx"));

export function Conversation({ focus, live }: { focus?: string; live: boolean }) {
  const { data: settings } = useData<Data>("/settings");
  const outbox = useOutbox();
  const [{ rows: messages, firstIndex }, setHistory] = useState({ rows: [] as Data[], firstIndex: 1 }),
    [more, setMore] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [appliedVersion, setAppliedVersion] = useState<number>();
  useEffect(() => {
    if (appliedVersion !== undefined) logPage("applied", { version: appliedVersion });
  }, [appliedVersion]);
  const [text, setText] = useState(
      () => conversationStorage().getItem("main-draft") || "",
    ),
    [reply, setReply] = useState<Data | null>(null),
    [target, setTarget] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [offline, setOffline] = useState(false);
  const draftKey = useRef(crypto.randomUUID()),
    refresh = useRef<() => void>(() => {}),
    earlier = useRef<() => void>(() => {}),
    floor = useRef(0),
    list = useRef<VirtuosoHandle>(null),
    jumpToSent = useRef(false),
    editor = useRef<HTMLTextAreaElement>(null);
  const merge = (rows: Data[], mode: "latest" | "changes" | "history" = "latest") => {
    setHistory(history => {
      const old = history.rows;
      const unique = new Map<string, Data>();
      for (const row of old) unique.set(messageKey(row), row);
      for (const row of rows) {
        if (mode === "changes" && row.seq < floor.current) continue;
        const key = messageKey(row);
        const known = unique.get(key);
        if (!known || known.seq < row.seq || (known.seq === row.seq && mode !== "history")) unique.set(key, row);
      }
      const merged = [...unique.values()].sort((a, b) => a.seq - b.seq);
      // Each prepended logical row consumes at least one older sequence number.
      const firstIndex = !old.length ? merged[0]?.seq ?? 1
        : history.firstIndex - (mode === "history" ? merged.findIndex(m => m.seq >= old[0].seq) : 0);
      return { rows: merged, firstIndex };
    });
    reconcileOutbox(rows);
  };
  const visible = useMemo(() => {
    if (!outbox.length) return messages;
    const ids = new Set(messages.map(m => m.id));
    return [...messages, ...outbox.filter(e => !ids.has(e.submission.key)).map(outgoingRow)]
      .sort((a, b) => a.seq - b.seq);
  }, [messages, outbox]);
  const resolved = useCallback(async (id: string) => {
    setHistory(old => ({ ...old, rows: old.rows.map(row => row.id === id ? { ...row, resolvedBy: true } : row) }));
    refresh.current();
  }, []);
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
              setHistory({ rows: [], firstIndex: 1 });
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
        setAppliedVersion(version);
        setOffline(false);
        // An older local service supplies neither a cursor nor change events.
        if (version === undefined) retry = setTimeout(load, 2500);
      } catch {
        if (alive) {
          logPage("load_failed");
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
    const visibility = () => { logPage(document.hidden ? "hidden" : "visible"); void load(); };
    document.addEventListener("visibilitychange", visibility);
    logPage(document.hidden ? "hidden" : "visible");
    void load();
    return () => {
      alive = false;
      clearTimeout(retry);
      window.removeEventListener("conversation-changed", changed);
      window.removeEventListener("conversation-disconnected", disconnected);
      document.removeEventListener("visibilitychange", visibility);
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
    if (jumpToSent.current) {
      list.current?.scrollToIndex({ index: "LAST", align: "end" });
      jumpToSent.current = false;
    }
  }, [visible.at(-1)?.id]);
  const send = (quick = false) => {
    if (!quick && !text.trim()) return;
    jumpToSent.current = true;
    setError("");
    let quote: ReplyQuote | undefined;
    if (!quick && reply) quote = messageQuote(reply);
    else if (!quick && focus) {
      quote = { type: "goal", id: focus, text: target?.id === focus ? target.title : "这项委托" };
    }
    queueMessage({
      key: quick ? crypto.randomUUID() : draftKey.current, text: quick ? "现在都怎么样了？" : text.trim(),
      ...(quote?.type === "message" ? { replyTo: quote.id } : quote ? { focus: quote.id } : {}),
    }, quote);
    if (!quick) {
      setText("");
      conversationStorage().removeItem("main-draft");
      setReply(null);
      if (focus) location.hash = "chat";
      editor.current?.focus();
    }
  };
  const replyTo = useCallback((m: Data) => { setReply(m); editor.current?.focus(); }, []);
  const loadEarlier = useCallback(() => earlier.current(), []);
  return (
    <div className="conversation">
      <React.Suspense fallback={<div className="chat-stream" />}>
        <ChatHistory
          list={list}
          rows={visible}
          firstIndex={firstIndex}
          settings={settings}
          loaded={loaded}
          more={more}
          offline={offline}
          earlier={loadEarlier}
          replyTo={replyTo}
          resolved={resolved}
        />
      </React.Suspense>
      {live && <RunProgressList />}
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
                conversationStorage().setItem("main-draft", e.target.value);
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
