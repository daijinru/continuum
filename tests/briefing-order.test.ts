import assert from "node:assert/strict";
import test from "node:test";
import { arrangeBriefing } from "../apps/web/src/briefing-order.ts";

test("简报跨类别按时间展示结果，风险单列，后续报告优先于过程说明", () => {
  const row = (
    category: string,
    title: string,
    last_seq: number,
    run_id: string,
  ) => ({
    id: String(last_seq),
    category,
    title,
    last_seq,
    run_id,
    updated: "2026-11-24",
  });
  const report = row("insight", "本次日榜有 16 个仓库", 5, "report");
  const file = row("outcome", "文件变更 · /project/page.js", 3, "dev");
  const risk = row("risk", "测试未通过", 1, "dev");
  const approval = row("change", "已批准本次操作", 6, "dev");
  const plan = row("insight", "我会查看今日榜单", 4, "report");
  const result = arrangeBriefing({
    changes: [risk, approval],
    outcomes: [file],
    insights: [plan, report],
  });
  assert.deepEqual(result.highlights, [report, file]);
  assert.deepEqual(result.risks, [risk]);
  assert.deepEqual(result.process, [approval, plan]);
});
