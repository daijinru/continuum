export function editTask(plan, existing, onSave, onRemove, defaultBucket) {
  const make = tag => document.createElement(tag);
  const dialog = make("dialog");
  const form = make("form");
  const heading = make("h2");
  heading.id = crypto.randomUUID();
  heading.textContent = existing ? "编辑任务" : "新增任务";
  dialog.setAttribute("aria-labelledby", heading.id);
  dialog.append(form);
  form.append(heading);

  function field(name, tag, value, type, options) {
    const row = make("p");
    const label = make("label");
    const control = make(tag);
    if (type) control.type = type;
    for (const [id, text] of options ?? []) {
      control.add(new Option(text, id));
    }
    control.id = heading.id + "-" + name;
    label.htmlFor = control.id;
    label.textContent = name;
    control.value = value ?? "";
    row.append(label, control);
    form.append(row);
    return control;
  }

  const title = field("标题", "input", existing?.title);
  title.required = true;
  title.pattern = ".*\\S.*";
  title.autofocus = true;
  const owner = field("负责人", "input", existing?.owner);
  const due = field("截止日期", "input", existing?.due, "date");
  const notes = field("说明", "textarea", existing?.notes);
  const groups = plan.buckets.map(b => [b.id, b.name]);
  const preferred = existing?.bucket ?? defaultBucket;
  const selected = groups.some(([id]) => id === preferred) ? preferred : groups[0]?.[0];
  const bucket = field("分组", "select", selected, null, groups);
  const statuses = ["待办", "进行中", "已完成"].map(s => [s, s]);
  const status = field("进度", "select", existing?.status ?? "待办", null, statuses);

  function button(text, action) {
    const el = make("button");
    el.type = action ? "button" : "submit";
    el.textContent = text;
    if (action) el.addEventListener("click", action);
    form.append(el);
  }
  function close() {
    dialog.close();
    dialog.remove();
  }
  button("保存");
  button("取消", close);
  if (existing) button("删除任务", () => {
    if (!window.confirm("确定删除这项任务吗？")) return;
    close();
    onRemove(existing.id);
  });
  form.onsubmit = event => {
    event.preventDefault();
    const task = {
      id: existing?.id ?? crypto.randomUUID(), title: title.value.trim(),
      owner: owner.value, due: due.value, notes: notes.value,
      bucket: bucket.value, status: status.value
    };
    close();
    onSave(task);
  };
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
}
