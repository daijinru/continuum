import type { FastifyInstance } from "fastify";
import {
  imageTypes,
  maxImageBytes,
} from "../../../packages/contracts/src/chat-images.ts";
import { now, Problem, uid, type Store } from "./db.ts";

export function imageMime(bytes: Buffer) {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
}

export function registerChatImages(app: FastifyInstance, db: Store) {
  const path = "/api/v1/conversation/images";
  app.addContentTypeParser(
    imageTypes,
    { parseAs: "buffer", bodyLimit: maxImageBytes },
    (_req, body, done) => done(null, body),
  );
  app.post(path, { bodyLimit: maxImageBytes }, (req, reply) => {
    const bytes = req.body;
    const mime = Buffer.isBuffer(bytes) && imageMime(bytes);
    if (!mime || mime !== req.headers["content-type"])
      throw new Problem("请选择 PNG、JPEG 或 WebP 图片");
    db.run(
      "DELETE FROM conversation_images WHERE message_id IS NULL AND created<?",
      new Date(Date.now() - 7 * 86400000).toISOString(),
    );
    const id = uid();
    db.run(
      "INSERT INTO conversation_images(id,mime,bytes,created) VALUES(?,?,?,?)",
      id,
      mime,
      bytes,
      now(),
    );
    return reply.send({ data: { id } });
  });
  app.get<{ Params: { id: string } }>(path + "/:id", (req, reply) => {
    const image = db.must(
      "SELECT mime,bytes FROM conversation_images WHERE id=?",
      req.params.id,
    );
    return reply
      .header("Cross-Origin-Resource-Policy", "same-origin")
      .type(image.mime)
      .send(Buffer.from(image.bytes));
  });
}

export function attachImages(db: Store, message: string, images: string[]) {
  let size = 0;
  images.forEach((id, position) => {
    const row = db.one(
      "SELECT length(bytes) size FROM conversation_images WHERE id=? AND message_id IS NULL",
      id,
    );
    if (!row) throw new Problem("图片已失效，请重新粘贴");
    size += row.size;
    if (size > maxImageBytes) throw new Problem("每条消息的图片合计最多 8 MB");
    db.run(
      "UPDATE conversation_images SET message_id=?,position=? WHERE id=?",
      message,
      position,
      id,
    );
  });
}
