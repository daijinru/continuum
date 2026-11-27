import { useState } from "react";
import type { ConversationLogEntry } from "../../../packages/contracts/src/conversation-log.ts";
import { api, Status } from "./lib.tsx";

const stageNames: Record<string, string> = {
  queued: "消息已排队",
  sending: "正在发送消息",
  send_failed: "消息发送失败",
  accepted: "页面收到发送确认",
  received: "服务收到消息",
  handling: "开始处理消息",
  handling_failed: "消息处理失败",
  committed: "消息已保存",
  stream_open: "服务已建立连接",
  stream_close: "服务已关闭连接",
  stream_write: "服务已推送更新",
  backpressure: "等待发送缓冲区腾出空间",
  drain: "发送缓冲区可继续写入",
  connected: "页面已连接",
  disconnected: "页面连接中断",
  notice: "页面收到更新通知",
  visible: "页面回到前台",
  hidden: "页面进入后台",
  applied: "消息列表已更新",
  on_screen: "消息进入可见区域",
  load_failed: "消息列表读取失败",
};
const localTime = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  fractionalSecondDigits: 3, hourCycle: "h23",
});

export function ConversationLogViewer() {
  const [rows, setRows] = useState<ConversationLogEntry[]>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      setRows(await api("/conversation/log"));
    } catch {
      setError("日志读取失败，请刷新重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel pad" aria-labelledby="conversation-log-title">
      <div className="section-head">
        <h2 id="conversation-log-title">主对话日志</h2>
        <button type="button" onClick={refresh} disabled={busy}>
          {busy ? "读取中…" : rows || error ? "刷新日志" : "查看日志"}
        </button>
      </div>
      <p className="muted">按本机时间查看最近 100 条消息收发和页面连接记录，最新的在前。</p>
      {error && <Status error={error} />}
      {rows?.length === 0 && !error && <p role="status">暂无主对话日志。</p>}
      {!!rows?.length && (
        <div className="conversation-log-list record-list">
          {rows.map(row => (
            <details key={row.seq} className="read-more">
              <summary>
                <time dateTime={row.at}>{localTime.format(new Date(row.at))}</time>
                {" "}{stageNames[row.stage] ?? row.stage}
              </summary>
              <dl>
                <dt>阶段</dt><dd><code>{row.stage}</code></dd>
                {row.message_id && <><dt>消息 ID</dt><dd><code>{row.message_id}</code></dd></>}
                {row.page_id && <><dt>页面 ID</dt><dd><code>{row.page_id}</code></dd></>}
                {row.version !== null && <><dt>变更版本</dt><dd>{row.version}</dd></>}
                {row.client_at && <><dt>页面记录时间</dt><dd>{localTime.format(new Date(row.client_at))}</dd></>}
              </dl>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
