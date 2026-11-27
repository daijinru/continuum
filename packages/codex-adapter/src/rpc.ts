import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { codexEnvironment } from "./cli.ts";
import type { ClientRequest } from "../generated/ClientRequest.ts";
import type { InitializeParams } from "../generated/InitializeParams.ts";
import { redact } from "../../agent-core/src/index.ts";
export type Packet = {
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string; code?: number };
};
export class RpcRejection extends Error {}
export class Rpc {
  proc: ChildProcessWithoutNullStreams;
  pending = new Map<
    number,
    {
      done: (value: any) => void;
      fail: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  sequence = 0;
  closed = false;
  diagnostic = "";
  constructor(
    onPacket: (p: Packet) => void,
    onClose: () => void,
    cwd?: string,
  ) {
    this.proc = spawn("codex", ["app-server", "--stdio"], {
      cwd,
      env: codexEnvironment(),
      stdio: "pipe",
      shell: false,
    });
    const finish = () => {
      if (this.closed) return;
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.fail(Error("Codex 连接已关闭"));
      }
      this.pending.clear();
      onClose();
    };
    this.proc.once("error", finish);
    this.proc.once("exit", finish);
    this.proc.stdin.on("error", () => this.close());
    this.proc.stderr.on("data", (b) => {
      this.diagnostic = redact(String(b)).slice(-800);
    });
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      try {
        if (line.length > 16e6) throw Error();
        const packet: Packet = JSON.parse(line);
        if (packet.method) {
          onPacket(packet);
          return;
        }
        const p =
          typeof packet.id === "number" ? this.pending.get(packet.id) : null;
        if (!p) return;
        this.pending.delete(packet.id as number);
        clearTimeout(p.timer);
        if (packet.error) p.fail(new RpcRejection(redact(packet.error.message)));
        else p.done(packet.result);
      } catch {
        this.close();
      }
    });
  }
  send(packet: Packet) {
    return new Promise<void>((resolve, reject) => {
      if (this.closed) return reject(Error("连接已关闭"));
      this.proc.stdin.write(JSON.stringify(packet) + "\n", (e) =>
        e ? reject(e) : resolve(),
      );
    });
  }
  async call<M extends ClientRequest["method"]>(
    method: M,
    params: Extract<ClientRequest, { method: M }>["params"],
    timeout = 30000,
  ): Promise<any> {
    const id = ++this.sequence;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(Error("Codex 请求超时"));
        if (method !== "model/list") this.close();
      }, timeout);
      this.pending.set(id, { done, fail, timer });
      this.send({ id, method, params }).catch((e) => {
        clearTimeout(timer);
        this.pending.delete(id);
        fail(e);
      });
    });
  }
  async init() {
    const params: InitializeParams = {
      clientInfo: { name: "continuum", title: "Continuum", version: "1.0.0" },
      capabilities: null,
    };
    await this.call("initialize", params);
    await this.send({ method: "initialized" });
  }
  close() {
    if (!this.closed) this.proc.kill("SIGTERM");
  }
}
