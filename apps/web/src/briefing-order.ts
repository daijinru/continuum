type Entry = { [key: string]: any };
const newest = (a: Entry, b: Entry) =>
  String(b.updated).localeCompare(String(a.updated)) ||
  Number(b.last_seq) - Number(a.last_seq);

// Use only facts captured in this snapshot, even when presenting an old briefing.
export function arrangeBriefing(sections: {
  changes: Entry[];
  outcomes: Entry[];
  insights: Entry[];
}) {
  const all = [
    ...sections.changes,
    ...sections.outcomes,
    ...sections.insights,
  ].sort(newest);
  const risks = all.filter((s) => s.category === "risk");
  const highlights: Entry[] = [],
    process: Entry[] = [];
  const messages = new Set<string>();
  const fileRuns = new Set<string>();
  const hasFiles = new Set(
    all
      .filter(
        (x) => x.category === "outcome" && x.title.startsWith("文件变更 · "),
      )
      .map((x) => x.run_id),
  );
  for (const s of all) {
    const run = s.run_id || s.id;
    if (s.category === "risk") continue;
    const file = s.category === "outcome" && s.title.startsWith("文件变更 · ");
    if (s.category === "insight") {
      if (
        messages.has(run) ||
        /^(我会|我将|我先|接下来我|I'll |I will )/i.test(s.summary || s.title)
      ) {
        process.push(s);
        continue;
      }
      messages.add(run);
      // Implementation notes stay available verbatim below the verified file result.
      if (
        /(?:apply_patch|\.\/public\/|\/Users\/|\.js\b|\.tsx\b)/.test(s.title) &&
        hasFiles.has(run)
      ) {
        process.push(s);
        continue;
      }
    }
    if (s.category === "change" || (file && fileRuns.has(run))) process.push(s);
    else {
      highlights.push(s);
      if (file) fileRuns.add(run);
    }
  }
  return { risks, highlights, process };
}
