import { execFile } from "node:child_process";
import { constants, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { previewImage } from "../../../packages/contracts/src/message-files.ts";
import { imageMime } from "./chat-images.ts";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import {
  parseMessageFilePaths,
  documentFile,
} from "../../../packages/contracts/src/parse-message-files.ts";
import { Problem, verifiedFile, type Store } from "./db.ts";

export function messageFile(
  db: Store,
  id: string,
  reference: string,
  preview = false,
) {
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
  if (preview) {
    if (!previewImage.test(actual)) throw new Problem("此文件不支持图片预览");
    return actual;
  }
  if (!documentFile.test(actual) || statSync(actual).mode & 0o111)
    throw new Problem("此文件类型不支持直接打开");
  return actual;
}

export async function readPreview(db: Store, id: string, reference: string) {
  const path = messageFile(db, id, reference, true);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    // Check the opened file as well: a project folder may move during the
    // asynchronous open, including being replaced with a symlink.
    const current = statSync(path);
    if (realpathSync(path) !== path || stat.dev !== current.dev || stat.ino !== current.ino ||
        !stat.isFile() || !stat.size) throw new Problem("图片已变更或不可读取");
    const head = Buffer.alloc(Math.min(4096, stat.size));
    await handle.read(head, 0, head.length, 0);
    let mime: string | undefined = imageMime(head);
    if (/^GIF8[79]a/.test(head.toString("ascii", 0, 6))) mime = "image/gif";
    else if (head.toString("ascii", 0, 2) === "BM") mime = "image/bmp";
    else if (/\.svg$/i.test(path) && /<svg[\s>]/.test(head.toString("utf8")))
      mime = "image/svg+xml";
    if (!mime) throw new Problem("无法识别图片格式");
    return {
      mime,
      stream: handle.createReadStream({ start: 0, end: stat.size - 1 }),
    };
  } catch (e) {
    await handle.close();
    throw e;
  }
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
