export function renderPlans(host, state, selected, select, save) {
  const { plans } = state;
  const current = plans.find(plan => plan.id === selected) ?? plans[0];
  const doc = host.ownerDocument;
  const content = doc.createDocumentFragment();
  const element = (tag, text) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function nameForm(label, action, submit, disabled = false) {
    const form = element("form");
    form.style.display = "inline-flex";
    form.setAttribute("aria-label", action);
    const field = element("label", label);
    const input = element("input");
    input.required = true;
    input.disabled = disabled;
    field.append(input);
    const button = element("button", action);
    button.type = "submit";
    button.disabled = disabled;
    form.append(field, button);
    form.addEventListener("submit", event => {
      event.preventDefault();
      const name = input.value.trim();
      if (disabled) return;
      if (name) submit(name);
      else input.focus();
    });
    return form;
  }

  const list = element("div");
  for (const plan of plans) {
    const button = element("button", plan.name);
    button.type = "button";
    const active = plan.id === current.id;
    button.setAttribute("aria-pressed", String(active));
    if (active) button.style.fontWeight = "bold";
    button.addEventListener("click", () => select(plan.id));
    list.append(button);
  }
  content.append(list, nameForm("计划名称", "创建计划", name => {
    const id = crypto.randomUUID();
    const buckets = [{ id: crypto.randomUUID(), name: "默认分组" }];
    save({ ...state, plans: [...plans, { id, name, buckets, tasks: [] }] }, id);
  }));

  if (current) {
    const groups = element("ul");
    for (const bucket of current.buckets) groups.append(element("li", bucket.name));
    content.append(groups);
  }
  content.append(nameForm("分组名称", "新增分组", name => {
    const bucket = { id: crypto.randomUUID(), name };
    const updated = plans.map(plan => plan.id === current.id
      ? { ...plan, buckets: [...plan.buckets, bucket] }
      : plan);
    save({ ...state, plans: updated }, current.id);
  }, !current));
  host.replaceChildren(content);
}
