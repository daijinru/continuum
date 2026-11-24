import React, { useState } from "react";
import {
  api,
  dt,
  field,
  Form,
  Modal,
  useApp,
  useData,
  type Data,
} from "./lib.tsx";
import { Markdown } from "./Markdown.tsx";

export function NewCommission({ close }: { close: () => void }) {
  const { data: settings } = useData<Data>("/settings");
  const [key] = useState(() => crypto.randomUUID());
  const { notice } = useApp();
  return (
    <Modal title="交代一件事" close={close}>
      <Form
        onSubmit={async (f) => {
          const workspaceId = field(f, "workspace");
          const goal = await api("/commissions", {
            request: field(f, "request"),
            key,
            ...(workspaceId ? { workspaceId } : {}),
          });
          close();
          location.hash = "goal/" + goal.id;
          notice("委托已收到，首轮已排队。");
        }}
      >
        <label>
          你想得到什么？
          <textarea
            autoFocus
            name="request"
            required
            maxLength={4000}
            rows={5}
            placeholder="例如：帮我读 GitHub Trending，挑三个值得看的项目，告诉我为什么，并附原链接。"
          />
        </label>
        <details>
          <summary>使用已有项目（可选）</summary>
          <label>
            工作目录
            <select name="workspace">
              <option value="">为这件事创建独立目录</option>
              {settings?.workspaces
                .filter((w: Data) => w.enabled)
                .map((w: Data) => (
                  <option key={w.id} value={w.id}>
                    {w.path}
                  </option>
                ))}
            </select>
          </label>
          <p className="muted">选择已有项目时，涉及该项目的操作仍按原权限处理。</p>
        </details>
        <p className="muted">
          默认在专属目录里完成，不需要你确认每条命令。超出权限时会说明原因。提交后先执行一次。
        </p>
        <button className="primary">交给工作台</button>
      </Form>
    </Modal>
  );
}

export function Preference({
  goalId,
  close,
}: {
  goalId: string;
  close: () => void;
}) {
  const { notice } = useApp();
  return (
    <Modal title="修改下次要求" close={close}>
      <Form
        onSubmit={async (f) => {
          await api(`/goals/${goalId}/preferences`, { text: field(f, "text") });
          close();
          notice("已记住，下次执行这项委托时生效。");
        }}
      >
        <label>
          以后做这件事时，有什么要调整？
          <textarea
            name="text"
            autoFocus
            required
            rows={3}
            maxLength={1000}
            placeholder="例如：以后多关注普通人能直接使用的产品。"
          />
        </label>
        <p className="muted">
          只更新这项委托，不重跑本次结果，也不改变执行时间。
        </p>
        <button className="primary">记住这个要求</button>
      </Form>
    </Modal>
  );
}

export function Delivery({ r }: { r: Data }) {
  const [edit, setEdit] = useState(false);
  const parts = String(r.summary).split(/\n\s*\n/);
  // Keep a short, usable excerpt with source links; don't split Markdown tables.
  const split = parts.findIndex(
    (p, i) =>
      i > 0 &&
      (p.trimStart().startsWith("|") ||
        parts.slice(0, i + 1).join("\n\n").length > 950),
  );
  return (
    <article className="panel pad delivery">
      <div className="meta">
        <time>{dt(r.updated)}</time> ·{" "}
        {r.provider === "demo" ? "演示回复" : "助手交付"}
      </div>
      <h3>
        <a href={"#goal/" + r.goal_id}>{r.goal}</a>
      </h3>
      <Markdown
        text={parts.slice(0, split < 0 ? undefined : split).join("\n\n")}
      />
      {split >= 0 && (
        <details>
          <summary>展开完整结果</summary>
          <Markdown text={parts.slice(split).join("\n\n")} />
        </details>
      )}
      <div className="links">
        {r.workspace === "planroom" && (
          <a href="http://127.0.0.1:4320/" target="_blank" rel="noreferrer">
            打开计划室
          </a>
        )}
        <button onClick={() => setEdit(true)}>修改下次要求</button>
        <a href={"#run/" + r.run_id}>查看依据</a>
      </div>
      {edit && <Preference goalId={r.goal_id} close={() => setEdit(false)} />}
    </article>
  );
}
