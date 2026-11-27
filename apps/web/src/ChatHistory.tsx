import React, { memo, useEffect, useState, useLayoutEffect, useRef, type RefObject } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  ArrowUpRight,
  ChevronDown,
  CornerUpLeft,
  Link2,
  Infinity as Loop,
} from "lucide-react";
import { api, Form, field, type Data } from "./lib.tsx";
import { Markdown } from "./Markdown.tsx";
import { ProjectFolder } from "./ProjectFolder.tsx";
import { ChatApprovals } from "./ChatApprovals.tsx";
import { sender, messageTime, type ReplyQuote } from "./reply-quote.ts";
import { retryMessage } from "./conversation-outbox.ts";
import { ChatRowState, useRowState, messageKey } from "./chat-row-state.ts";

type Actions = {
  settings?: Data;
  replyTo: (message: Data) => void;
  resolved: (id: string) => Promise<void>;
};
type HeaderProps = { more: boolean; offline: boolean; earlier: () => void };
function Header({ context }: { context: HeaderProps }) {
  return (
    <div className="chat-column chat-history-head">
      {context.more && (
        <button onClick={context.earlier}>查看更早的消息</button>
      )}
      {context.offline && <p role="status">暂时连不上工作台，正在重连。</p>}
    </div>
  );
}
const components = {
  Header,
  Footer: () => <div className="chat-history-foot" />,
};
export default memo(function ChatHistory({
  rows,
  firstIndex,
  loaded,
  more,
  offline,
  earlier,
  list,
  settings,
  replyTo,
  resolved,
}: Actions &
  HeaderProps & {
    rows: Data[];
    firstIndex: number;
    loaded: boolean;
    list: RefObject<VirtuosoHandle | null>;
  }) {
  const memory = useRef(new Map<string, unknown>());
  const viewport = useRef<HTMLElement | null>(null);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const clearAnchor = () => {
    anchor.current = null;
  };
  const prepend = () => {
    const scroller = viewport.current;
    if (scroller) {
      const top = scroller.getBoundingClientRect().top;
      const message = [
        ...scroller.querySelectorAll<HTMLElement>(
          ".chat-message, .chat-approvals",
        ),
      ].find((el) => el.getBoundingClientRect().bottom > top);
      const id = message?.closest<HTMLElement>(".chat-row")?.dataset.messageId;
      if (id && message)
        anchor.current = { id, top: message.getBoundingClientRect().top - top };
    }
    earlier();
  };
  useLayoutEffect(() => {
    // Virtuoso accounts for prepended rows; also preserve the exact position
    // inside the row when a date divider or the history button disappears.
    const scroller = viewport.current,
      saved = anchor.current;
    if (!saved || !scroller) return;
    let frame = 0,
      stable = 0,
      attempts = 0;
    const settle = () => {
      if (anchor.current !== saved) return;
      const row = scroller.querySelector(
        `[data-message-id="${CSS.escape(saved.id)}"]`,
      );
      const message = row?.querySelector(".chat-message, .chat-approvals");
      if (message) {
        const delta =
          message.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top -
          saved.top;
        if (Math.abs(delta) > 1) {
          scroller.scrollTop += delta;
          stable = 0;
        } else stable++;
      }
      if (stable < 3 && ++attempts < 30) frame = requestAnimationFrame(settle);
      else clearAnchor();
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [firstIndex, more]);
  const [jump, setJump] = useState<string | null>(null);
  const [position, setPosition] = useState({ revision: 0, index: "LAST" as "LAST" | number });
  const focusOnMount = useRef<string | null>(null);
  useEffect(() => {
    if (!jump || !loaded) return;
    const index = rows.findIndex(row => row.id === jump);
    if (index < 0 && more) {
      earlier();
      return;
    }
    if (index >= 0) {
      // Prepending history preserves the old viewport. Start the virtual list
      // at the selected row once all pages up to it have arrived.
      focusOnMount.current = jump;
      setPosition(old => ({ revision: old.revision + 1, index }));
    }
    setJump(null);
  }, [jump, rows, more, earlier, loaded]);
  if (!rows.length)
    return (
      <div className="chat-stream">
        <Header context={{ more, offline, earlier }} />
        {loaded && (
          <section className="chat-empty chat-column">
            <Loop size={30} aria-hidden="true" />
            <h2>有什么事要我照看？</h2>
            <p>交代事情，或问问现有委托的进度。</p>
          </section>
        )}
      </div>
    );
  return (
    <Virtuoso
      key={position.revision}
      ref={list}
      className="chat-stream"
      scrollerRef={(el) => {
        viewport.current = el instanceof HTMLElement ? el : null;
      }}
      onWheel={clearAnchor}
      onTouchStart={clearAnchor}
      onPointerDown={clearAnchor}
      onKeyDown={clearAnchor}
      data={rows}
      firstItemIndex={firstIndex}
      initialTopMostItemIndex={{ index: position.index, align: position.index === "LAST" ? "end" : "center" }}
      followOutput
      atBottomThreshold={65}
      defaultItemHeight={108}
      increaseViewportBy={360}
      computeItemKey={(_, message) => messageKey(message)}
      components={components}
      context={{ more, offline, earlier: prepend }}
      itemContent={(index, m) => {
        const previous = rows[index - firstIndex - 1];
        const newDay =
          !previous ||
          new Date(previous.created).toDateString() !==
            new Date(m.created).toDateString();
        const divided =
          !newDay && !previous.approvalGoal && previous.role === "assistant";
        return (
          <div
            className={"chat-column chat-row" + (divided ? " divided" : "")}
            data-message-id={m.id}
            tabIndex={-1}
            ref={focusOnMount.current === m.id ? el => {
              if (!el) return;
              // Virtuoso briefly hides rows while measuring the new viewport.
              let frame: number;
              const focus = () => {
                if (getComputedStyle(el).visibility === "hidden") {
                  frame = requestAnimationFrame(focus);
                  return;
                }
                el.focus({ preventScroll: true });
                focusOnMount.current = null;
              };
              frame = requestAnimationFrame(focus);
              return () => cancelAnimationFrame(frame);
            } : undefined}
          >
            <ChatRowState.Provider
              value={{ values: memory.current, id: messageKey(m) }}
            >
              <Message
                m={m}
                newDay={newDay}
                jump={setJump}
                settings={settings}
                replyTo={replyTo}
                resolved={resolved}
              />
            </ChatRowState.Provider>
          </div>
        );
      }}
    />
  );
});

function LongMessage({ text }: { text: string }) {
  const [open, setOpen] = useRowState("full-text", false);
  return (
    <div className="long-message">
      {!open && <Markdown text={text.split(/\n\s*\n/)[0].slice(0, 360)} />}
      <details className="read-more" open={open}>
        <summary
          onClick={(e) => {
            e.preventDefault();
            setOpen(!open);
          }}
        >
          阅读全文
        </summary>
        {open && <Markdown text={text} />}
      </details>
    </div>
  );
}

function Message({
  m,
  newDay,
  jump,
  settings,
  replyTo,
  resolved,
}: Actions & { m: Data; newDay: boolean; jump: (id: string) => void }) {
  return (
    <>
      {newDay && (
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
      {m.approvalGoal ? (
        <ChatApprovals message={m} reply={() => replyTo(m)} />
      ) : (
        <article className={"chat-message " + m.role}>
          <div className="meta">
            <b>{sender(m.role, m.kind)}</b>
            <time dateTime={m.created}>{messageTime(m.created)}</time>
            {m.delivery && (
              <span role="status">
                {
                  {
                    queued: "等待发送",
                    sending: "发送中…",
                    sent: "已发送",
                    failed: "发送未确认",
                  }[m.delivery as string]
                }
              </span>
            )}
          </div>
          {m.quote && <Quote quote={m.quote} jump={jump} />}
          {m.body.length > 800 ? (
            <LongMessage text={m.body} />
          ) : (
            <Markdown text={m.body} />
          )}
          {m.delivery === "failed" && (
            <div className="links">
              <span role="alert">{m.error}</span>
              <button onClick={() => retryMessage(m.id)}>重试发送</button>
            </div>
          )}
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
          {m.role === "assistant" && (
            <MessageLinks message={m} reply={() => replyTo(m)} />
          )}
        </article>
      )}
    </>
  );
}

function Quote({ quote, jump }: { quote: ReplyQuote; jump: (id: string) => void }) {
  const label = quote.type === "goal" ? "回复委托"
    : `回复 ${sender(quote.role, quote.kind)} · ${messageTime(quote.created)}`;
  const content = <><strong>{label}</strong><span>{quote.text}</span></>;
  if (quote.type === "goal")
    return <a className="reply-quote" href={"#goal/" + quote.id}>{content}</a>;
  // Approval notices may have been folded into a newer row for the same goal.
  if (quote.origin?.startsWith("inbox:"))
    return <a className="reply-quote" href={"#inbox/" + quote.origin.slice(6)}>{content}</a>;
  return <button className="reply-quote" onClick={() => jump(quote.id)}>{content}</button>;
}

function MessageLinks({
  message: m,
  reply,
}: {
  message: Data;
  reply: () => void;
}) {
  const [open, setOpen] = useRowState("links", false);
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
  const [moving, setMoving] = useRowState("moving", false);
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
  const [name, setName] = useRowState<string>(
    "project-name",
    message.project === "?" ? "" : message.project,
  );
  const [selection, select] = useRowState(
    "project-selection",
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
              value={name}
              onChange={(e) => setName(e.target.value)}
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
