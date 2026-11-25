import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { watchFields, watchPr } from "./pr-watch.ts";

const repo = "daijinru/continuum";
const help = `Continuum 维护工具 · pnpm harness <操作>
  status                               分支、改动和暂存范围
  issue list [open|closed|all]         最近更新的 Issue（最多 50 条）
  issue show N                         正文、评论及本地关联提交
  issue create "标题"                  从标准输入读取正文
  issue comment N                      从标准输入读取评论
  issue close N | issue reopen N       更新 Issue 状态
  commit log [--issue N]               当前分支最近 30 条匹配提交
  commit show HEAD|SHA                 单次提交及文件统计
  commit create [--issue N] "说明" -- 路径...
                                       仅提交已经审阅过的暂存区
  commit push                          推送当前工作分支，返回提交 PR 的下一条命令
  pr submit [--issue N]                开/复用 PR，申请自动合并并监听至合入或需处理
  pr watch N                           按 PR 编号接续监听；仅确认已合入 main 时成功
  branch cleanup [--dry-run]           核对并清理已合并且不再使用的本地分支
  branch auto on|off|status            安装、停用或查看本检出的 macOS 自动清理
返回 JSON；错误写 stderr，退出码非零。路径相对仓库根目录。`;

function run(tool: string, args: string[], cwd: string, input?: string) {
  const p = spawnSync(tool, args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  if (p.error || p.status !== 0)
    throw Error(
      `${tool}：${(p.stderr || p.error?.message || `退出码 ${p.status}`).trim()}${tool === "gh" ? "\n请核对 `gh auth status` 及仓库写权限。" : ""}`,
    );
  return p.stdout;
}
function number(s?: string) {
  if (!s || !/^[1-9]\d{0,9}$/.test(s)) throw Error("需要正整数 Issue 编号");
  return s;
}
function requireArgs(ok: unknown): asserts ok {
  if (!ok) throw Error(`参数有误。\n${help}`);
}
function input() {
  if (process.stdin.isTTY)
    throw Error("请将 Markdown 正文通过管道或 < 文件传入。");
  const text = readFileSync(0, "utf8").trim();
  if (!text || text.length > 65536)
    throw Error("正文不能为空且不得超过 65536 字符");
  return text;
}
function checkRemote(urls: string) {
  if (
    !urls.trim() ||
    urls
      .trim()
      .split(/\r?\n/)
      .some(
        (url) =>
          !/^((https:\/\/github\.com\/)|(git@github\.com:)|(ssh:\/\/git@github\.com\/))daijinru\/continuum(?:\.git)?\/?$/.test(
            url,
          ),
      )
  )
    throw Error(`仅支持 origin 指向 ${repo} 的检出。`);
}
const base = `https://api.github.com/repos/${repo}`;
async function get(path: string) {
  const r = await fetch(base + path, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "continuum-repo-harness",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 403 || r.status === 429) {
    try {
      return JSON.parse(
        run(
          "gh",
          ["api", "--hostname", "github.com", `repos/${repo}${path}`],
          process.cwd(),
        ),
      );
    } catch {
      throw Error(
        `GitHub 公开读取受到限制（HTTP ${r.status}），登录态读取也未成功。请运行 gh auth login -h github.com 后重试。`,
      );
    }
  }
  if (!r.ok) throw Error(`GitHub 读取失败：HTTP ${r.status} ${r.statusText}`);
  return r.json();
}
async function issue(n: string) {
  const i = await get("/issues/" + n);
  if (i.pull_request) throw Error(`#${n} 是 PR，不是 Issue。`);
  return i;
}
async function main(args: string[]) {
  if (!args.length || ["--help", "help", "-h"].includes(args[0]))
    return console.log(help);
  const root = run(
    "git",
    ["rev-parse", "--show-toplevel"],
    process.cwd(),
  ).trim();
  const git = (...a: string[]) => run("git", a, root);
  checkRemote(git("remote", "get-url", "--all", "origin"));
  const [area, op, ...rest] = args;
  if (area === "branch") {
    requireArgs(op === "cleanup" || op === "auto");
    return JSON.parse(
      run(
        process.execPath,
        [resolve(root, "scripts/merged-branches.mjs"), op, ...rest],
        root,
      ),
    );
  }
  const staged = () =>
    git("diff", "--cached", "--no-renames", "--name-only", "-z")
      .split("\0")
      .filter(Boolean);
  const branch = () => git("branch", "--show-current").trim();
  const log = (n?: string) =>
    git(
      "log",
      "-30",
      ...(n ? [`--grep=^Refs: #${number(n)}$`] : []),
      "--format=%H%x09%s",
    )
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map((line) => ({ sha: line.slice(0, 40), subject: line.slice(41) }));
  if (area === "status" && !op)
    return {
      repo,
      branch: branch(),
      staged: staged(),
      changes: git("status", "--short", "--untracked-files=all")
        .trimEnd()
        .split("\n")
        .filter(Boolean),
    };
  if (area === "issue") {
    if (op === "list") {
      const state = rest[0] || "open";
      requireArgs(
        rest.length <= 1 && ["open", "closed", "all"].includes(state),
      );
      const result = [];
      for (let page = 1; result.length < 50; page++) {
        const rows = await get(
          `/issues?state=${state}&sort=updated&per_page=50&page=${page}`,
        );
        for (const i of rows)
          if (!i.pull_request)
            result.push({
              number: i.number,
              title: i.title,
              state: i.state,
              url: i.html_url,
            });
        if (rows.length < 50) break;
      }
      return result.slice(0, 50);
    }
    requireArgs(rest.length === 1);
    const write = (method: string, path: string, body: object) =>
      JSON.parse(
        run(
          "gh",
          [
            "api",
            "--hostname",
            "github.com",
            "--method",
            method,
            `repos/${repo}${path}`,
            "--input",
            "-",
          ],
          root,
          JSON.stringify(body),
        ),
      );
    if (op === "create") {
      requireArgs(rest[0].trim() && rest[0].length <= 256);
      const i = write("POST", "/issues", { title: rest[0], body: input() });
      return { number: i.number, url: i.html_url, state: i.state };
    }
    requireArgs(["show", "comment", "close", "reopen"].includes(op));
    const n = number(rest[0]),
      i = await issue(n);
    if (op === "show") {
      const comments = i.comments
        ? await get(`/issues/${n}/comments?per_page=100`)
        : [];
      return {
        number: i.number,
        title: i.title,
        state: i.state,
        body: i.body,
        url: i.html_url,
        comments: comments.map((c: any) => ({
          author: c.user?.login,
          body: c.body,
          url: c.html_url,
        })),
        totalComments: i.comments,
        commits: log(n),
      };
    }
    if (op === "comment") {
      const c = write("POST", `/issues/${n}/comments`, { body: input() });
      return { number: i.number, url: c.html_url };
    }
    const state = op === "close" ? "closed" : "open";
    const updated =
      i.state === state ? i : write("PATCH", `/issues/${n}`, { state });
    return { number: i.number, state: updated.state, url: updated.html_url };
  }
  if (area === "pr") {
    const gh = (...args: string[]) => run("gh", args, root).trim();
    const view = (ref: string) =>
      JSON.parse(gh("pr", "view", ref, "-R", repo, "--json", watchFields));
    const watch = async (ref: string) => {
      console.error(
        `监听 ${ref}；中断后可用 pnpm harness pr watch <PR编号> 接续。`,
      );
      const result = await watchPr(
        () => view(ref),
        (message) => console.error(message),
      );
      if (result.outcome !== "merged") process.exitCode = 1;
      return result;
    };
    if (op === "watch") {
      requireArgs(rest.length === 1 && /^[1-9]\d{0,9}$/.test(rest[0]));
      return watch(rest[0]);
    }
    requireArgs(
      op === "submit" &&
        (!rest.length || (rest.length === 2 && rest[0] === "--issue")),
    );
    const n = rest.length ? number(rest[1]) : undefined;
    const b = branch();
    if (!b || ["main", "master"].includes(b))
      throw Error("请在已推送的工作分支上提交 PR。");
    const sha = git("rev-parse", "HEAD").trim();
    if (git("ls-remote", "origin", `refs/heads/${b}`).split("\t")[0] !== sha)
      throw Error("远端分支不是当前 HEAD，请先核对并执行 commit push。");
    const rules = JSON.parse(gh("api", `repos/${repo}/rules/branches/main`));
    if (
      !rules.some(
        (r: any) =>
          r.type === "required_status_checks" &&
          r.parameters?.required_status_checks?.some(
            (c: any) => c.context === "lint" && c.integration_id === 15368,
          ),
      )
    )
      throw Error("main 缺少必需的 GitHub Actions lint 规则，不开启自动合并。");
    if (n) await issue(n);
    const found = JSON.parse(
      gh(
        "pr",
        "list",
        "-R",
        repo,
        "--base",
        "main",
        "--head",
        b,
        "--state",
        "open",
        "--json",
        "url,headRepositoryOwner,autoMergeRequest",
      ),
    ).find(
      (p: any) => p.headRepositoryOwner?.login?.toLowerCase() === "daijinru",
    );
    const url =
      found?.url ||
      gh(
        "pr",
        "create",
        "-R",
        repo,
        "--base",
        "main",
        "--head",
        b,
        "--title",
        git("log", "-1", "--format=%s").trim(),
        "--body",
        n ? `Closes #${n}` : "通过仓库 harness 提交。",
      );
    if (!found?.autoMergeRequest) {
      try {
        gh("pr", "merge", url, "--auto", "--merge", "--match-head-commit", sha);
      } catch (err) {
        // A lost write response (or a concurrent merge) is not a reason to write again.
        const current = view(url);
        if (current.state !== "MERGED" && !current.autoMergeRequest)
          throw Error(
            `${(err as Error).message}\n核对 ${url} 后再决定是否重新提交。`,
          );
      }
    }
    return watch(url);
  }
  requireArgs(area === "commit");
  if (op === "log") {
    requireArgs(!rest.length || (rest.length === 2 && rest[0] === "--issue"));
    return log(rest[1]);
  }
  if (op === "show") {
    requireArgs(rest.length === 1 && /^(HEAD|[0-9a-f]{7,40})$/i.test(rest[0]));
    return {
      sha: git("rev-parse", "--verify", rest[0] + "^{commit}").trim(),
      summary: git(
        "show",
        "--stat",
        "--format=fuller",
        rest[0],
        "--",
      ).trimEnd(),
    };
  }
  if (op === "push") {
    requireArgs(!rest.length);
    const b = branch();
    if (!b || ["main", "master"].includes(b))
      throw Error("请从工作分支发布；此命令不推送默认分支或游离 HEAD。");
    checkRemote(git("remote", "get-url", "--push", "--all", "origin"));
    const sha = git("rev-parse", "HEAD").trim();
    const refs = git(
      "log",
      "-1",
      "--format=%(trailers:key=Refs,valueonly)",
      sha,
    ).trim();
    const issue = /^#([1-9]\d{0,9})$/.exec(refs)?.[1];
    git("push", "origin", `${sha}:refs/heads/${b}`);
    return {
      branch: b,
      sha,
      url: `https://github.com/${repo}/commit/${sha}`,
      next: "pnpm harness pr submit" + (issue ? ` --issue ${issue}` : ""),
    };
  }
  requireArgs(op === "create");
  let n: string | undefined;
  if (rest[0] === "--issue") {
    n = number(rest[1]);
    rest.splice(0, 2);
  }
  const [title, sep, ...files] = rest;
  requireArgs(
    title?.trim() && !/[\r\n]/.test(title) && sep === "--" && files.length,
  );
  if (!branch()) throw Error("不在工作分支上。");
  if (
    [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-apply",
      "rebase-merge",
      "sequencer",
    ].some((name) =>
      existsSync(resolve(root, git("rev-parse", "--git-path", name).trim())),
    )
  )
    throw Error("先处理进行中的 Git 操作。");
  if (git("ls-files", "-u")) throw Error("存在未解决的冲突。");
  const actual = staged().sort();
  if (JSON.stringify(actual) !== JSON.stringify([...new Set(files)].sort()))
    throw Error(
      `声明的文件与暂存区不一致；未提交。暂存区：${JSON.stringify(actual)}`,
    );
  git("diff", "--cached", "--check");
  git("commit", "-m", title, ...(n ? ["-m", `Refs: #${n}`] : []));
  return {
    sha: git("rev-parse", "HEAD").trim(),
    subject: title,
    issue: n ? Number(n) : null,
    files: actual,
    pushed: false,
  };
}
try {
  const result = await main(process.argv.slice(2));
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
