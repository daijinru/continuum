import assert from "node:assert/strict";
import test from "node:test";
import { selectModel } from "../packages/codex-adapter/src/models.ts";

test("目录减少到一个新模型时只使用它声明的推理强度，空目录交给 Codex", () => {
  const model = {
    model: "replacement",
    description: "General purpose",
    displayName: "Replacement",
    isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "standard" },
    ],
    defaultReasoningEffort: "medium",
  };
  for (const tier of ["deep", "light", "standard"] as const) {
    assert.deepEqual(selectModel([model], tier), {
      model: "replacement",
      effort: "medium",
    });
    assert.deepEqual(selectModel([], tier), {});
  }
  assert.equal(
    selectModel([{ ...model, supportedReasoningEfforts: [] }], "deep").effort,
    undefined,
  );
});
