import React, { useState } from "react";
import {
  Plus,
  Folder,
  Target,
  Play,
  Pause,
  MessageSquare,
  Square,
  Clock3,
  Check,
} from "lucide-react";
import {
  useData,
  api,
  dt,
  Head,
  Badge,
  Provider,
  Status,
  Action,
  useApp,
  Form,
  field,
  Modal,
  type Data,
} from "./lib.tsx";
import { Story } from "./Feed.tsx";
import { TokenUsage } from "./TokenUsage.tsx";
import { Markdown } from "./Markdown.tsx";
import { Delivery, Preference } from "./Commission.tsx";
function GoalForm({ close }: { close: () => void }) {
  const { data, error } = useData<Data>("/settings");
  const [path, setPath] = useState(false);
  return (
    <Modal title="新建工作目标" close={close}>
      {!data ? (
        <Status error={error} />
      ) : (
        <Form
          onSubmit={async (f) => {
            const workspaceId = path
              ? (await api("/workspaces", { path: field(f, "path") })).id
              : field(f, "workspaceId");
            const g = await api("/goals", {
              workspaceId,
              title: field(f, "title"),
              description: field(f, "description"),
              criteria: field(f, "criteria").split("\n").filter(Boolean),
              constraints: field(f, "constraints").split("\n").filter(Boolean),
              provider: field(f, "provider"),
              priority: Number(field(f, "priority")),
            });
            close();
            location.hash = "goal/" + g.id;
          }}
        >
          <label>
            目标名称
            <input
              required
              name="title"
              maxLength={120}
              autoFocus
              placeholder="例如：完成地图交互原型"
            />
          </label>
          <label>
            预期结果
            <textarea required name="description" rows={2} />
          </label>
          <label>
            验收条件（每行一项）
            <textarea required name="criteria" rows={2} />
          </label>
          <label>
            约束条件（选填）
            <input name="constraints" />
          </label>
          <label>
            允许使用的项目目录
            <select
              name="workspaceId"
              required={!path}
              onChange={(e) => setPath(e.target.value === "new")}
            >
              <option value="">请选择</option>
              {data?.workspaces
                .filter((w: Data) => w.enabled)
                .map((w: Data) => (
                  <option value={w.id} key={w.id}>
                    {w.path}
                  </option>
                ))}
              <option value="new">添加本地目录…</option>
            </select>
          </label>
          {path && (
            <label>
              绝对路径
              <input name="path" required placeholder="/Users/…/project" />
            </label>
          )}
          <div className="formrow">
            <label>
              执行方式
              <select name="provider">
                <option value="demo">DEMO · 模拟执行</option>
                <option value="codex">Codex · 真实执行</option>
              </select>
            </label>
            <label>
              优先级
              <select name="priority" defaultValue="3">
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>
          <button className="primary">创建目标</button>
        </Form>
      )}
    </Modal>
  );
}
export function Goals() {
  const { data, error } = useData("/goals"),
    [creating, set] = useState(false);
  return (
    <>
      <Head
        title="我的委托"
        sub="查看你交代的事、最近的结果，或调整下一次的要求。"
      >
        <button onClick={() => set(true)}>高级创建</button>
        <button className="primary" onClick={() => (location.hash = "chat")}>
          <Plus size={16} />
          交代一件事
        </button>
      </Head>
      {!data ? (
        <Status error={error} />
      ) : !data.length ? (
        <div className="empty">创建第一个工作目标</div>
      ) : (
        data.map((g) => (
          <a className="goalcard" href={"#goal/" + g.id} key={g.id}>
            <div className="tile">
              <Target />
            </div>
            <div className="grow">
              <div className="meta">
                <Provider value={g.provider} />
                <span>{g.workspace}</span>
              </div>
              <h2>{g.title}</h2>
              <div className="meta">
                {
                  (
                    {
                      at_risk: "有待解决的风险",
                      on_track: "按计划推进",
                      blocked: "目标受阻",
                      unknown: "等待工作证据",
                    } as Record<string, string>
                  )[g.health]
                }
              </div>
              <p>{g.description}</p>
              <div className="meta">
                {g.pending
                  ? "等待审批 · " + g.pending + " 项"
                  : g.latest === "failed"
                    ? "运行失败，请检查记录"
                    : g.latest
                      ? "查看运行记录"
                      : "可启动首轮任务"}{" "}
                · {dt(g.updated)}
              </div>
            </div>
            <Badge value={g.state} />
          </a>
        ))
      )}
      {creating && <GoalForm close={() => set(false)} />}
    </>
  );
}
export function Goal({ id }: { id: string }) {
  const { data: g, error } = useData<Data>("/goals/" + id),
    runs = useData("/goals/" + id + "/runs"),
    reports = useData("/goals/" + id + "/reports"),
    stories = useData("/stories?goalId=" + id);
  const [tab, setTab] = useState("概况"),
    [pref, setPref] = useState(false),
    { chat, notice, update } = useApp();
  if (!g) return <Status error={error} />;
  const live = runs.data?.find((r) => !r.finished),
    isActive = g.state === "active";
  const start = (cont: boolean) =>
    api("/goals/" + id + "/start", {
      key: crypto.randomUUID(),
      continue: cont,
    });
  return (
    <>
      <a className="back" href="#goals">
        我的委托 / 委托详情
      </a>
      <Head title={g.title} sub={g.description}>
        <Provider value={g.provider} />
        <select
          aria-label="目标状态"
          value={g.state}
          onChange={async (e) => {
            try {
              await api("/goals/" + id, { state: e.target.value }, "PATCH");
              update();
            } catch (err) {
              notice((err as Error).message);
            }
          }}
        >
          {[
            "active",
            "paused",
            "blocked",
            "completed",
            "archived",
            "draft",
          ].map((v, i) => (
            <option key={v} value={v}>
              {["进行中", "已暂停", "受阻", "已完成", "已归档", "草稿"][i]}
            </option>
          ))}
        </select>
      </Head>
      <TokenUsage label="本项委托的 token 用量" usage={g.usage} />
      {g.approvalGrant && (
        <div className="actions">
          <span>这项委托各轮的常规操作已获授权。</span>
          <a href={"#inbox/" + g.approvalGrant}>查看原始授权</a>
          <Action run={async () => {
            await api("/goals/" + id + "/revoke-approval", { grant: g.approvalGrant });
            notice("已撤销委托授权，后续操作将重新询问");
          }}>撤销委托授权</Action>
        </div>
      )}
      <div className="goal-controls">
        {g.arrangement && (
          <p>
            {g.arrangement.mode === "reminder"
              ? "到点提醒"
              : g.arrangement.notify === "changes"
                ? "有新发现再报告"
                : "按约定交付"}{" "}
            ·{" "}
            {g.arrangement.next_at
              ? `原定 ${dt(g.arrangement.next_at)}`
              : "没有待触发的排期"}{" "}
            {g.arrangement.last_note}
          </p>
        )}
        <button onClick={() => setPref(true)}>调整委托要求</button>
        <Action
          className="primary"
          disabled={
            !!live ||
            !isActive ||
            (g.arrangement && g.arrangement.mode !== "work")
          }
          run={() => start(false)}
        >
          <Play size={15} />
          开始运行
        </Action>
        {runs.data?.some((r) => r.thread_id) && (
          <Action disabled={!!live || !isActive} run={() => start(true)}>
            继续原线程
          </Action>
        )}
        <Action
          run={() =>
            api("/goals/" + id + (isActive ? "/pause" : "/resume"), {})
          }
        >
          <Pause size={14} />
          {isActive ? "暂停新运行" : "恢复目标"}
        </Action>
        {live && live.status !== "unknown" && (
          <Action run={() => api("/goals/" + id + "/interrupt", {})}>
            <Square size={13} />
            中断本轮
          </Action>
        )}
        <button
          onClick={() =>
            chat({ kind: "goal", ref: id, goalId: id, title: g.title })
          }
        >
          <MessageSquare size={15} />
          跟进目标
        </button>
      </div>
      {pref && <Preference goalId={id} close={() => setPref(false)} />}
      <div className="tabs line">
        {["概况", "运行记录", "计划任务", "指令历史"]
          .filter((t) => !(t === "计划任务" && g.arrangement))
          .map((t) => (
            <button
              key={t}
              className={tab === t ? "selected" : ""}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
      </div>
      {tab === "概况" && (
        <>
          <section>
            <h2>历次交付</h2>
            {g.nativeResults?.length ? (
              g.nativeResults.map((r: Data) => (
                <article className="panel pad" key={r.id}>
                  <time>{dt(r.created)}</time>
                  <Markdown text={r.body} />
                  <a href={"#chat/" + id}>在主对话中继续</a>
                </article>
              ))
            ) : !reports.data ? (
              <Status error={reports.error} />
            ) : reports.data.length ? (
              reports.data.map((r) => <Delivery key={r.id} r={r} />)
            ) : (
              <p>
                {live?.status === "waiting_approval"
                  ? "正在等你的决定。"
                  : live
                    ? "正在处理，结果会出现在这里。"
                    : runs.data?.[0]?.status === "failed" ||
                        g.messages?.[0]?.status === "failed"
                      ? "这次没有完成。请查看运行记录了解原因。"
                      : "还没有可阅读的交付。"}{" "}
                {live?.status === "waiting_approval" && (
                  <a href="#inbox">去处理</a>
                )}
              </p>
            )}
          </section>
          <details className="panel pad">
            <summary>原始要求与验收记录</summary>
            <section className="panel pad">
              <h2>验收条件</h2>
              <ul className="criteria">
                {JSON.parse(g.criteria).map((c: string, i: number) => (
                  <li key={i}>
                    <Action
                      className="criterion"
                      run={() =>
                        api("/goals/" + id + "/check", {
                          criterion: c,
                          checked: !g.checks.some(
                            (v: Data) => v.criterion === c,
                          ),
                        })
                      }
                    >
                      {g.checks.some((v: Data) => v.criterion === c) ? (
                        <Check size={14} />
                      ) : (
                        <span className="check-square" />
                      )}
                      {c}
                    </Action>
                  </li>
                ))}
              </ul>
              <h3>后续执行遵循的要求</h3>
              <p>
                {JSON.parse(g.constraints_json).join(" · ") || "未设置额外约束"}
              </p>
              <div className="meta">
                <Folder size={15} />
                {g.workspace.path}
              </div>
            </section>
          </details>
          <details className="panel pad">
            <summary>工作进展与文件依据</summary>
            <section>
              <h2>工作进展</h2>
              <div className="panel">
                {stories.data?.length ? (
                  stories.data.map((st) => <Story key={st.id} s={st} />)
                ) : (
                  <p className="empty">尚无工作记录</p>
                )}
              </div>
            </section>
            <section>
              <h2>已核对的文件</h2>
              <div className="panel pad">
                {g.artifacts.length
                  ? g.artifacts.map((a: Data) => (
                      <p key={a.id}>
                        <Check size={14} /> <code>{a.path}</code> ·{" "}
                        {dt(a.verified)} ·{" "}
                        <a href={"#run/" + a.run_id}>查看来源</a>
                      </p>
                    ))
                  : "暂无已核对的文件"}
              </div>
            </section>
          </details>
        </>
      )}
      {tab === "运行记录" && (
        <div className="panel">
          {runs.data?.length ? (
            runs.data.map((r) => (
              <a key={r.id} href={"#run/" + r.id} className="listrow">
                <Clock3 size={17} />
                <b>{dt(r.created)}</b>
                <Provider value={r.provider} />
                <Badge value={r.status} />
              </a>
            ))
          ) : (
            <p className="empty">还没有运行</p>
          )}
        </div>
      )}
      {tab === "指令历史" && (
        <div className="panel">
          {g.messages.length ? (
            g.messages.map((m: Data) => (
              <div className="listrow" key={m.id}>
                <div className="grow">
                  {m.content}
                  <div className="meta">{dt(m.created)}</div>
                </div>
                <Badge value={m.status} />
              </div>
            ))
          ) : (
            <p className="empty">暂无跟进指令</p>
          )}
        </div>
      )}
      {tab === "计划任务" && (
        <>
          <section className="panel pad">
            <h2>授权后续运行</h2>
            <Form
              onSubmit={async (f) => {
                await api("/goals/" + id + "/schedules", {
                  kind: field(f, "kind"),
                  minutes: Number(field(f, "minutes")),
                  nextAt: new Date(field(f, "nextAt")).toISOString(),
                  instruction: field(f, "instruction"),
                });
                notice("计划已保存");
              }}
            >
              <label>
                执行指令
                <textarea name="instruction" required rows={2} />
              </label>
              <div className="formrow">
                <label>
                  重复方式
                  <select name="kind">
                    <option value="one_off">仅一次</option>
                    <option value="interval">按间隔重复</option>
                  </select>
                </label>
                <label>
                  间隔（分钟）
                  <input
                    type="number"
                    name="minutes"
                    min="1"
                    defaultValue="60"
                    required
                  />
                </label>
              </div>
              <label>
                下次执行时间
                <input required name="nextAt" type="datetime-local" />
              </label>
              <button className="primary">授权计划</button>
            </Form>
            {g.jobs.map((j: Data) => (
              <div className="listrow" key={j.id}>
                <div className="grow">
                  {j.instruction}
                  <div className="meta">
                    {dt(j.next_at)} · {j.last_error}
                  </div>
                </div>
                <Badge value={j.state} />
                {j.state !== "disabled" && (
                  <Action run={() => api("/schedules/" + j.id + "/stop", {})}>
                    停止
                  </Action>
                )}
              </div>
            ))}
          </section>
          <section className="panel pad">
            <h2>此目标的运行限制</h2>
            <Limits url={"/goals/" + id + "/limits"} data={g.limits} />
          </section>
        </>
      )}
    </>
  );
}
export function Limits({
  url,
  data,
  settings = false,
}: {
  url: string;
  data: Data;
  settings?: boolean;
}) {
  const { notice } = useApp();
  return (
    <Form
      onSubmit={async (f) => {
        const cfg: Data = {};
        for (const k of ["budget", "cooldown", "maxMinutes"])
          cfg[k] = Number(field(f, k));
        if (settings) cfg.dailyTime = field(f, "dailyTime");
        await api(url, cfg, "PATCH");
        notice("设置已保存");
      }}
    >
      <div className="formrow">
        {[
          ["budget", "每日运行上限", 1, 48],
          ["cooldown", "冷却时间（分）", 0, 1440],
          ["maxMinutes", "最长执行（分）", 1, 240],
        ].map(([k, t, min, max]) => (
          <label key={k}>
            {t}
            <input
              required
              type="number"
              name={String(k)}
              min={min}
              max={max}
              defaultValue={data[k]}
            />
          </label>
        ))}
      </div>
      {settings && (
        <label>
          每日简报时间
          <input
            required
            type="time"
            name="dailyTime"
            defaultValue={data.dailyTime}
          />
        </label>
      )}
      <button>保存设置</button>
    </Form>
  );
}
