export const stages = ["待办", "进行中", "已完成"];

export function renderBoard(host, tasks, onMove) {
  const doc = host.ownerDocument;
  const board = doc.createDocumentFragment();

  function element(tag, text) {
    const node = doc.createElement(tag);
    node.textContent = text;
    return node;
  }

  for (const stage of stages) {
    const items = tasks.filter(task => task.stage === stage);
    const lane = doc.createElement("section");
    lane.className = "lane";
    lane.append(element("h2", `${stage}（${items.length}）`));

    if (items.length === 0) lane.append(element("p", "暂无任务"));

    for (const task of items) {
      const card = doc.createElement("article");
      card.className = "task";
      card.append(
        element("h3", task.title),
        element("p", `负责人：${task.owner || "未指定"}`),
        element("p", `截止日期：${task.due || "未设置"}`)
      );

      if ("source" in task) {
        const link = element("a", "查看来源目标");
        link.href = task.source;
        card.append(link);
      } else {
        const select = doc.createElement("select");
        select.setAttribute("aria-label", `移动任务「${task.title}」到目标阶段`);
        for (const target of stages) {
          const option = element("option", target);
          option.value = target;
          select.append(option);
        }
        select.value = stage;
        select.addEventListener("change", () => onMove(task.id, select.value));
        card.append(select);
      }
      lane.append(card);
    }
    board.append(lane);
  }
  host.replaceChildren(board);
}
