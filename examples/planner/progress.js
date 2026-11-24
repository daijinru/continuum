export function summarize(tasks, today) {
  const total = tasks.length;
  let done = 0;
  let active = 0;
  let overdue = 0;

  for (const { stage, due } of tasks) {
    if (stage === '已完成') {
      done++;
      continue;
    }

    if (stage === '进行中') {
      active++;
    }
    if (due && due < today) {
      overdue++;
    }
  }

  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return { total, done, active, overdue, percent };
}
