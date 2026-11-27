import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import {
  parseMessageFilePaths,
  documentFile,
} from "../../../packages/contracts/src/parse-message-files.ts";
import { Problem, verifiedFile, type Store } from "./db.ts";

export function messageFile(db: Store, id: string, reference: string) {
  const message = db.must(
    `SELECT m.body,r.id run_id,coalesce((
        SELECT h.workspace_id FROM directory_holds h WHERE h.goal_id=g.id
        AND h.replacement_path IS NOT NULL AND h.resolved_at>=r.created
        ORDER BY h.resolved_at LIMIT 1),g.workspace_id) workspace_id
     FROM main_messages m
     LEFT JOIN raw_events e ON m.origin='event:'||m.id AND e.id=m.id
     JOIN agent_runs r ON r.id=coalesce(e.run_id,substr(m.origin,5))
     JOIN goals g ON g.id=r.goal_id
     WHERE m.id=? AND m.role='assistant' AND (m.origin LIKE 'run:%' OR e.id IS NOT NULL)`,
    id,
  );
  if (!parseMessageFilePaths(message.body).has(reference))
    throw new Problem("这条回复中找不到该文件", 404);
  const root = db.allowed(message.workspace_id);
  let target = resolve(root, reference);
  if (reference === basename(reference)) {
    const matches = db
      .all("SELECT path FROM artifacts WHERE run_id=?", message.run_id)
      .map((row) => row.path as string)
      .filter((path) => basename(path) === reference);
    if (matches.length > 1)
      throw new Problem("本轮有多个同名文件，请使用完整路径", 409);
    if (matches.length) target = matches[0];
  }
  const actual = verifiedFile(root, target);
  if (!actual)
    throw new Problem("在本轮项目目录中找不到文件，文件可能已移动或删除", 404);
  if (!documentFile.test(actual) || statSync(actual).mode & 0o111)
    throw new Problem("此文件类型不支持直接打开");
  return actual;
}

export async function openDocument(path: string) {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Problem("当前系统不支持自动打开文件", 501);
  try {
    await promisify(execFile)(
      process.platform === "darwin" ? "/usr/bin/open" : "xdg-open",
      [path],
      { timeout: 10000 },
    );
  } catch {
    throw new Problem("未能打开文件，请检查系统是否安装了对应的应用", 503);
  }
}
