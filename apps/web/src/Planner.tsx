import React, { useEffect, useMemo, useRef, useState } from "react";
import { Head, Status, useData, useApp } from "./lib.tsx";
import {
  renderBoard,
  stages,
  type Task,
} from "../../../examples/planner/board.js";
import { filterTasks } from "../../../examples/planner/filters.js";
import { summarize } from "../../../examples/planner/progress.js";
import "./planner.css";

const storage = "continuum:planner:personal:v1";
export function Planner() {
  const goals = useData("/goals?limit=500"),
    { notice } = useApp();
  const [personal, setPersonal] = useState<Task[]>(() => {
    try {
      const rows: unknown = JSON.parse(localStorage.getItem(storage) || "[]");
      return Array.isArray(rows)
        ? rows.filter(
            (t) =>
              t &&
              !t.source &&
              ["id", "title", "owner", "due"].every(
                (k) => typeof t[k] === "string",
              ) &&
              stages.includes(t.stage),
          )
        : [];
    } catch {
      return [];
    }
  });
  const [query, setQuery] = useState(""),
    [stage, setStage] = useState(""),
    [owner, setOwner] = useState("");
  const board = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<"personal" | "product">("personal");
  const tasks = useMemo(
    () => [
      ...(goals.data || [])
        .filter((g) => g.provider === "codex" && g.workspace === "planner")
        .map((g) => ({
          id: g.id,
          title: g.title,
          owner: "Codex",
          due: "",
          source: "#goal/" + g.id,
          stage:
            g.state === "completed" ? "已完成" : g.latest ? "进行中" : "待办",
        })),
      ...personal,
    ],
    [goals.data, personal],
  );
  const visible = useMemo(
    () =>
      filterTasks(
        tasks.filter((t) => (view === "product" ? !!t.source : !t.source)),
        { query, stage, owner },
      ),
    [tasks, query, stage, owner, view],
  );
  function save(rows: Task[]) {
    try {
      localStorage.setItem(storage, JSON.stringify(rows));
      setPersonal(rows);
      return true;
    } catch {
      notice("保存失败，请检查浏览器存储空间");
      return false;
    }
  }
  useEffect(() => {
    if (board.current)
      renderBoard(board.current, visible, (id, next) =>
        save(personal.map((t) => (t.id === id ? { ...t, stage: next } : t))),
      );
  }, [visible, personal, goals.data]);
  const stats = summarize(visible, new Date().toLocaleDateString("sv-SE"));
  return (
    <>
      <Head
        title="Planner 工作板"
        sub="把要做的事记下来，写上谁负责、哪天到期。开始做时移到「进行中」，做完移到「已完成」。你添加的任务保存在本浏览器。"
      />
      <div className="tabs" aria-label="任务范围">
        {(["personal", "product"] as const).map((v) => (
          <button
            key={v}
            aria-pressed={view === v}
            className={view === v ? "selected" : ""}
            onClick={() => {
              setView(v);
              setQuery("");
              setOwner("");
              setStage("");
            }}
          >
            {v === "personal" ? "我的任务" : "产品目标与交付记录"}
          </button>
        ))}
      </div>
      {view === "product" && (
        <p>
          这些是开发这块任务板时实际完成的目标。点击卡片中的来源，可查看每个目标的验收条件。
        </p>
      )}
      {view === "personal" && (
        <form
          className="panel pad planner-tools"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget,
              f = new FormData(form),
              title = String(f.get("title")).trim();
            if (!title) return;
            if (
              save([
                ...personal,
                {
                  id: crypto.randomUUID(),
                  title,
                  stage: "待办",
                  owner: String(f.get("owner")).trim(),
                  due: String(f.get("due")),
                },
              ])
            )
              form.reset();
          }}
        >
          <label>
            任务名称
            <input
              name="title"
              placeholder="例如：周五前确认活动场地"
              required
              maxLength={120}
            />
          </label>
          <label>
            负责人
            <input name="owner" maxLength={64} />
          </label>
          <label>
            截止日期
            <input name="due" type="date" />
          </label>
          <button className="primary">添加个人任务</button>
        </form>
      )}
      <div className="planner-tools">
        <label>
          搜索
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="标题或负责人"
          />
        </label>
        <label>
          阶段
          <select
            aria-label="阶段"
            value={stage}
            onChange={(e) => setStage(e.target.value)}
          >
            <option value="">全部阶段</option>
            {stages.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          筛选负责人
          <select
            aria-label="筛选负责人"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          >
            <option value="">所有人</option>
            {[
              ...new Set(
                tasks
                  .filter((t) => (view === "product" ? !!t.source : !t.source))
                  .map((t) => t.owner)
                  .filter(Boolean),
              ),
            ].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <button
          onClick={() => {
            setQuery("");
            setStage("");
            setOwner("");
          }}
        >
          清空筛选
        </button>
      </div>
      <p aria-live="polite">
        当前结果 {stats.total} 项 · 进行中 {stats.active} · 已完成 {stats.done}{" "}
        · 逾期 {stats.overdue} · 完成率 {stats.percent}%
      </p>
      {!goals.data && <Status error={goals.error} />}
      <div ref={board} className="planner-board" />
    </>
  );
}
