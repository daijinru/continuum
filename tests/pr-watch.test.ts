import test from "node:test";
import assert from "node:assert/strict";
import { watchPr } from "../scripts/pr-watch.ts";

type PR = ReturnType<Parameters<typeof watchPr>[0]>;
const initial: PR = {
  number: 42,
  url: "https://github.com/daijinru/continuum/pull/42",
  state: "OPEN",
  baseRefName: "main",
  headRefOid: "a".repeat(40),
  headRefName: "work",
  isCrossRepository: false,
  isDraft: false,
  autoMergeRequest: {},
  mergeCommit: null,
  mergeStateStatus: "BLOCKED",
  reviewDecision: "",
  statusCheckRollup: [],
};
const passed = { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" };
function sequence(...rows: (Partial<PR> | Error)[]) {
  let time = 0;
  return watchPr(
    () => {
      const row = rows.shift();
      if (!row) throw Error("unexpected extra read");
      if (row instanceof Error) throw row;
      return { ...initial, ...row };
    },
    () => {},
    async (ms) => {
      time += ms;
    },
    () => time,
  );
}

test("检查登记前、检查变绿、换 HEAD 和短暂读失败都不算合入", async () => {
  const headRefOid = "b".repeat(40);
  const receipt = await sequence(
    {},
    new Error("network"),
    { mergeStateStatus: "CLEAN", statusCheckRollup: [passed] },
    { headRefOid },
    { headRefOid, statusCheckRollup: [passed] },
    {
      headRefOid,
      state: "MERGED",
      autoMergeRequest: null,
      mergeCommit: { oid: "d".repeat(40) },
    },
  );
  assert.equal(receipt.outcome, "merged");
  assert.equal(receipt.headRefOid, headRefOid);
  assert.equal(receipt.mergeCommit?.oid, "d".repeat(40));
});

test("可处理与终止状态不会假报成功，即使已有绿灯", async () => {
  const cases: [Partial<PR>, string][] = [
    [{ mergeStateStatus: "BEHIND" }, "behind"],
    [{ mergeStateStatus: "DIRTY" }, "conflicts"],
    [{ state: "CLOSED" }, "closed"],
    [{ autoMergeRequest: null }, "auto_merge_off"],
    [{ reviewDecision: "REVIEW_REQUIRED" }, "review"],
    [{ isDraft: true }, "draft"],
    [
      {
        state: "MERGED",
        baseRefName: "elsewhere",
        mergeCommit: { oid: "d".repeat(40) },
      },
      "wrong_target",
    ],
    [
      {
        statusCheckRollup: [
          { context: "ci", state: "ERROR", targetUrl: "log" },
        ],
      },
      "checks_failed",
    ],
  ];
  for (const [pr, outcome] of cases)
    assert.equal(
      (await sequence({ statusCheckRollup: [passed], ...pr })).outcome,
      outcome,
    );
  await assert.rejects(
    sequence(new Error("offline"), new Error("offline"), new Error("offline")),
    /offline/,
  );
  let time = 0;
  const stalled = await watchPr(
    () => initial,
    () => {},
    async (ms) => {
      time += ms;
    },
    () => time,
  );
  assert.equal(stalled.outcome, "stalled");
});
