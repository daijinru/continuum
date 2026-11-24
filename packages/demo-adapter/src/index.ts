import type {
  AgentAdapter,
  Context,
  Observation,
  RunStatus,
} from "../../agent-core/src/index.ts";
export const fixture: Observation[] = [
  {
    key: "map",
    type: "test.completed",
    unit: "map",
    title: "地图渲染通过验证",
    data: { suite: "map-renderer", passed: true, checks: 3, simulated: true },
  },
  {
    key: "path-fail",
    type: "test.completed",
    unit: "path",
    title: "寻路在障碍边界处失败",
    data: { suite: "pathfinding", passed: false, checks: 1, simulated: true },
  },
  {
    key: "retry",
    type: "plan.updated",
    unit: "path",
    title: "已定位边界条件，等待回归测试",
    data: { step: "修复寻路边界" },
  },
  {
    key: "request",
    type: "approval.requested",
    unit: "preview",
    title: "发布战棋原型到演示预览区",
    approval: {
      id: "demo:preview",
      action: 'demo.preview.publish({ target: "local-preview" })',
      reason: "地图已通过检查，预览发布需要你的确认。",
      scope: "本机演示预览区 · 不执行系统命令",
      risk: "低",
    },
  },
];
export class DemoAdapter implements AgentAdapter {
  sessions = new Map<string, Context>();
  timers = new Map<string, ReturnType<typeof setTimeout>[]>();
  delay: number;
  constructor(delay = 400) {
    this.delay = delay;
  }
  async start(c: Context) {
    this.sessions.set(c.id, c);
    c.reference(c.thread || "demo-thread-" + c.id, "demo-turn-" + c.id);
    c.emit({ key: "start", type: "run.started", title: "演示任务已启动" });
    this.timers.set(
      c.id,
      fixture.map((e, i) => setTimeout(() => c.emit(e), this.delay * (i + 1))),
    );
  }
  async respond(id: string, req: string, decision: "approve" | "deny") {
    if (req !== "demo:preview" || !this.sessions.has(id))
      throw Error("演示请求已失效");
    const c = this.sessions.get(id)!;
    this.timers.set(id, [
      setTimeout(() => {
        if (decision === "approve")
          c.emit({
            key: "pass",
            type: "test.completed",
            unit: "path",
            title: "寻路修复通过回归测试",
            data: {
              suite: "pathfinding",
              passed: true,
              checks: 6,
              simulated: true,
            },
          });
        c.emit({
          key: "end",
          type: decision === "approve" ? "run.completed" : "run.interrupted",
          title:
            decision === "approve"
              ? "演示任务已完成"
              : "审批已拒绝，演示任务已停止",
        });
        this.sessions.delete(id);
      }, this.delay),
    ]);
  }
  async interrupt(id: string) {
    this.timers.get(id)?.forEach(clearTimeout);
    this.sessions
      .get(id)
      ?.emit({ key: "stop", type: "run.interrupted", title: "演示运行已中断" });
    this.sessions.delete(id);
  }
  async reconcile(c: Context): Promise<RunStatus> {
    this.sessions.set(c.id, c);
    return "unknown";
  }
  close() {
    for (const timers of this.timers.values()) timers.forEach(clearTimeout);
    this.sessions.clear();
  }
}
