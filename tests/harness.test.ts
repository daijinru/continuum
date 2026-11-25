import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const cli = fileURLToPath(new URL("../scripts/harness.ts", import.meta.url));
function fixture(t: import("node:test").TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "continuum-harness-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    PATH: dir + ":" + process.env.PATH,
  };
  const exec = (tool: string, args: string[], input?: string) =>
    spawnSync(tool, args, { cwd: dir, encoding: "utf8", env, input });
  const git = (...args: string[]) => {
    const r = exec("git", args);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git("init", "-qb", "main");
  git("config", "user.name", "Harness Test");
  git("config", "user.email", "test@example.invalid");
  git("remote", "add", "origin", "https://github.com/daijinru/continuum.git");
  const file = (name: string, body: string) =>
    writeFileSync(join(dir, name), body);
  const harness = (...args: string[]) => exec(process.execPath, [cli, ...args]);
  return { git, file, dir, harness, exec };
}
test("提交严格匹配暂存范围；保留同文件的未暂存修改；按 Issue 回查", (t) => {
  const { git, file, harness } = fixture(t);
  file("a.txt", "staged\n");
  file("b.txt", "other\n");
  git("add", "a.txt", "b.txt");
  const args = [
    "commit",
    "create",
    "--issue",
    "42",
    "fix: preserve partial changes",
    "--",
    "a.txt",
  ];
  assert.notEqual(harness(...args).status, 0);
  assert.deepEqual(git("diff", "--cached", "--name-only").trim().split("\n"), [
    "a.txt",
    "b.txt",
  ]);
  git("rm", "--cached", "b.txt");
  file("a.txt", "staged\nnot staged\n");
  const r = harness(...args);
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.pushed, false);
  assert.equal(git("show", "HEAD:a.txt"), "staged\n");
  assert.match(git("status", "--short"), / M a.txt/);
  assert.equal(
    JSON.parse(harness("commit", "log", "--issue", "42").stdout)[0].sha,
    result.sha,
  );
  assert.deepEqual(
    JSON.parse(harness("commit", "log", "--issue", "4").stdout),
    [],
  );
  assert.notEqual(harness("commit", "push").status, 0);
  git("remote", "set-url", "origin", "https://github.com/someone/else.git");
  assert.notEqual(harness("status").status, 0);
});
test("Issue 读写：区分 PR，正文以 JSON 传输，评论失败不重试", (t) => {
  const { git, file, dir, exec } = fixture(t);
  git("commit", "--allow-empty", "-qm", "init");
  file(
    "api.mjs",
    `globalThis.fetch=async url=>{
    const u=new URL(url);if(u.host!=="api.github.com") throw Error("wrong host");
    return Response.json(u.pathname.endsWith("/comments")?[]:u.pathname.endsWith("/42")?{number:42,title:"Example",state:"open",comments:0}:u.pathname.endsWith("/43")?{pull_request:{}}:[{number:43,pull_request:{}},{number:42,state:"open",title:"Example"}]);
  }`,
  );
  file(
    "gh",
    `#!/usr/bin/env node
const fs=require("node:fs");fs.appendFileSync("calls",JSON.stringify({args:process.argv.slice(2),body:JSON.parse(fs.readFileSync(0,"utf8"))})+"\\n");
if(process.argv.includes("repos/daijinru/continuum/issues/42/comments"))process.exit(1);
console.log(JSON.stringify({number:42,html_url:"https://github.com/daijinru/continuum/issues/42",state:"open"}));
`,
  );
  chmodSync(join(dir, "gh"), 0o700);
  const issue = (args: string[], body?: string) =>
    exec(
      process.execPath,
      [
        "--import",
        pathToFileURL(join(dir, "api.mjs")).href,
        cli,
        "issue",
        ...args,
      ],
      body,
    );
  assert.deepEqual(
    JSON.parse(issue(["list"]).stdout).map((i: { number: number }) => i.number),
    [42],
  );
  assert.notEqual(issue(["close", "43"]).status, 0);
  const body = "用户需求\n\n检查 `$(echo hello)` 原样保留。";
  const created = issue(["create", "一个需求"], body);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).number, 42);
  assert.notEqual(issue(["comment", "42"], "验证失败").status, 0);
  const calls = readFileSync(join(dir, "calls"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.body, body);
  assert.deepEqual(calls[0].args, [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "POST",
    "repos/daijinru/continuum/issues",
    "--input",
    "-",
  ]);
});

test("本地清理只删已合并、远端已删、PR 尖端一致且无 worktree 的分支", (t) => {
  const { git, dir, exec } = fixture(t);
  git("commit", "--allow-empty", "-qm", "base");
  const sha = git("rev-parse", "HEAD").trim();
  git("update-ref", "refs/remotes/origin/main", sha);
  for (const b of [
    "merged",
    "changed",
    "remote-exists",
    "checked-out",
    "master",
    "unpublished",
    "ahead",
  ])
    git("branch", b);
  git("switch", "-q", "ahead");
  git("commit", "--allow-empty", "-qm", "not merged");
  git("switch", "-q", "main");
  const wt = mkdtempSync(join(tmpdir(), "continuum-occupied-"));
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  git("worktree", "add", wt, "checked-out");
  const helper = new URL("../scripts/merged-branches.mjs", import.meta.url)
    .href;
  const source = `import {cleanLocal} from ${JSON.stringify(helper)};
    import {execFileSync} from 'node:child_process';
    const git=(...args)=>args[0]==='ls-remote'?'${sha}\\trefs/heads/remote-exists':execFileSync('git',args,{encoding:'utf8'}).trimEnd();
    const prs=name=>name==='unpublished'?[]:[{headRefName:name,headRefOid:name==='changed'?'other':'${sha}',isCrossRepository:false,baseRefName:'main',state:'MERGED'}];
    console.log(JSON.stringify(cleanLocal(git,prs,'main',process.argv[1]==='preview')));`;
  for (const mode of ["preview", "apply"]) {
    const r = exec(process.execPath, [
      "--input-type=module",
      "-e",
      source,
      mode,
    ]);
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.deepEqual(mode === "preview" ? result.eligible : result.deleted, [
      "merged",
    ]);
    assert.equal(existsRef("merged"), mode === "preview");
    for (const b of [
      "changed",
      "remote-exists",
      "checked-out",
      "master",
      "unpublished",
      "ahead",
      "main",
    ])
      assert.ok(existsRef(b), b);
  }
  function existsRef(name: string) {
    return (
      spawnSync(
        "git",
        ["show-ref", "--verify", "--quiet", "refs/heads/" + name],
        { cwd: dir },
      ).status === 0
    );
  }
});
