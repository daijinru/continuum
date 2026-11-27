import React, { useState } from "react";
import { Badge, dt, Status, useData, type Data } from "./lib.tsx";

const labels: Record<string, string> = {
  light: "轻量",
  standard: "常规",
  deep: "深入",
};
export function Selection({ choice }: { choice: Data }) {
  return (
    <>
      {labels[choice.workload]} · {choice.model || "Codex 默认模型"}{" "}
      {choice.effort}
      {choice.fallback && choice.model ? "（沿用默认设置）" : ""}
    </>
  );
}
function Catalog() {
  const { data, error } = useData<Data>("/models");
  if (!data) return <Status error={error} />;
  return (
    <>
      {data.models.length ? (
        <>
          <dl>
            {Object.entries(labels).map(([tier, label]) => {
              const { model, effort } = data.choices[tier];
              return (
                <React.Fragment key={tier}>
                  <dt>{label}</dt>
                  <dd>
                    {model} {effort}
                  </dd>
                </React.Fragment>
              );
            })}
          </dl>
          <details>
            <summary>可用文本模型（{data.models.length}）</summary>
            <ul>
              {data.models.map((m: Data) => (
                <li key={m.id}>
                  {m.id} · {m.efforts.join(" / ") || "默认推理强度"}
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : (
        <p>暂未取得模型目录，执行时沿用 Codex 默认设置。</p>
      )}
      <h3>最近调用</h3>
      {data.recent.length === 0 && <p>还没有模型调用记录。</p>}
      {data.recent.map((r: Data, i: number) => (
        <div className="listrow" key={i}>
          <div className="grow">
            <strong>{r.kind}</strong>
            <div>
              <Selection choice={r} />
            </div>
            <small>
              {dt(r.started)} ·{" "}
              {r.finished
                ? (
                    (Date.parse(r.finished) - Date.parse(r.started)) /
                    1000
                  ).toFixed(1) + " 秒"
                : "耗时待确认"}{" "}
              ·{" "}
              {r.total == null
                ? "用量未报告"
                : r.total.toLocaleString() + " tokens"}
            </small>
          </div>
          <Badge value={r.outcome} />
        </div>
      ))}
    </>
  );
}
export function ModelRouting() {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>自动选模与用量记录</summary>
      {open && <Catalog />}
    </details>
  );
}
