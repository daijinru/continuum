// Run inside the Continuum development checkout; Playwright is a development-only dependency.
import {chromium,expect} from "@playwright/test";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import assert from "node:assert/strict";
const home=mkdtempSync(join(tmpdir(),"planroom-qa-")),port=14320,url=`http://127.0.0.1:${port}`;
async function start(){
 const p=spawn(process.execPath,["server.mjs"],{cwd:new URL(".",import.meta.url),env:{...process.env,PORT:String(port),PLANROOM_DATA:home},stdio:["ignore","pipe","inherit"]});
 await Promise.race([once(p.stdout,"data"),once(p,"exit").then(()=>{throw Error("启动失败")})]);return p;
}
const stop=async p=>{const end=once(p,"exit");p.kill();await end};
let p=await start(),browser;
try{
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
 const page=await browser.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto(url);const btn=name=>page.getByRole("button",{name,exact:true});
 for(const name of ["验收 A","验收 B"]){await page.getByLabel("计划名称").fill(name);await btn("创建计划").click();await expect(btn(name)).toHaveAttribute("aria-pressed","true")}
 await btn("验收 A").click();await page.getByLabel("分组名称").fill("跟进");await btn("新增分组").click();
 const lane=page.locator(".lane").filter({has:page.getByRole("heading",{name:"跟进"})});
 await lane.getByRole("button",{name:"新增任务"}).click();
 const dialog=page.getByRole("dialog");await dialog.getByLabel("标题").fill("核对交付");await dialog.getByLabel("负责人").fill("项目负责人");await dialog.getByLabel("截止日期").fill("2020-01-01");await dialog.getByLabel("说明").fill("核对验收条件");await btn("保存").click();
 const card=page.locator(".card",{hasText:"核对交付"});await expect(lane.locator(".card")).toHaveCount(1);await expect(page.locator("output")).toContainText("逾期 1 项");
 await card.click();await dialog.getByLabel("标题").fill("取消的改动");await btn("取消").click();await expect(card).toBeVisible();
 await card.click();await dialog.getByLabel("进度").selectOption("已完成");await dialog.getByLabel("分组").selectOption({label:"默认分组"});await btn("保存").click();
 await expect(lane.locator(".card")).toHaveCount(0);await expect(page.locator("output")).toContainText("已完成 1 项，剩余 0 项，逾期 0 项");
 await page.locator("#board select").nth(0).selectOption({label:"项目负责人"});await page.locator("#board select").nth(1).selectOption({label:"进行中"});await expect(card).toHaveCount(0);
 await btn("验收 B").click();await expect(page.locator(".lane")).toHaveCount(1);await expect(card).toHaveCount(0);
 await btn("验收 A").click();await expect(card).toBeVisible();await stop(p);p=await start();await page.reload();await expect(card).toBeVisible();
 await card.click();await expect(dialog.getByLabel("说明")).toHaveValue("核对验收条件");page.once("dialog",d=>d.accept());await btn("删除任务").click();await expect(card).toHaveCount(0);
 const state=await(await fetch(url+"/api/state")).json();
 const put=(body)=>fetch(url+"/api/state",{method:"PUT",headers:{origin:url,"content-type":"application/json"},body:JSON.stringify(body)});
 assert.equal((await put({...state,version:state.version-1,plans:[]})).status,409);
 assert.deepEqual(await(await fetch(url+"/api/state")).json(),state);
 assert.deepEqual(errors,[]);console.log("通过：计划隔离、分组、任务增改删、取消、分组移动、筛选、逾期、重启恢复、并发冲突。");
}finally{await browser?.close();if(p.exitCode===null&&!p.signalCode)await stop(p)}
