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
  file(
    "issues.mjs",
    `globalThis.fetch = async url => {
    const path = new URL(url).pathname;
    if (path === "/repos/daijinru/continuum/issues/42")
      return Response.json({number:42,html_url:"https://github.com/daijinru/continuum/issues/42"});
    if (path === "/repos/daijinru/continuum/issues/43")
      return Response.json({pull_request:{}});
    return new Response(null, {status:404});
  };`,
  );
  const harness = (...args: string[]) =>
    exec(process.execPath, [
      "--import",
      pathToFileURL(join(dir, "issues.mjs")).href,
      cli,
      ...args,
    ]);
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
  for (const [flags, error] of [
    [[], /缺少 --issue/],
    [["--issue", "43"], /是 PR/],
    [["--issue", "44"], /404/],
  ] as const) {
    const invalid = harness(
      "commit",
      "create",
      ...flags,
      "变更",
      "--",
      "a.txt",
    );
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, error);
    assert.equal(git("diff", "--cached", "--name-only").trim(), "a.txt");
  }
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
    return Response.json(u.pathname.endsWith("/comments")?[]:u.pathname.endsWith("/42")?{number:42,title:"Example",state:"open",comments:0,html_url:"https://github.com/daijinru/continuum/issues/42"}:u.pathname.endsWith("/43")?{pull_request:{}}:[{number:43,pull_request:{}},{number:42,state:"open",title:"Example"}]);
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

test("按 PR 编号接续：失败非零退出并定位作业；修复后仅实际合并回执成功", (t) => {
  const { file, dir, harness } = fixture(t);
  file(
    "gh",
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args.slice(0,6).join(" ") !== "pr view 42 -R daijinru/continuum --json") process.exit(3);
process.stdout.write(require("node:fs").readFileSync("remote.json"));
`,
  );
  chmodSync(join(dir, "gh"), 0o700);
  const job = "https://github.com/daijinru/continuum/actions/runs/123/job/456";
  const pr = {
    number: 42,
    baseRefName: "main",
    isCrossRepository: false,
    state: "OPEN",
    headRefOid: "a".repeat(40),
    autoMergeRequest: {},
    mergeStateStatus: "BLOCKED",
    statusCheckRollup: [
      { name: "lint", conclusion: "FAILURE", detailsUrl: job },
    ],
  };
  file("remote.json", JSON.stringify(pr));
  const failed = harness("pr", "watch", "42");
  assert.equal(failed.status, 1, failed.stderr);
  assert.deepEqual(JSON.parse(failed.stdout).failures, [
    { name: "lint", result: "FAILURE", url: job },
  ]);
  file(
    "remote.json",
    JSON.stringify({
      ...pr,
      state: "MERGED",
      headRefOid: "b".repeat(40),
      mergeCommit: { oid: "d".repeat(40) },
      autoMergeRequest: null,
      statusCheckRollup: [],
    }),
  );
  const fixed = harness("pr", "watch", "42");
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(JSON.parse(fixed.stdout).outcome, "merged");
  assert.equal(JSON.parse(fixed.stdout).headRefOid, "b".repeat(40));
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

test("发布使用同一真实 Issue，核对 GitHub 关联后才开启合并", (t) => {
  const { git, dir, file, harness } = fixture(t);
  git("switch", "-qc", "feature");
  git("commit", "--allow-empty", "-qm", "initial");
  const realGit = spawnSync("which", ["git"], {
    encoding: "utf8",
  }).stdout.trim();
  file(
    "git",
    `#!${process.execPath}
const fs = require("node:fs"), cp = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "ls-remote") console.log(cp.execFileSync(${JSON.stringify(realGit)}, ["rev-parse","HEAD"], {encoding:"utf8"}).trim()+"\\t"+args[2]);
else if (args[0] === "push") fs.appendFileSync("writes","push\\n");
else process.exit(cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:"inherit"}).status);
`,
  );
  chmodSync(join(dir, "git"), 0o700);
  const url = "https://github.com/daijinru/continuum/pull/55";
  const target = "https://github.com/daijinru/continuum/issues/42";
  file(
    "gh",
    `#!${process.execPath}
const fs = require("node:fs"), args = process.argv.slice(2), url = ${JSON.stringify(url)};
const pr=JSON.parse(fs.readFileSync("pr.json"));
const write=op=>fs.appendFileSync("writes",op+"\\n");
let output;
if(args.includes("repos/daijinru/continuum/rules/branches/main")) output=[{type:"required_status_checks",parameters:{required_status_checks:[{context:"lint",integration_id:15368}]}}];
else if(args[1]==="list") output=pr.exists?[{url,headRepositoryOwner:{login:"daijinru"}}]:[];
else if(args[1]==="create"){write("create");pr.body=args.at(-1);pr.exists=true;output=url;}
else if(args.includes("PATCH")){write("patch");pr.body=JSON.parse(fs.readFileSync(0)).body;output={};}
else if(args[1]==="merge"){write("merge");output="";}
else if(args[1]==="view" && args.at(-1).includes("closingIssuesReferences"))
  output={number:55,body:pr.body,closingIssuesReferences:pr.links ?? (pr.body.endsWith("Closes #42")?[{url:${JSON.stringify(target)}}]:[])};
else if(args[1]==="view") output={state:"MERGED",baseRefName:"main",mergeCommit:{oid:"merged"}};
else process.exit(2);
fs.writeFileSync("pr.json",JSON.stringify(pr));
console.log(typeof output === "string" ? output : JSON.stringify(output));`,
  );
  chmodSync(join(dir, "gh"), 0o700);
  file("writes", "");
  const writes = () => readFileSync(join(dir, "writes"), "utf8");
  const submit = () => harness("pr", "submit", "--issue", "42");
  assert.match(harness("commit", "push").stderr, /Refs/);
  assert.match(harness("pr", "submit").stderr, /缺少 --issue/);
  assert.match(submit().stderr, /Refs/);
  git("commit", "--allow-empty", "-qm", "task", "-m", "Refs: #43");
  assert.match(harness("commit", "push").stderr, /是 PR/);
  assert.match(submit().stderr, /不一致/);
  assert.equal(writes(), "");
  git("commit", "--allow-empty", "-qm", "task", "-m", "Refs: #42");
  const pushed = harness("commit", "push");
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.equal(
    JSON.parse(pushed.stdout).next,
    "pnpm harness pr submit --issue 42",
  );
  for (const exists of [false, true]) {
    file("pr.json", JSON.stringify({ exists, body: "已有说明" }));
    file("writes", "");
    const result = submit();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(writes(), exists ? "patch\nmerge\n" : "create\nmerge\n");
    const { body } = JSON.parse(readFileSync(join(dir, "pr.json"), "utf8"));
    assert.equal(body, exists ? "已有说明\n\nCloses #42" : "Closes #42");
    file("writes", "");
    assert.equal(submit().status, 0);
    assert.equal(writes(), "merge\n");
  }
  for (const links of [
    [],
    [{ url: "https://github.com/another/repo/issues/42" }],
  ]) {
    file("writes", "");
    file(
      "pr.json",
      JSON.stringify({ exists: true, body: "Closes #42", links }),
    );
    assert.equal(submit().status, 1);
    assert.equal(writes(), "");
  }
});
