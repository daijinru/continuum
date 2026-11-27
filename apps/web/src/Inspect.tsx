import { ProjectFolder } from "./ProjectFolder.tsx";
import React, { useState } from "react";
import {
  Inbox as Tray,
  ShieldCheck,
  Filter,
  Plug,
  FolderPlus,
  CircleCheck,
  Clock3,
} from "lucide-react";
import {
  api,
  useData,
  useLoad,
  Head,
  Status,
  Provider,
  Badge,
  Action,
  dt,
  Form,
  field,
  useApp,
  type Data,
} from "./lib.tsx";
import { Limits } from "./Goals.tsx";
import { TokenUsage } from "./TokenUsage.tsx";
import { RestartService } from "./RestartService.tsx";
import { decisionCopy } from "./decision-copy.ts";
export function Inbox({ id }: { id?: string }) {
  const { data, error } = useData("/inbox"),
    [tab, set] = useState("pending");
  const pending = (i: Data) => ["pending", "deferred"].includes(i.status);
  const fromList = data?.find((i) => i.id === id);
  const missing = data && id && !fromList ? id : "";
  const detail = useLoad<Data | undefined>(missing, async () => missing ? api("/inbox/" + missing) : undefined);
  const selected = fromList || detail.data;
  const rows = data && (missing && selected ? [...data, selected] : data);
  const currentTab = selected ? (pending(selected) ? "pending" : "done") : tab;
  const visible =
    rows?.filter((i) =>
      currentTab === "pending" ? pending(i) : !pending(i),
    ) || [];
  const active = id ? selected : visible[0];
  return (
    <>
      <Head
        title="需要你决定"
        sub={
          data
            ? data.some(pending)
              ? "先看这一步会做什么，再决定是否继续。"
              : "目前没有等待你决定的事。"
            : undefined
        }
      />
      <div className="tabs line">
        {[
          ["pending", "待处理"],
          ["done", "处理历史"],
        ].map(([k, v]) => (
          <button
            className={k === currentTab ? "selected" : ""}
            aria-pressed={k === currentTab}
            key={k}
            onClick={() => {
              set(k);
              location.hash = "inbox";
            }}
          >
            {v}{" "}
            {rows?.filter((i) => (k === "pending" ? pending(i) : !pending(i)))
              .length || 0}
          </button>
        ))}
      </div>
      {!data || (missing && !selected) ? (
        <Status error={error || detail.error} />
      ) : (
        <div className={visible.length > 1 ? "split" : "decision-single"}>
          {(visible.length > 1 || !active) && (
            <div className="panel queue">
              {visible.length ? (
                visible.map((i) => (
                  <a
                    key={i.id}
                    href={"#inbox/" + i.id}
                    className={active?.id === i.id ? "picked" : ""}
                  >
                    <div className="meta">
                      <Badge value={i.status} />
                    </div>
                    <h3>{i.goal}</h3>
                    <small>{decisionCopy(i).title}</small>
                  </a>
                ))
              ) : (
                <div className="empty">
                  <Tray /> 此队列为空
                </div>
              )}
            </div>
          )}
          {active && <Decision key={active.id + ":" + active.version} i={active} />}
        </div>
      )}
    </>
  );
}
function Decision({ i }: { i: Data }) {
  const { chat, notice } = useApp(),
    { data } = useData<Data>("/inbox/" + i.id),
    [busy, setBusy] = useState(false),
    [review, setReview] = useState<{command: string; cwd: string; reviewKey: string} | null>(null);
  const decide = async (d: string, extra: Data = {}) => {
    setBusy(true);
    try {
      await api("/inbox/" + i.id + "/decision", {
        decision: d,
        key: crypto.randomUUID(),
        version: i.version,
        ...extra,
      });
      notice("决定已记录");
      setReview(null);
    } finally {
      setBusy(false);
    }
  };
  const copy = decisionCopy(i);
  const open = ["pending", "deferred"].includes(i.status);
  const approvalDisabled = busy || i.risk?.includes("仅可拒绝") || (!!i.masked_command && !review);
  const reason = i.reason !== "此操作需要本次授权" && i.reason;
  return (
    <section className="panel pad decision">
      <div className="meta">
        <ShieldCheck size={18} />
        {i.kind === "input"
          ? "补充信息"
          : i.kind === "decision"
            ? "运行核对"
            : "操作审批"}{" "}
        <Provider value={i.provider} />
        <Badge value={i.status} />
      </div>
      <p>
        委托：<a href={"#goal/" + i.goal_id}>{i.goal}</a>
      </p>
      <h2>{copy.title}</h2>
      {reason && <p>{reason}</p>}
      {copy.facts.length > 0 && (
        <ul className="decision-facts">
          {copy.facts.map((f, n) => (
            <li key={n}>{f}</li>
          ))}
        </ul>
      )}
      {open && (
        <p className="muted">
          {i.kind === "decision"
            ? "确认终态前会阻止同目标的新运行。"
            : i.blocking
              ? "稍后处理会让任务继续等待。"
              : "任务可继续，答复后会同步到原线程。"}
        </p>
      )}
      <details className="request-details" open={copy.inspect || undefined}>
        <summary>{i.masked_command ? "查看脱敏预览与范围" : `核对${copy.command ? "完整命令" : "原始请求"}与范围`}</summary>
        <dl>
          <dt>请求范围</dt>
          <dd>{i.scope}</dd>
          <dt>风险标记</dt>
          <dd>{i.risk}</dd>
          <dt>发起时间</dt>
          <dd>{dt(i.created)}</dd>
        </dl>
        {copy.command && <pre>{copy.command}</pre>}
        {copy.command ? (
          <details>
            <summary>查看原始参数</summary>
            <pre>{copy.raw}</pre>
          </details>
        ) : (
          <pre>{copy.raw}</pre>
        )}
      </details>
      {open && !!i.masked_command && (
        <div>
          <p>完整命令可能含敏感信息，仅在本机展示。按委托授权后，这项委托各轮的常规操作将自动通过，包括预览有遮盖的命令。</p>
          {review ? (
            <>
              <p>执行目录　{review.cwd}</p>
              <pre>{review.command}</pre>
              <button onClick={() => setReview(null)}>隐藏原文</button>
            </>
          ) : (
            <Action disabled={busy} run={async () => setReview(await api("/inbox/" + i.id + "/review", { version: i.version }))}>
              在本机查看完整命令
            </Action>
          )}
        </div>
      )}
      {open && !!i.allow_for_run && (
        <p className="muted">
          本轮授权持续到本轮结束或断线。按委托授权还会用于以后各轮，可在委托详情撤销。两者都允许常规命令和文件修改（包括删除），需要额外权限时仍会询问。
        </p>
      )}
      {open ? (
        <div className="actions">
          {i.kind === "approval" ? (
            <>
              <Action
                className="primary"
                disabled={approvalDisabled}
                run={() => decide("approve", review ? { reviewKey: review.reviewKey } : {})}
              >
                仅允许这一次
              </Action>
              {!!i.allow_for_run && (
                <Action disabled={approvalDisabled} run={() => decide("approve_run")}>
                  允许本轮后续操作
                </Action>
              )}
              {(!!i.allow_for_run || !!i.masked_command) && (
                <Action disabled={approvalDisabled}
                  run={() => decide("approve_goal", review ? { reviewKey: review.reviewKey } : {})}>
                  {i.masked_command ? "按委托授权" : "允许这项委托的后续操作"}
                </Action>
              )}
              <Action disabled={busy} run={() => decide("deny")}>
                拒绝
              </Action>
            </>
          ) : i.kind === "input" ? (
            <Form
              onSubmit={async (f) =>
                decide("answer", { answers: Object.fromEntries(f.entries()) })
              }
            >
              {JSON.parse(i.action).map((q: Data) => (
                <label key={q.id}>
                  {q.question}
                  {q.options?.length && !q.other ? (
                    <select name={q.id} required>
                      {q.options.map((o: Data) => (
                        <option key={o.label}>{o.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input name={q.id} required maxLength={1000} />
                  )}
                </label>
              ))}
              <button className="primary">提交答复</button>
            </Form>
          ) : (
            <Form
              onSubmit={async (f) =>
                decide("record", {
                  observed: field(f, "observed"),
                  note: field(f, "note"),
                })
              }
            >
              <label>
                已在提供方核实的终态
                <select name="observed" defaultValue="" required>
                  <option value="" disabled>
                    选择核实结果
                  </option>
                  <option value="succeeded">已完成</option>
                  <option value="failed">执行失败</option>
                  <option value="interrupted">已中断</option>
                </select>
              </label>
              <label>
                核对依据
                <input name="note" required />
              </label>
              <button>登记实际结果</button>
            </Form>
          )}
          <Action
            disabled={busy || i.status === "deferred"}
            run={() => decide("defer")}
          >
            稍后处理
          </Action>
        </div>
      ) : (
        <p>
          <Badge value={i.status} />{" "}
          {i.status === "expired"
            ? "此请求已经失效，请查看运行记录。"
            : "本次请求已关闭。"}
        </p>
      )}
      <div className="links">
        <a href={"#run/" + i.run_id}>查看关联运行</a>
        <button
          onClick={() =>
            chat({
              kind: "approval",
              ref: i.id,
              goalId: i.goal_id,
              title: i.title,
            })
          }
        >
          跟进此请求
        </button>
      </div>
      {data?.audit.length > 0 && (
        <>
          <h3>决策记录</h3>
          {data?.audit.map((a: Data) => (
            <p key={a.id}>
              {dt(a.created)} ·{" "}
              {
                a.actor === "goal_grant" ? "按委托授权自动批准" : a.actor === "run_grant" ? "按本轮授权自动批准" : (
                  {
                    approve: "批准",
                    approve_run: "批准本次及本轮后续操作",
                    approve_goal: "批准本次及这项委托的后续操作",
                    revoke_goal: "已撤销委托授权",
                    deny: "拒绝",
                    defer: "稍后处理",
                    answer: "已答复",
                    record: "已登记终态",
                  } as Record<string, string>
                )[a.action]
              }
            </p>
          ))}
        </>
      )}
    </section>
  );
}
import { Markdown } from "./Markdown.tsx";

export function Events({ rows }: { rows: Data[] }) {
  return (
    <div className="panel timeline">
      {rows.length ? (
        rows.map((e) => (
          <div className="timeline-item" key={e.id}>
            {e.type === "agent.message" && (
              <div className="message-report">
                <div className="meta">
                  <time>{dt(e.received)}</time> 助手消息{" "}
                  {e.provider && <Provider value={e.provider} />}
                </div>
                <Markdown text={e.title} />
              </div>
            )}
            <details>
              {e.type === "agent.message" ? (
                <summary>查看事件详情 · {e.method}</summary>
              ) : (
                <summary>
                  <span className={"dot " + e.severity} />
                  <time>{dt(e.received)}</time>
                  <div className="grow">
                    <strong>{e.title}</strong>
                    <div className="meta">
                      {e.method} {e.goal && " · " + e.goal}
                    </div>
                  </div>
                  {e.provider && <Provider value={e.provider} />}
                </summary>
              )}
              <div className="trace">
                <pre>
                  {JSON.stringify(
                    {
                      sequence: e.seq,
                      method: e.method,
                      event: e.type,
                      occurred: e.occurred,
                      data: JSON.parse(e.payload),
                    },
                    null,
                    2,
                  )}
                </pre>
                <a href={"#run/" + e.run_id}>打开运行详情</a>
              </div>
            </details>
          </div>
        ))
      ) : (
        <div className="empty">没有匹配的活动</div>
      )}
    </div>
  );
}
export function Activity() {
  const goals = useData("/goals"),
    [goal, setGoal] = useState(""),
    [run, setRun] = useState(""),
    [severity, setSeverity] = useState(""),
    [provider, setProvider] = useState(""),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0);
  const runs = useData("/goals/" + (goal || "none") + "/runs");
  const { data, error } = useData(
    "/activity?" +
      new URLSearchParams({
        goalId: goal,
        severity,
        provider,
        search,
        runId: run,
        offset: String(offset),
        limit: "50",
      }),
  );
  return (
    <>
      <Head title="活动记录" sub="按时间追溯每一条原始事件。" />
      <div className="filters">
        <Filter size={16} />
        <input
          aria-label="搜索事件"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
          placeholder="搜索事件或协议方法"
        />
        <select
          aria-label="筛选目标"
          value={goal}
          onChange={(e) => {
            setGoal(e.target.value);
            setRun("");
            setOffset(0);
          }}
        >
          <option value="">全部目标</option>
          {goals.data?.map((g) => (
            <option key={g.id} value={g.id}>
              {g.title}
            </option>
          ))}
        </select>
        <select
          aria-label="筛选运行"
          value={run}
          onChange={(e) => {
            setRun(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">全部运行</option>
          {runs.data?.map((r) => (
            <option value={r.id} key={r.id}>
              {dt(r.created)} {r.id.slice(0, 6)}
            </option>
          ))}
        </select>
        <select
          aria-label="筛选执行方式"
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">全部提供方</option>
          <option value="demo">DEMO</option>
          <option value="codex">Codex</option>
        </select>
        <select
          aria-label="筛选级别"
          value={severity}
          onChange={(e) => {
            setSeverity(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">全部级别</option>
          <option value="error">错误</option>
          <option value="warning">警告</option>
          <option value="info">信息</option>
        </select>
      </div>
      {data ? <Events rows={data} /> : <Status error={error} />}
      <div className="pager">
        <button disabled={!offset} onClick={() => setOffset(offset - 50)}>
          上一页
        </button>
        <button
          disabled={data?.length !== 50}
          onClick={() => setOffset(offset + 50)}
        >
          下一页
        </button>
      </div>
    </>
  );
}
export function Run({ id }: { id: string }) {
  const { data: r, error } = useData<Data>("/runs/" + id),
    events = useData("/runs/" + id + "/events?limit=500"),
    art = useData("/runs/" + id + "/artifacts");
  if (!r) return <Status error={error} />;
  return (
    <>
      <a className="back" href={"#goal/" + r.goal_id}>
        返回所属目标
      </a>
      <Head title="运行详情" sub={dt(r.created) + " · " + id}>
        <Provider value={r.provider} />
        <Badge value={r.status} />
      </Head>
      <div className="panel pad">
        <h2>本轮指令</h2>
        <pre>{r.instruction}</pre>
        <div className="meta">
          线程 {r.thread_id || "尚未分配"} · 轮次 {r.turn_id || "尚未分配"}
        </div>
        {r.status === "unknown" && (
          <Action run={() => api("/runs/" + id + "/reconcile", {})}>
            核对提供方状态
          </Action>
        )}
        {art.data?.map((a) => (
          <p key={a.id}>已核对文件 · {a.path}</p>
        ))}
      </div>
      <h2>事件时间线</h2>
      {events.data ? (
        <Events rows={[...events.data].reverse()} />
      ) : (
        <Status error={events.error} />
      )}
    </>
  );
}
export function Settings() {
  const { data: d, error } = useData<Data>("/settings"),
    { notice } = useApp();
  if (!d) return <Status error={error} />;
  return (
    <>
      <Head title="工作台设置" sub="管理本机连接、已授权项目与运行限制。" />
      <section className="panel pad">
        <h2>Token 用量</h2>
        <TokenUsage label="工作台合计" usage={d.usage.all} />
        <TokenUsage label="主对话 · 理解消息" usage={d.usage.conversation} />
        <TokenUsage label="全部委托 · 执行与筛选" usage={d.usage.goals} />
        <p className="muted">仅统计 Codex 已报告的用量；无记录不代表零消耗。到点提醒和快捷进度查询不调用模型。</p>
      </section>
      <section className="panel pad">
        <h2>
          <Plug size={20} />
          执行连接
        </h2>
        {d.connections.map((c: Data) => (
          <div className="listrow" key={c.id}>
            <div className="grow">
              <strong>
                {c.id === "demo" ? "演示适配器" : "Codex App Server"}
              </strong>
              <p>{c.detail}</p>
            </div>
            <Badge value={c.state} />
            {c.id === "codex" && (
              <Action
                run={async () => {
                  const c = await api("/agent-connections/check", {});
                  notice(c.detail);
                }}
              >
                检查连接
              </Action>
            )}
          </div>
        ))}
      </section>
      <section className="panel pad">
        <h2>
          <FolderPlus size={20} />
          已授权项目
        </h2>
        <p>添加你希望 Continuum 协助处理的本地项目。在对话中提到项目名，就能直接交代工作。</p>
        {d.workspaces.map((w: Data) => (
          <div className="listrow" key={w.id}>
            <div className="grow"><strong>{w.name}</strong><div><code>{w.path}</code></div>
              <small>{w.enabled ? `停用将影响 ${w.affected} 项委托` : "已停用，关联委托会保留"}</small></div>
            <Action
              run={() =>
                api("/workspaces/" + w.id, { enabled: !w.enabled }, "PATCH")
              }
            >
              {w.enabled ? "停用" : "启用"}
            </Action>
          </div>
        ))}
        <Form
          onSubmit={async (f) => {
            await api("/workspaces", { path: field(f, "path"), name: field(f, "name") || undefined });
            notice("项目已授权");
          }}
        >
          <label>
            项目名称（选填）
            <input name="name" maxLength={160} placeholder="例如：工作笔记" />
          </label>
          <ProjectFolder canChoose={d.service.canChooseFolder} />
          <button>授权项目</button>
        </Form>
      </section>
      <section className="panel pad">
        <h2>
          <Clock3 size={19} />
          运行与简报
        </h2>
        <Limits url="/settings" data={d} settings />
      </section>
      <section className="panel pad">
        <h2>
          <CircleCheck size={19} />
          本地服务
        </h2>
        <a href="#monitor">查看进程占用与委托状态 →</a>
        <dl>
          <dt>调度器</dt>
          <dd>{d.worker ? "运行中 · " + dt(d.worker) : "等待首次检查"}</dd>
          <dt>执行范围</dt>
          <dd>新委托默认在专属目录内自行处理，不提升权限。已有项目沿用原授权策略。</dd>
          <dt>简报生成</dt>
          <dd>依据已保存的事件和证据生成</dd>
          <dt>数据目录</dt>
          <dd>
            <code>{d.db}</code>
          </dd>
        </dl>
        {d.service && <RestartService instance={d.service.instance} canRestart={d.service.canRestart} />}
      </section>
    </>
  );
}
