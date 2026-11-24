const filters = new WeakMap();

function el(tag, text) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  return node;
}

function select(label, values, saved) {
  const wrap = el('label', label);
  const input = el('select');
  input.add(new Option('全部' + label, ''));
  for (const value of values) {
    input.add(new Option(value || '未分配', value, false, value === saved));
  }
  wrap.append(input);
  return [wrap, input];
}

export function renderBoard(host, plan, open) {
  const saved = filters.get(host);
  const prior = saved?.id === plan.id && saved;
  const owners = [...new Set(plan.tasks.map(t => t.owner || ''))];
  const [who, owner] = select('负责人', owners, prior?.owner);
  const [what, status] = select('状态', ['待办', '进行中', '已完成'], prior?.status);
  const summary = el('output');
  const lanes = el('div');
  lanes.className = 'lanes';

  function draw() {
    const wanted = owner.selectedIndex ? owner.value : undefined;
    filters.set(host, { id: plan.id, owner: wanted, status: status.value });
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const today = [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())].join('-');
    const groups = new Map(plan.buckets.map(b => [b.id, []]));
    let total = 0, done = 0, late = 0;
    for (const t of plan.tasks) {
      if (wanted !== undefined && wanted !== (t.owner || '')) continue;
      if (status.value && status.value !== t.status) continue;
      total++;
      const overdue = t.status !== '已完成' && t.due && t.due < today;
      if (t.status === '已完成') done++;
      if (overdue) late++;
      const card = el('button', [t.title, t.owner || '未分配', t.status, t.due, overdue && '逾期'].filter(Boolean).join(' · '));
      card.type = 'button';
      card.className = 'card';
      card.onclick = () => open(t, t.bucket);
      groups.get(t.bucket).push(card);
    }
    summary.textContent = `共 ${total} 项，已完成 ${done} 项，剩余 ${total - done} 项，逾期 ${late} 项`;
    lanes.replaceChildren(...plan.buckets.map(b => {
      const lane = el('section');
      lane.className = 'lane';
      const add = el('button', '新增任务');
      add.type = 'button';
      add.onclick = () => open(null, b.id);
      lane.append(el('h3', b.name), add, ...groups.get(b.id));
      return lane;
    }));
  }
  owner.onchange = status.onchange = draw;
  host.replaceChildren(who, what, summary, lanes);
  draw();
}
