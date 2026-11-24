export function filterTasks(tasks, { query = "", stage = "", owner = "" } = {}) {
  const keyword = query.trim().toLowerCase();

  return tasks.filter((task) =>
    (stage === "" || task.stage === stage) &&
    (owner === "" || task.owner === owner) &&
    (keyword === "" ||
      task.title.toLowerCase().includes(keyword) ||
      task.owner.toLowerCase().includes(keyword))
  );
}
