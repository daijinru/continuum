import React, { useState } from "react";
import { Badge, dt, Status, useData, type Data } from "./lib.tsx";

function ApprovalList({ goal, before }: { goal: string; before?: number }) {
  const [more, setMore] = useState(false);
  const { data, error } = useData(
    "/conversation/approvals/" + goal + (before ? "?before=" + before : ""),
  );
  if (!data) return <Status error={error} />;
  return (
    <>
      <ul>
        {data.map((item) => (
          <li key={item.id}>
            <a href={"#inbox/" + item.id}>{item.title}</a>
            <time dateTime={item.created}>{dt(item.created)}</time>
            <Badge value={item.status} />
          </li>
        ))}
      </ul>
      {data.length === 30 &&
        (more ? (
          <ApprovalList goal={goal} before={data[data.length - 1].seq} />
        ) : (
          <button onClick={() => setMore(true)}>查看更早的审批</button>
        ))}
    </>
  );
}

export function ChatApprovals({
  message,
  reply,
}: {
  message: Data;
  reply: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="chat-approvals">
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <strong>操作审批</strong>
          <span className="approval-goal" title={message.refs[0]?.title}>
            {message.refs[0]?.title || "这项委托"}
          </span>
          <span>
            {message.approvalPending
              ? message.approvalPending + " 条待处理"
              : "已处理 " + message.approvalTotal + " 条"}
          </span>
        </summary>
        {open && (
          <>
            <ApprovalList goal={message.approvalGoal} />
            <div className="links">
              <a href={"#goal/" + message.approvalGoal}>查看委托</a>
              <button onClick={reply}>回复这条</button>
            </div>
          </>
        )}
      </details>
      {message.nextApproval && (
        <a className="approval-next" href={"#inbox/" + message.nextApproval}>
          去处理
        </a>
      )}
    </section>
  );
}
