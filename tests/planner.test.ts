import assert from "node:assert/strict";
import test from "node:test";
import { filterTasks } from "../examples/planner/filters.js";
import { summarize } from "../examples/planner/progress.js";

const tasks = [
  {
    id: "1",
    title: "Release UI",
    owner: "Lin",
    stage: "进行中",
    due: "2026-11-23",
  },
  {
    id: "2",
    title: "Release docs",
    owner: "An",
    stage: "已完成",
    due: "2026-11-23",
  },
  { id: "3", title: "Review", owner: "Lin", stage: "待办", due: "2026-11-24" },
  { id: "4", title: "Plan", owner: "An", stage: "进行中", due: "" },
];
test("Planner 筛选可叠加、搜索负责人并恢复原顺序", () => {
  assert.deepEqual(
    filterTasks(tasks, { query: " RELEASE ", owner: "Lin", stage: "进行中" }),
    [tasks[0]],
  );
  assert.deepEqual(filterTasks(tasks, { query: "lin" }), [tasks[0], tasks[2]]);
  assert.deepEqual(filterTasks(tasks), tasks);
});
test("Planner 按当前结果计算进度，截止日当天不算逾期", () => {
  assert.deepEqual(summarize(tasks, "2026-11-24"), {
    total: 4,
    done: 1,
    active: 2,
    overdue: 1,
    percent: 25,
  });
  assert.deepEqual(summarize([], "2026-11-24"), {
    total: 0,
    done: 0,
    active: 0,
    overdue: 0,
    percent: 0,
  });
});
