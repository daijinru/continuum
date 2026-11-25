// Standalone: the per-clone LaunchAgent uses an installed copy so switching
// branches cannot replace the scheduled program or remove its dependencies.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = "daijinru/continuum";
const self = fileURLToPath(import.meta.url);
const call = (cmd, args) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 45000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
  }).trimEnd();
const git = (...args) => call("git", args);
const gh = (...args) => JSON.parse(call("gh", args));
const verifyOrigin = () => {
  if (
    !/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)daijinru\/continuum(?:\.git)?\/?$/.test(
      git("remote", "get-url", "origin"),
    )
  )
    throw Error(`仅支持 ${repo} 的检出`);
};
const protectedNames = new Set(["main", "master"]);
function refs(g) {
  return g(
    "for-each-ref",
    "--format=%(refname:short)%09%(objectname)%09%(worktreepath)",
    "refs/heads",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, sha, worktree] = line.split("\t");
      return { name, sha, worktree };
    });
}
export function cleanLocal(g, mergedPRs, base, dryRun) {
  const deleted = [],
    eligible = [],
    kept = [];
  const remoteTips = new Map(
    g("ls-remote", "--heads", "origin")
      .split("\n")
      .map((line) => {
        const [sha, ref] = line.split("\t");
        return [ref, sha];
      }),
  );
  for (const { name, sha, worktree } of refs(g)) {
    if (name === base || protectedNames.has(name)) continue;
    if (worktree) {
      kept.push({ name, reason: "worktree 占用" });
      continue;
    }
    if (remoteTips.has(`refs/heads/${name}`)) {
      kept.push({ name, reason: "远端同名分支仍存在" });
      continue;
    }
    try {
      g("merge-base", "--is-ancestor", sha, `refs/remotes/origin/${base}`);
    } catch {
      kept.push({ name, reason: "本地尖端未并入默认分支" });
      continue;
    }
    const match = mergedPRs(name).some(
      (pr) =>
        !pr.isCrossRepository &&
        pr.baseRefName === base &&
        pr.headRefName === name &&
        pr.headRefOid === sha &&
        pr.state === "MERGED",
    );
    if (!match) {
      kept.push({ name, reason: "没有匹配此尖端的同仓合并记录" });
      continue;
    }
    if (dryRun) {
      eligible.push(name);
      continue;
    }
    // Native -d checks all worktrees and refuses unmerged work. Never force,
    // switch someone else's checkout, or remove the worktree directory.
    if (g("rev-parse", `refs/heads/${name}`) !== sha) {
      kept.push({ name, reason: "核对后分支已移动" });
      continue;
    }
    try {
      g("branch", "-d", "--", name);
      deleted.push(name);
    } catch {
      kept.push({ name, reason: "Git 保留分支：请在已同步的默认分支上重试" });
    }
  }
  return { base, dryRun, eligible, deleted, kept };
}
function cleanup(dryRun) {
  verifyOrigin();
  // Nothing deletable in an ordinary checkout of just the default branch.
  if (!refs(git).some((b) => !protectedNames.has(b.name) && !b.worktree))
    return { dryRun, deleted: [], note: "没有闲置工作分支" };
  git("fetch", "--prune", "origin");
  const base = gh("repo", "view", repo, "--json", "defaultBranchRef")
    .defaultBranchRef.name;
  return cleanLocal(
    git,
    (name) =>
      gh(
        "pr",
        "list",
        "-R",
        repo,
        "--base",
        base,
        "--head",
        name,
        "--state",
        "merged",
        "--limit",
        "100",
        "--json",
        "state,isCrossRepository,baseRefName,headRefName,headRefOid",
      ),
    base,
    dryRun,
  );
}
function agent(mode) {
  if (process.platform !== "darwin")
    throw Error(
      "自动清理使用 macOS launchd；其他系统可定期运行 branch cleanup。",
    );
  verifyOrigin();
  const common = realpathSync(
    git("rev-parse", "--path-format=absolute", "--git-common-dir"),
  );
  const label =
    "local.continuum.branch-cleanup." +
    createHash("sha256").update(common).digest("hex").slice(0, 12);
  const domain = `gui/${process.getuid()}`,
    service = `${domain}/${label}`;
  const file = join(homedir(), "Library/LaunchAgents", label + ".plist");
  let loaded = true;
  try {
    call("launchctl", ["print", service]);
  } catch {
    loaded = false;
  }
  if (mode === "status") return { installed: existsSync(file), loaded, label };
  if (loaded) call("launchctl", ["bootout", service]);
  if (mode === "off") {
    rmSync(file, { force: true });
    return { enabled: false, label };
  }
  const dir = join(common, "continuum-harness"),
    script = join(dir, "merged-branches.mjs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  copyFileSync(self, script);
  const root = git("worktree", "list", "--porcelain", "-z")
    .split("\0")[0]
    .replace(/^worktree /, "");
  const path = [
    ...new Set([
      dirname(process.execPath),
      dirname(call("which", ["gh"])),
      dirname(call("which", ["git"])),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]),
  ].join(":");
  const xml = (s) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>WorkingDirectory</key><string>${xml(root)}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(script)}</string><string>cleanup</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
<key>StartInterval</key><integer>300</integer><key>RunAtLoad</key><true/>
</dict></plist>`,
    { mode: 0o600 },
  );
  call("launchctl", ["bootstrap", domain, file]);
  return { enabled: true, label, intervalSeconds: 300 };
}
if (process.argv[1] && resolve(process.argv[1]) === self) {
  try {
    const [op, arg, ...rest] = process.argv.slice(2);
    if (
      rest.length ||
      !(
        (op === "cleanup" && (!arg || arg === "--dry-run")) ||
        (op === "auto" && ["on", "off", "status"].includes(arg))
      )
    )
      throw Error(
        `用法：${basename(self)} cleanup [--dry-run] | auto on|off|status`,
      );
    console.log(
      JSON.stringify(
        op === "cleanup" ? cleanup(arg === "--dry-run") : agent(arg),
        null,
        2,
      ),
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
