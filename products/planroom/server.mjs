import {createServer} from "node:http";
import {DatabaseSync} from "node:sqlite";
import {readFile} from "node:fs/promises";
import {mkdirSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
const root=dirname(fileURLToPath(import.meta.url)),port=Number(process.env.PORT||4320);
const home=process.env.PLANROOM_DATA||join(root,"data");mkdirSync(home,{recursive:true,mode:0o700});
const db=new DatabaseSync(join(home,"plans.sqlite"));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS board(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,plans TEXT NOT NULL);
  INSERT OR IGNORE INTO board VALUES(1,0,'[]');`);
const snapshot=()=>{const row=db.prepare("select version,plans from board where id=1").get();return {version:row.version,plans:JSON.parse(row.plans)}};
const text=(v,max)=>typeof v==="string"&&v.length<=max;
const name=v=>text(v,200)&&v.trim().length>0;
const list=(v,max)=>Array.isArray(v)&&v.length<=max&&v.every(x=>x&&name(x.id))&&new Set(v.map(x=>x.id)).size===v.length;
function valid(plans){
  return list(plans,200)&&plans.every(p=>name(p.name)&&list(p.buckets,200)&&p.buckets.length>0&&p.buckets.every(b=>name(b.name))&&list(p.tasks,5000)&&p.tasks.every(t=>name(t.title)&&p.buckets.some(b=>b.id===t.bucket)&&text(t.owner,200)&&text(t.notes,8000)&&["待办","进行中","已完成"].includes(t.status)&&text(t.due,10)&&(!t.due||/^\d{4}-\d\d-\d\d$/.test(t.due))));
}
const assets=new Map(Object.entries({"/":"index.html","/index.html":"index.html","/style.css":"style.css","/app.js":"app.js","/board.js":"board.js","/editor.js":"editor.js","/plans.js":"plans.js"}));
const server=createServer(async(req,res)=>{
  const json=(code,obj)=>{res.writeHead(code,{"Content-Type":"application/json; charset=utf-8"});res.end(JSON.stringify(obj))};
  res.setHeader("Cache-Control","no-store");res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("Content-Security-Policy","default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try{
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host))return json(403,{error:"仅限本机使用"});
    if(req.url==="/api/state"){
      if(req.method==="GET")return json(200,snapshot());
      if(req.method!=="PUT")return json(405,{error:"不支持的操作"});
      if(req.headers.origin!==`http://${req.headers.host}`||req.headers["content-type"]?.split(";")[0]!=="application/json")return json(403,{error:"请从计划室页面保存"});
      const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>2_000_000)return json(413,{error:"计划过大"});chunks.push(c)}
      let b;try{b=JSON.parse(Buffer.concat(chunks))}catch{return json(400,{error:"格式不正确"})}
      if(!b||!Number.isSafeInteger(b.version)||!valid(b.plans))return json(422,{error:"请检查任务字段、名称长度及所属分组"});
      const result=db.prepare("update board set plans=?,version=version+1 where id=1 and version=?").run(JSON.stringify(b.plans),b.version);
      return result.changes?json(200,snapshot()):json(409,{error:"另一个窗口已更新计划"});
    }
    const file=assets.get(req.url);
    if(req.method!=="GET"||!file)return json(404,{error:"不存在"});
    const data=await readFile(join(root,"public",file));res.setHeader("Content-Type",(file.endsWith(".js")?"text/javascript":file.endsWith(".html")?"text/html":"text/css")+"; charset=utf-8");res.end(data);
  }catch{json(500,{error:"暂时无法读取或保存计划"})}
});
server.listen(port,"127.0.0.1",()=>console.log(`计划室 http://127.0.0.1:${port}/`));
process.on("SIGTERM",()=>server.close(()=>{db.close();process.exit(0)}));
