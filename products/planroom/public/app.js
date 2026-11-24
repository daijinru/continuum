import { renderPlans } from "./plans.js";
import { renderBoard } from "./board.js";
import { editTask } from "./editor.js";

const plans = document.querySelector("#plans");
const board = document.querySelector("#board");
const notice = document.querySelector("#notice");
const key = "planroom.selected";
let state, selected, saving = false;
try { selected = localStorage.getItem(key); } catch {}

function select(id) {
  selected = id;
  draw();
}

function draw() {
  const plan = state.plans.find(p => p.id === selected) ?? state.plans[0];
  selected = plan?.id;
  try {
    if (plan) localStorage.setItem(key, selected);
    else localStorage.removeItem(key);
  } catch {}
  plans.replaceChildren();
  board.replaceChildren();
  renderPlans(plans, state, selected, select, save);
  if (!plan) {
    board.textContent = "还没有计划，请先创建计划。";
    return;
  }
  renderBoard(board, plan, (existing, bucket) => {
    const update = tasks => save({
      plans: state.plans.map(p => p.id === plan.id ? { ...p, tasks } : p)
    });
    editTask(plan, existing, task => {
      const tasks = existing
        ? plan.tasks.map(t => t.id === existing.id ? { ...t, ...task, id: t.id } : t)
        : [...plan.tasks, { ...task, id: task.id ?? crypto.randomUUID() }];
      return update(tasks);
    }, () => update(plan.tasks.filter(t => t.id !== existing.id)), bucket);
  });
}

async function save(next, nextId) {
  if (saving) {
    notice.textContent = "正在保存，请稍后再试。";
    return false;
  }
  saving = true;
  try {
    const res = await fetch("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: state.version, plans: next.plans ?? next })
    });
    if (res.status === 409) {
      notice.textContent = "保存冲突，请重新加载页面后再试。";
      return false;
    }
    if (!res.ok) throw Error();
    state = await res.json();
    select(nextId ?? selected);
    notice.textContent = "已保存。";
    return true;
  } catch {
    notice.textContent = "保存失败，请重试。";
    return false;
  } finally {
    saving = false;
  }
}

try {
  const res = await fetch("/api/state", { cache: "no-store" });
  if (!res.ok) throw Error();
  state = await res.json();
  draw();
  notice.textContent = "";
} catch {
  notice.textContent = "加载失败，请重新加载页面。";
}
