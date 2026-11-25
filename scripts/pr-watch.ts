import { setTimeout as delay } from "node:timers/promises";

type Check = {
  name?: string;
  conclusion?: string;
  detailsUrl?: string;
  // Legacy status contexts use a different shape from Actions check runs.
  context?: string;
  state?: string;
  targetUrl?: string;
  status?: string;
};
type Snapshot = {
  number: number;
  url: string;
  state: string;
  baseRefName: string;
  headRefOid: string;
  headRefName: string;
  isCrossRepository: boolean;
  isDraft: boolean;
  autoMergeRequest: object | null;
  mergeCommit: { oid: string } | null;
  mergeStateStatus: string;
  reviewDecision: string;
  statusCheckRollup: Check[];
};

export const watchFields =
  "number,url,state,baseRefName,headRefOid,headRefName,isCrossRepository,isDraft,autoMergeRequest,mergeCommit,mergeStateStatus,reviewDecision,statusCheckRollup";
const bad = new Set([
  "FAILURE",
  "ERROR",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);

function assess(p: Snapshot) {
  if (p.baseRefName !== "main" || p.isCrossRepository)
    return {
      outcome: "wrong_target",
      next: "核对 PR 编号；仅跟进本仓库合入 main 的 PR。",
    };
  if (p.state === "MERGED" && p.mergeCommit?.oid) return { outcome: "merged" };
  if (p.state === "CLOSED")
    return { outcome: "closed", next: "PR 已关闭且未合入，核对关闭原因。" };
  if (p.isDraft)
    return { outcome: "draft", next: "PR 为草稿，确认是否继续交付。" };
  if (p.mergeStateStatus === "DIRTY")
    return {
      outcome: "conflicts",
      next: "在原工作分支合入最新 origin/main，解决冲突、验证并推送。",
    };
  if (p.mergeStateStatus === "BEHIND")
    return {
      outcome: "behind",
      next: "同步原工作分支与最新 origin/main，验证并推送后继续监听。",
    };
  const failures = p.statusCheckRollup
    .filter((c) => bad.has(c.conclusion || c.state || ""))
    .map((c) => ({
      name: c.name ?? c.context,
      result: c.conclusion || c.state,
      url: c.detailsUrl || c.targetUrl,
    }));
  if (failures.length)
    return {
      outcome: "checks_failed",
      failures,
      next: "查看失败作业日志，在原分支修复并验证后推送；若为临时故障，确认原因后仅重跑失败作业。",
    };
  if (["CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(p.reviewDecision))
    return { outcome: "review", next: "处理审阅意见或等待所需批准。" };
  if (p.state === "OPEN" && !p.autoMergeRequest)
    return {
      outcome: "auto_merge_off",
      next: "核对自动合并关闭原因；仍需交付时从原工作分支执行 pr submit --issue N（N 为关联的 Issue 编号）。",
    };
  // Checks can be absent, green before merge, or attached to a new head.
  return { outcome: "waiting" };
}

export async function watchPr(
  read: () => Snapshot,
  report: (message: string) => void,
  wait = (ms: number) => delay(ms),
  now = Date.now,
) {
  let last = "",
    changedAt = now(),
    readErrors = 0;
  for (;;) {
    let pr: Snapshot;
    try {
      pr = read();
      readErrors = 0;
    } catch (err) {
      if (++readErrors >= 3) throw err;
      report(`暂时未能读取 PR，${readErrors * 15} 秒后重试。`);
      await wait(readErrors * 15_000);
      continue;
    }
    const { statusCheckRollup, ...receipt } = pr;
    const result = assess(pr);
    if (result.outcome !== "waiting") return { ...receipt, ...result };
    const checks = statusCheckRollup
      .map(
        (c) => `${c.name ?? c.context}: ${c.conclusion || c.state || c.status}`,
      )
      .join(", ");
    const line = `PR #${pr.number} ${pr.headRefOid.slice(0, 8)} · ${pr.mergeStateStatus} · ${checks || "等待检查登记"} · 等待 GitHub 确认合并`;
    if (line !== last) {
      report(line);
      last = line;
      changedAt = now();
    } else if (now() - changedAt >= 30 * 60_000) {
      return {
        ...receipt,
        outcome: "stalled",
        next: "30 分钟未见进展，核对缺失检查、规则或合并队列后按 PR 编号接续监听。",
      };
    }
    await wait(15_000);
  }
}
