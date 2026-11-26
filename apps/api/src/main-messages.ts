import { now, uid, type Store } from "./db.ts";

export function post(
  db: Store,
  role: "assistant" | "user",
  kind: string,
  body: string,
  ids: string[],
  origin: string,
  reply: string | null = null,
  id: string = uid(),
) {
  const created = db.run(
    "INSERT INTO main_messages(id,role,kind,body,reply_to,origin,created) VALUES(?,?,?,?,?,?,?) ON CONFLICT(origin) DO NOTHING",
    id,
    role,
    kind,
    body,
    reply,
    origin,
    now(),
  );
  if (!created.changes)
    return db.must("SELECT id FROM main_messages WHERE origin=?", origin)
      .id as string;
  for (const goal of new Set(ids))
    db.run("INSERT INTO main_refs VALUES(?,?)", id, goal);
  return id;
}
