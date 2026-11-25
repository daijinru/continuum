import React, { useState } from "react";
import { Markdown } from "./Markdown.tsx";
import { arrangeBriefing } from "./briefing-order.ts";
import { decisionCopy } from "./decision-copy.ts";
import { Delivery } from "./Commission.tsx";
import {
  CheckCheck,
  TriangleAlert,
  Check,
  FileCheck2,
  GitBranch,
  ChevronDown,
  MessageSquare,
  ClipboardCheck,
  Clock3,
  ArrowUpRight,
} from "lucide-react";
import {
  useLoad,
  useData,
  api,
  dt,
  clock,
  Head,
  Badge,
  Provider,
  Status,
  Action,
  useApp,
  type Data,
} from "./lib.tsx";
export function Evidence({ id, until }: { id: string; until?: number }) {
  const { data, error } = useData(
    "/stories/" + id + "/events" + (until ? "?until=" + until : ""),
  );
  if (!data) return <Status error={error} />;
  return (
    <div className="evidence">
      {data.map((e) => (
        <div key={e.id}>
          <time>{clock(e.received)}</time>{" "}
          {e.type === "agent.message" ? <Markdown text={e.title} /> : e.title}{" "}
          <a href={"#run/" + e.run_id}>查看运行</a>
        </div>
      ))}
    </div>
  );
}
export function Story({
  s,
  until,
  digest = false,
}: {
  s: Data;
  until?: number;
  digest?: boolean;
}) {
  const [expanded, set] = useState(false),
    { chat } = useApp();
  const Icon =
    s.category === "risk"
      ? TriangleAlert
      : s.category === "outcome"
        ? FileCheck2
        : GitBranch;
  return (
    <article className="story">
      <div className={"tile " + s.category}>
        <Icon size={19} />
      </div>
      <div className="story-main">
        <div className="story-title">
          {s.category === "insight" && digest ? (
            <div>
              <strong>{s.goal} · 助手回复</strong>
              <Markdown
                text={(s.summary || s.title).split(/\n\s*\n/)[0].slice(0, 350)}
              />
              {(s.summary || s.title).length >
                (s.summary || s.title).split(/\n\s*\n/)[0].slice(0, 350)
                  .length && (
                <details>
                  <summary>阅读全文</summary>
                  <Markdown text={s.summary || s.title} />
                </details>
              )}
            </div>
          ) : s.category === "insight" ? (
            <Markdown text={s.summary || s.title} />
          ) : (
            <strong>
              {digest && s.title.startsWith("文件变更 · ")
                ? "已更新项目文件：" + s.title.split("/").pop()
                : s.title}
            </strong>
          )}
          {digest && s.category === "insight" ? null : (
            <Badge value={s.verification} />
          )}
        </div>
        <div className="meta">
          <a href={"#goal/" + s.goal_id}>{s.goal || "查看目标"}</a>
          <span>·</span>
          <time>{dt(s.updated)}</time>
          <Provider value={s.provider} />
        </div>
        <div className="links">
          <button onClick={() => set(!expanded)} aria-expanded={expanded}>
            <ChevronDown size={14} /> {expanded ? "收起证据" : "查看证据"}
          </button>
          <button
            onClick={() =>
              chat({
                kind: "story",
                ref: s.id,
                goalId: s.goal_id,
                title: s.title,
              })
            }
          >
            <MessageSquare size={13} /> 跟进
          </button>
        </div>
        {expanded && <Evidence id={s.id} until={until} />}
      </div>
    </article>
  );
}
export function Today() {
  const [win, setWin] = useState("since"),
    [snapshot, setSnapshot] = useState(""),
    { notice } = useApp();
  const { data: b, error } = useLoad<Data>(
    "brief/" + win + "/" + snapshot,
    () =>
      snapshot
        ? api("/briefings/" + snapshot)
        : api("/briefings/generate", { window: win }),
  );
  const history = useData("/briefings?limit=20");
  const ordered = b && arrangeBriefing(b.sections);
  const reportRuns = new Set((b?.reports || []).map((r: Data) => r.run_id));
  const results = [
    ...(b?.native || []).map((m: Data) => ({ ...m, native: true })),
    ...(b?.reports || []).map((r: Data) => ({ ...r, delivery: true })),
    ...(ordered?.highlights || []).filter(
      (s) =>
        !reportRuns.has(s.run_id) && (!b?.reports || s.category === "outcome"),
    ),
  ].sort(
    (a, b) =>
      b.updated.localeCompare(a.updated) ||
      (b.last_seq || b.seq) - (a.last_seq || a.seq),
  );
  const date = new Date();
  const labels: Record<string, string> = {
    since: "上次阅读以来",
    today: "今天",
    week: "近七天",
  };
  return (
    <>
      <Head
        title="今日简报"
        sub={date.toLocaleDateString("zh-CN", {
          year: "numeric",
          month: "long",
          day: "numeric",
          weekday: "long",
        })}
      >
        <button className="primary" onClick={() => (location.hash = "chat")}>
          交代一件事
        </button>
      </Head>
      <div className="toolbar">
        <div className="tabs">
          {Object.entries(labels).map(([k, t]) => (
            <button
              key={k}
              className={win === k && !snapshot ? "selected" : ""}
              onClick={() => {
                setWin(k);
                setSnapshot("");
              }}
            >
              {t}
            </button>
          ))}
        </div>
        <select
          aria-label="历史简报"
          value={snapshot}
          onChange={(e) => setSnapshot(e.target.value)}
        >
          <option value="">历史简报</option>
          {history.data?.map((h) => (
            <option key={h.id} value={h.id}>
              {dt(h.generated)} · {labels[h.window]}
            </option>
          ))}
        </select>
      </div>
      {!b ? (
        <Status error={error} />
      ) : (
        <>
          {b.sections.needs.length > 0 && (
            <section>
              <div className="section-head">
                <h2>
                  <span className="marker amber" />
                  需要你处理 <i>{b.sections.needs.length}</i>
                </h2>
                <a href="#inbox">
                  查看收件箱 <ArrowUpRight size={14} />
                </a>
              </div>
              {[...b.sections.needs]
                .sort(
                  (a, b) =>
                    Number(b.blocking ?? 1) - Number(a.blocking ?? 1) ||
                    b.created.localeCompare(a.created),
                )
                .map((i: Data) => (
                  <div className="urgent" key={i.id}>
                    <div className="tile">
                      <ClipboardCheck size={21} />
                    </div>
                    <div className="grow">
                      <div className="meta">
                        <b>
                          {i.kind === "input"
                            ? "待答复"
                            : i.kind === "decision"
                              ? "待核对"
                              : "待审批"}
                        </b>
                        <span>·</span>
                        {i.goal}
                        <Provider value={i.provider} />
                      </div>
                      <h3>{decisionCopy(i).title}</h3>
                      <p>
                        {i.reason === "此操作需要本次授权"
                          ? decisionCopy(i).facts[0]
                          : i.reason}
                      </p>
                    </div>
                    <a className="btn primary" href={"#inbox/" + i.id}>
                      审阅请求
                    </a>
                  </div>
                ))}
            </section>
          )}
          {!results.length &&
            !ordered?.risks.length &&
            !b.sections.needs.length && (
              <div className="quiet">
                <CheckCheck size={28} />
                <h2>暂无重要变化</h2>
                <p>这段时间没有新的交付，也没有需要你决定的事。</p>
              </div>
            )}
          {(
            [
              ["需要留意的问题", ordered?.risks],
              ["最新交付", results],
            ] as const
          ).map(
            ([title, rows]) =>
              !!rows?.length && (
                <section key={title}>
                  <div className="section-head">
                    <h2>
                      <span className="marker" />
                      {title} <i>{rows.length}</i>
                    </h2>
                  </div>
                  <div className="panel">
                    {rows.map((s: Data) =>
                      s.native ? (
                        <article key={s.id} className="panel pad">
                          <h3>{s.goal}</h3>
                          <time>{dt(s.updated)}</time>
                          <Markdown text={s.summary} />
                          <a href={"#chat/" + s.goal_id}>在主对话中继续</a>
                        </article>
                      ) : s.delivery ? (
                        <Delivery key={s.id} r={s} />
                      ) : (
                        <Story key={s.id} s={s} until={b.end_seq} digest />
                      ),
                    )}
                  </div>
                </section>
              ),
          )}
          {b.sections.next.length > 0 && (
            <section>
              <h2>接下来</h2>
              {b.sections.next.map((j: Data) => (
                <p key={j.id}>
                  <a href={"#goal/" + j.goal_id}>{j.instruction}</a> ·{" "}
                  {dt(j.next_at)}
                </p>
              ))}
            </section>
          )}
          <footer className="readbar">
            <span>
              <Clock3 size={14} />
              {b.window_start ? dt(b.window_start) : "首次记录"} 至{" "}
              {dt(b.window_end)} · 汇总 {b.count} 条事件
            </span>
            <Action
              run={async () => {
                await api("/briefings/" + b.id + "/acknowledge", {});
                setSnapshot("");
                setWin("since");
                notice("已更新阅读位置");
              }}
            >
              <Check size={14} />
              标记已读
            </Action>
          </footer>
        </>
      )}
    </>
  );
}
