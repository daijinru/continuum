import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync, lstatSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { Rpc, type Packet } from "./rpc.ts";
import {
  redact,
  type AgentAdapter,
  type Context,
  type RunStatus,
} from "../../agent-core/src/index.ts";
import type { ThreadItem } from "../generated/v2/ThreadItem.ts";
import type { ToolRequestUserInputParams } from "../generated/v2/ToolRequestUserInputParams.ts";
import type { ToolRequestUserInputResponse } from "../generated/v2/ToolRequestUserInputResponse.ts";
import type { ThreadReadResponse } from "../generated/v2/ThreadReadResponse.ts";
import type { TurnCompletedNotification } from "../generated/v2/TurnCompletedNotification.ts";
import type { CommandExecutionRequestApprovalResponse } from "../generated/v2/CommandExecutionRequestApprovalResponse.ts";
const exec = promisify(execFile);
export async function checkCodex() {
  let version = "";
  try {
    version = (
      await exec("codex", ["--version"], { timeout: 5000 })
    ).stdout.trim();
    const login = await exec("codex", ["login", "status"], { timeout: 5000 });
    if (!/logged in/i.test(login.stdout + login.stderr))
      throw Error("未检测到登录");
    const rpc = new Rpc(
      () => {},
      () => {},
    );
    try {
      await rpc.init();
      const account = await rpc.call("account/read", { refreshToken: false });
      if (!account.account) throw Error("App Server 未报告有效账号");
    } finally {
      rpc.close();
    }
    return {
      installed: true,
      ready: true,
      version,
      detail: "登录与协议握手均已验证",
    };
  } catch (e) {
    return {
      installed: !!version,
      ready: false,
      version,
      detail: version
        ? redact((e as Error).message).slice(0, 300)
        : "未找到可运行的 Codex CLI",
    };
  }
}
type Session = {
  rpc: Rpc;
  c: Context;
  thread?: string;
  turn?: string;
  ended: boolean;
  items: Map<string, ThreadItem>;
  requests: Map<
    string,
    { id: string | number; canApprove: boolean; questions?: string[] }
  >;
};
function inside(root: string, path: string) {
  try {
    const rel = relative(root, realpathSync(resolve(root, path)));
    return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
  } catch {
    return false;
  }
}
function permittedFile(root: string, path: string) {
  if (!path || path.split("/").includes("..")) return false;
  let target = resolve(root, path);
  if (!relative(root, target) || relative(root, target).startsWith(".."))
    return false;
  while (target !== root) {
    try {
      lstatSync(target);
      return inside(root, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    target = dirname(target);
  }
  return true;
}
export class CodexAdapter implements AgentAdapter {
  sessions = new Map<string, Session>();
  processRoots() {
    const roots = new Map<number, string>();
    for (const [run, { rpc }] of this.sessions) {
      if (!rpc.closed && rpc.proc.pid) roots.set(rpc.proc.pid, run);
    }
    return roots;
  }
  async start(c: Context) {
    const rpc = new Rpc(
      (p) => this.packet(s, p),
      () => {
        if (!s.ended)
          c.emit({
            key: "disconnect",
            type: "system.disconnected",
            title: "Codex 连接中断，等待核对运行状态",
          });
        this.sessions.delete(c.id);
      },
      c.workspace,
    );
    const s: Session = {
      rpc,
      c,
      ended: false,
      items: new Map(),
      requests: new Map(),
    };
    this.sessions.set(c.id, s);
    try {
      await rpc.init();
      const account = await rpc.call("account/read", { refreshToken: false });
      if (!account.account) throw Error("请先完成本机 Codex 登录");
      const policy = {
        cwd: c.workspace,
        sandbox: "workspace-write" as const,
        approvalPolicy: c.managedCommission ? ("never" as const) : ("untrusted" as const),
        approvalsReviewer: "user" as const,
      };
      const result = c.thread
        ? await rpc.call("thread/resume", { ...policy, threadId: c.thread })
        : await rpc.call("thread/start", policy);
      s.thread = result.thread.id;
      c.reference(result.thread.id);
      const started = await rpc.call("turn/start", {
        threadId: result.thread.id,
        input: [{ type: "text", text: c.managedCommission
          ? c.instruction + "\n\n在委托目录内自行完成日常步骤，不请求提权，不绕过沙箱。若资料不可得，直接说明未完成的部分和需要用户提供的资料，不要让用户确认命令。仅当用户需要决定业务取舍时提出具体问题。"
          : c.instruction, text_elements: [] }],
        approvalPolicy: policy.approvalPolicy,
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [c.workspace],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      });
      if (!s.ended) {
        s.turn = started.turn.id;
        c.reference(result.thread.id, started.turn.id);
        c.emit({
          key: "start",
          type: "run.started",
          title: "Codex 开始执行",
          method: "turn/start",
        });
      }
    } catch (e) {
      if (!s.thread) s.ended = true;
      rpc.close();
      throw e;
    }
  }
  private packet(s: Session, p: Packet) {
    const a = p.params || {},
      method = p.method!,
      c = s.c;
    if (s.ended) return;
    const request = p.id !== undefined;
    if (
      !s.thread ||
      a.threadId !== s.thread ||
      (s.turn && a.turnId && a.turnId !== s.turn)
    ) {
      if (request)
        void s.rpc
          .send({
            id: p.id,
            error: {
              message: "Request is outside the active turn",
              code: -32602,
            },
          })
          .catch(() => s.rpc.close());
      return;
    }
    if (request) {
      if (method === "item/tool/requestUserInput") {
        const input = a as ToolRequestUserInputParams;
        const questions = input.questions.map((q) => ({
          id: q.id,
          question: q.question,
          options: q.options,
          other: q.isOther,
        }));
        const action = JSON.stringify(questions),
          key = JSON.stringify(p.id);
        if (
          questions.length &&
          action === redact(action) &&
          !input.questions.some((q) => q.isSecret)
        ) {
          s.requests.set(key, {
            id: p.id!,
            canApprove: false,
            questions: questions.map((q) => q.id),
          });
          c.emit({
            key: "input:" + key,
            type: "input.requested",
            title: input.questions[0].header || "Codex 需要补充信息",
            method,
            approval: {
              id: key,
              kind: "input",
              blocking: input.isBlocking,
              action,
              reason: input.questions[0].question,
              scope: c.workspace,
              risk: "需补充信息",
            },
          });
        } else
          void s.rpc
            .send({
              id: p.id,
              error: {
                code: -32602,
                message: "Sensitive or unsupported input request",
              },
            })
            .catch(() => s.rpc.close());
      } else if (
        method === "item/commandExecution/requestApproval" ||
        method === "item/fileChange/requestApproval"
      ) {
        // Fail closed even if an app-server version unexpectedly asks for an
        // exception under "never". Do not mint a user decision or mark approval.
        if (c.managedCommission) {
          void s.rpc.send({id:p.id,result:{decision:"decline"}}).catch(()=>s.rpc.close());
          c.emit({key:"boundary:"+JSON.stringify(p.id), type:"tool.permission_denied",
            title:"操作需要额外权限，已按委托边界拒绝",method});
          return;
        }
        const key = JSON.stringify(p.id),
          item = s.items.get(a.itemId);
        const command = method.includes("commandExecution");
        const action = command
          ? JSON.stringify({
              command: a.command,
              cwd: a.cwd,
              kind: a.kind,
              environmentId: a.environmentId,
              network: a.networkApprovalContext,
              additionalPermissions: a.additionalPermissions,
            })
          : JSON.stringify({
              changes: item?.type === "fileChange" ? item.changes : [],
              grantRoot: a.grantRoot,
            });
        const canApprove =
          action === redact(action) &&
          (command
            ? !!a.command &&
              inside(c.workspace, a.cwd || c.workspace) &&
              (!a.kind || a.kind === "command")
            : item?.type === "fileChange" &&
              !a.grantRoot &&
              item.changes.length > 0 &&
              item.changes.every(
                (ch) =>
                  permittedFile(c.workspace, ch.path) &&
                  (ch.kind.type !== "update" ||
                    !ch.kind.move_path ||
                    permittedFile(c.workspace, ch.kind.move_path)),
              ));
        s.requests.set(key, { id: p.id!, canApprove: !!canApprove });
        c.emit({
          key: "request:" + key,
          type: "approval.requested",
          title: command ? "Codex 请求执行命令" : "Codex 请求修改文件",
          method,
          unit: "approval:" + key,
          approval: {
            id: key,
            action: redact(action),
            reason: redact(a.reason || "此操作需要本次授权"),
            scope: c.workspace,
            risk: canApprove ? "需审查" : "范围无法完整核验，仅可拒绝",
          },
        });
      } else
        void s.rpc
          .send({
            id: p.id,
            error: { code: -32601, message: "Unsupported capability" },
          })
          .catch(() => s.rpc.close());
      return;
    }
    if (method === "serverRequest/resolved") {
      const key = JSON.stringify(a.requestId);
      s.requests.delete(key);
      c.emit({
        key: "closed:" + key,
        type: "provider.request_closed",
        title: "提供方已关闭请求",
        method,
        data: { request: key },
      });
      return;
    }
    if (method === "thread/status/changed") {
      c.emit({
        key: "status:" + crypto.randomUUID(),
        type: "run.status_changed",
        title: "线程状态更新",
        method,
        data: { status: a.status?.type },
      });
      return;
    }
    if (method === "turn/started") {
      s.turn = a.turn.id;
      c.reference(s.thread, a.turn.id);
      c.emit({
        key: "start",
        type: "run.started",
        title: "Codex 开始执行",
        method,
      });
      return;
    }
    if (method === "turn/completed") {
      const { turn } = a as TurnCompletedNotification;
      if (s.turn && s.turn !== turn.id) return;
      c.reference(s.thread, turn.id);
      s.ended = true;
      const type = {
        completed: "run.completed",
        failed: "run.failed",
        interrupted: "run.interrupted",
        inProgress: "system.disconnected",
      }[turn.status];
      c.emit({
        key: "end:" + turn.id,
        type,
        title: redact(
          turn.error?.message ||
            {
              completed: "本轮执行完成",
              failed: "执行失败",
              interrupted: "执行已中断",
              inProgress: "完成状态待核对",
            }[turn.status],
        ),
        method,
        data: { status: turn.status },
      });
      s.rpc.close();
      return;
    }
    if (method === "turn/plan/updated") {
      c.emit({
        key: "plan:" + JSON.stringify(a.plan),
        unit: "plan:" + a.turnId,
        type: "plan.updated",
        title: "Codex 更新了工作计划",
        method,
      });
      return;
    }
    if (!["item/started", "item/completed"].includes(method)) return;
    const item = a.item as ThreadItem;
    if (!item) return;
    if (item.type === "fileChange" && method === "item/started")
      s.items.set(item.id, item);
    else if (method === "item/completed") s.items.delete(item.id);
    const key = method + ":" + item.id;
    if (method === "item/started") {
      if (item.type === "commandExecution")
        c.emit({
          key,
          type: "tool.started",
          title: "开始执行命令",
          method,
          data: { command: redact(item.command) },
        });
      return;
    }
    if (item.type === "agentMessage")
      c.emit({
        key,
        type: "agent.message",
        title: redact(item.text) || "Codex 消息",
        method,
      });
    if (item.type === "commandExecution") {
      const suite =
        /^(?:npm test|pnpm test|cargo test|pytest|python3? -m pytest|go test \.\/\.\.\.)$/.test(
          item.command.trim(),
        ) && typeof item.exitCode === "number";
      const passed = item.exitCode === 0;
      c.emit({
        key,
        type: suite ? "test.completed" : "tool.completed",
        unit: suite ? "suite:" + item.cwd + ":" + item.command : undefined,
        title: suite
          ? item.command + (passed ? " 通过" : " 失败")
          : "命令执行结束",
        method,
        data: {
          command: redact(item.command),
          exitCode: item.exitCode,
          status: item.status,
          ...(suite ? { passed } : {}),
        },
      });
    }
    if (item.type === "fileChange")
      for (const change of item.changes)
        c.emit({
          key: key + ":" + change.path,
          type: "file.changed",
          title: "文件变更 · " + change.path,
          unit: "file:" + change.path,
          path: item.status === "completed" ? change.path : undefined,
          method,
          data: { status: item.status },
        });
  }
  async respond(id: string, request: string, decision: "approve" | "deny") {
    const s = this.sessions.get(id),
      entry = s?.requests.get(request);
    if (!s || s.rpc.closed || !entry) throw Error("请求已过期");
    if (decision === "approve" && !entry.canApprove)
      throw Error("操作范围无法完整核验");
    s.requests.delete(request);
    const result: CommandExecutionRequestApprovalResponse = {
      decision: decision === "approve" ? "accept" : "decline",
    };
    await s.rpc.send({ id: entry.id, result });
  }
  async answer(id: string, request: string, answers: Record<string, string>) {
    const s = this.sessions.get(id),
      entry = s?.requests.get(request);
    if (!s || !entry?.questions || s.rpc.closed) throw Error("输入请求已失效");
    const result: ToolRequestUserInputResponse = {
      answers: Object.fromEntries(
        entry.questions.map((k) => [k, { answers: [answers[k]] }]),
      ),
    };
    s.requests.delete(request);
    await s.rpc.send({ id: entry.id, result });
  }
  async interrupt(id: string) {
    const s = this.sessions.get(id);
    if (!s?.thread || !s.turn) throw Error("当前无法中断");
    await s.rpc.call("turn/interrupt", { threadId: s.thread, turnId: s.turn });
  }
  async reconcile(c: Context): Promise<RunStatus> {
    if (!c.thread || !c.turn) return "unknown";
    const rpc = new Rpc(
      () => {},
      () => {},
    );
    try {
      await rpc.init();
      const result: ThreadReadResponse = await rpc.call("thread/read", {
        threadId: c.thread,
        includeTurns: true,
      });
      const turn = result.thread.turns.find((t) => t.id === c.turn);
      if (turn && turn.status !== "inProgress") {
        const recovered: Session = {
          rpc,
          c,
          thread: c.thread,
          turn: c.turn,
          ended: false,
          items: new Map(),
          requests: new Map(),
        };
        for (const item of turn.items)
          this.packet(recovered, {
            method: "item/completed",
            params: { threadId: c.thread, turnId: c.turn, item },
          });
      }
      if (turn?.status === "completed") return "succeeded";
      if (turn?.status === "failed" || turn?.status === "interrupted")
        return turn.status;
      return "unknown";
    } finally {
      rpc.close();
    }
  }
  close() {
    for (const s of this.sessions.values()) {
      s.ended = true;
      s.rpc.close();
    }
    this.sessions.clear();
  }
}
