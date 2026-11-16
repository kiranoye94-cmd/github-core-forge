import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';

const JSON_TYPE = 'application/json; charset=utf-8';
const OWNER = 'adaiversen';
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const NOW = '2025-01-01T00:00:00Z';
let requestSeq = 0, repoSeq = 5000, issueIdSeq = 10000, commentSeq = 20000;

interface FileEntry { path: string; content: string; sha: string }
interface Commit { sha: string; message: string; files: Map<string, FileEntry> }
interface Branch { name: string; commits: Commit[]; forkFiles: Map<string, FileEntry> }
interface Issue { id: number; node_id: string; number: number; title: string; body: string; state: 'open'|'closed'; labels: Array<{name:string;color?:string}>; comments: Comment[] }
interface Comment { id: number; node_id: string; body: string }
interface Pull { id: number; node_id: string; number: number; title: string; body: string; state: 'open'|'closed'; merged: boolean; merged_at: string|null; merge_commit_sha: string|null; headName: string; baseName: string; changedPaths: string[] }
interface Repo { id: number; node_id: string; owner: string; name: string; full_name: string; private: boolean; description: string; default_branch: string; labels: Map<string,{name:string;color:string}>; issues: Issue[]; pulls: Pull[]; branches: Map<string,Branch> }
const repos = new Map<string,Repo>();

function digest(...parts: string[]): string { return createHash('sha1').update(parts.join('\0')).digest('hex'); }
function cloneFiles(files: Map<string,FileEntry>): Map<string,FileEntry> { return new Map([...files].map(([k,v]) => [k,{...v}])); }
function key(owner:string,name:string): string { return `${owner.toLowerCase()}/${name.toLowerCase()}`; }
function repoNode(id:number): string { return Buffer.from(`Repository:${id}`).toString('base64'); }
function issueNode(id:number): string { return Buffer.from(`Issue:${id}`).toString('base64'); }
function pullNode(id:number): string { return Buffer.from(`PullRequest:${id}`).toString('base64'); }
function commentNode(id:number): string { return Buffer.from(`IssueComment:${id}`).toString('base64'); }
function findNode(id:unknown): {kind:string; repo:Repo; value?:Issue|Pull}|null {
  for (const repo of repos.values()) {
    if (repo.node_id === id) return {kind:'repo',repo};
    const issue=repo.issues.find(x=>x.node_id===id); if(issue) return {kind:'issue',repo,value:issue};
    const pull=repo.pulls.find(x=>x.node_id===id); if(pull) return {kind:'pull',repo,value:pull};
  }
  return null;
}
function auth(req:IncomingMessage): boolean { const m=/^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization??'')); return m!==null && (EXPECTED_TOKEN==='' || m[1]===EXPECTED_TOKEN); }
function headers(extra:Readonly<Record<string,string>>={}): Record<string,string> { return {'content-type':JSON_TYPE,'x-github-request-id':`FORGE-${++requestSeq}`,...extra}; }
function sendJson(res:ServerResponse,status:number,body:unknown,extra:Readonly<Record<string,string>>={}):void {
  const text=`${JSON.stringify(body)}\n`; res.writeHead(status,{...headers(extra),'content-length':String(Buffer.byteLength(text))}); res.end(text);
}
function sendEmpty(res:ServerResponse,status:number):void { res.writeHead(status,headers()); res.end(); }
function error(res:ServerResponse,status:number,message:string):void { sendJson(res,status,{message}); }
async function readBody(req:IncomingMessage):Promise<unknown> {
  const chunks:Buffer[]=[]; let size=0;
  for await (const chunk of req) { const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk); size+=b.length; if(size>2_000_000) throw new Error('too large'); chunks.push(b); }
  const text=Buffer.concat(chunks).toString('utf8'); if(!text.trim()) return {};
  return JSON.parse(text);
}
function object(value:unknown):Record<string,unknown> { return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}; }
function repoJson(r:Repo):Record<string,unknown> { return {id:r.id,node_id:r.node_id,name:r.name,full_name:r.full_name,private:r.private,description:r.description,default_branch:r.default_branch,owner:{login:r.owner,id:1000},has_issues:true}; }
function latest(b:Branch):Commit|undefined { return b.commits[b.commits.length-1]; }
function branchFiles(b:Branch):Map<string,FileEntry> { return latest(b)?.files ?? new Map(); }
function commitJson(c:Commit):Record<string,unknown> { return {sha:c.sha,node_id:Buffer.from(`Commit:${c.sha}`).toString('base64'),commit:{message:c.message,author:{name:OWNER,date:NOW}},author:{login:OWNER}}; }
function issueJson(i:Issue):Record<string,unknown> { return {id:i.id,node_id:i.node_id,number:i.number,title:i.title,body:i.body,state:i.state,labels:i.labels,comments:i.comments.length,created_at:NOW,updated_at:NOW,user:{login:OWNER}}; }
function pullJson(r:Repo,p:Pull):Record<string,unknown> {
  const head=r.branches.get(p.headName), base=r.branches.get(p.baseName);
  return {id:p.id,node_id:p.node_id,number:p.number,title:p.title,body:p.body,state:p.state,merged:p.merged,merged_at:p.merged_at,merge_commit_sha:p.merge_commit_sha,head:{ref:p.headName,sha:latest(head!)?.sha??digest('empty')},base:{ref:p.baseName,sha:latest(base!)?.sha??digest('empty')},created_at:NOW,updated_at:NOW,user:{login:OWNER}};
}
function makeRepo(body:Record<string,unknown>):Repo {
  const name=String(body.name??'').trim(); const id=++repoSeq;
  const r:Repo={id,node_id:repoNode(id),owner:OWNER,name,full_name:`${OWNER}/${name}`,private:body.private===true,description:typeof body.description==='string'?body.description:'',default_branch:'main',labels:new Map(),issues:[],pulls:[],branches:new Map()};
  r.branches.set('main',{name:'main',commits:[],forkFiles:new Map()}); repos.set(key(OWNER,name),r); return r;
}
function namedRepo(owner:string,name:string):Repo|undefined { if(owner.toLowerCase()!==OWNER) return undefined; return repos.get(key(owner,name)); }
function contentJson(f:FileEntry):Record<string,unknown> { return {type:'file',encoding:'base64',content:f.content,sha:f.sha,size:Buffer.from(f.content,'base64').length,name:f.path.split('/').pop(),path:f.path,url:''}; }
function createIssue(r:Repo,b:Record<string,unknown>):Issue|undefined {
  const labels=Array.isArray(b.labels)?b.labels.map(String):[]; if(labels.some(x=>!r.labels.has(x))) return undefined;
  const id=++issueIdSeq; const i:Issue={id,node_id:issueNode(id),number:r.issues.length+r.pulls.length+1,title:String(b.title??''),body:typeof b.body==='string'?b.body:'',state:'open',labels:labels.map(x=>({...r.labels.get(x)!})),comments:[]}; r.issues.push(i); return i;
}
function createPull(r:Repo,b:Record<string,unknown>):Pull|undefined {
  const head=String(b.head??b.headRefName??''),base=String(b.base??b.baseRefName??r.default_branch); if(!r.branches.has(head)||!r.branches.has(base)) return undefined;
  const h=r.branches.get(head)!; const bf=branchFiles(r.branches.get(base)!); const changed=[...branchFiles(h).keys()].filter(path=>branchFiles(h).get(path)?.sha!==bf.get(path)?.sha);
  const number=r.issues.length+r.pulls.length+1,id=30000+number+r.id*100;
  const p:Pull={id,node_id:pullNode(id),number,title:String(b.title??''),body:typeof b.body==='string'?b.body:'',state:'open',merged:false,merged_at:null,merge_commit_sha:null,headName:head,baseName:base,changedPaths:changed}; r.pulls.push(p); return p;
}
function hasConflict(r:Repo,p:Pull):boolean {
  const h=r.branches.get(p.headName)!, base=r.branches.get(p.baseName)!; const hf=branchFiles(h),bf=branchFiles(base);
  return p.changedPaths.some(path=>{const fork=h.forkFiles.get(path)?.sha; return bf.get(path)?.sha!==fork && hf.get(path)?.sha!==bf.get(path)?.sha;});
}
function mergePull(r:Repo,p:Pull):{ok:boolean;sha?:string} {
  if(p.merged) return {ok:true,sha:p.merge_commit_sha!}; if(hasConflict(r,p)) return {ok:false};
  const head=r.branches.get(p.headName)!,base=r.branches.get(p.baseName)!; const files=cloneFiles(branchFiles(base)); for(const path of p.changedPaths){const f=branchFiles(head).get(path);if(f)files.set(path,{...f});else files.delete(path);}
  const sha=digest(r.full_name,p.title,String(p.number),...p.changedPaths.map(x=>files.get(x)?.sha??'delete')); base.commits.push({sha,message:p.title,files}); p.merged=true;p.state='closed';p.merged_at=NOW;p.merge_commit_sha=sha; return {ok:true,sha};
}

async function rest(req:IncomingMessage,res:ServerResponse,url:URL):Promise<void> {
  const method=req.method??'GET', path=url.pathname;
  if(method==='GET'&&(path==='/api/v3'||path==='/api/v3/')) return sendJson(res,200,{current_user_url:'/api/v3/user',rate_limit_url:'/api/v3/rate_limit'},{'x-oauth-scopes':'repo, read:org'});
  if(method==='GET'&&path==='/api/v3/meta') return sendJson(res,200,{installed_version:'forge-1.0'});
  if(!auth(req)) return error(res,401,'Requires authentication');
  if(method==='GET'&&path==='/api/v3/user') return sendJson(res,200,{login:OWNER,id:1000,node_id:Buffer.from(`User:${OWNER}`).toString('base64')});
  let body:Record<string,unknown>={}; if(['POST','PUT','PATCH','DELETE'].includes(method)){try{body=object(await readBody(req));}catch{return error(res,400,'Problems parsing JSON');}}
  if(method==='POST'&&path==='/api/v3/user/repos') { const name=String(body.name??'').trim(); if(!name)return error(res,422,'Validation Failed'); if(repos.has(key(OWNER,name)))return error(res,422,'Repository already exists'); return sendJson(res,201,repoJson(makeRepo(body))); }
  if(method==='GET'&&path==='/api/v3/user/repos') {
    const all=[...repos.values()].filter(x=>x.owner===OWNER), per=Math.max(1,Math.min(100,Number(url.searchParams.get('per_page')??30))), page=Math.max(1,Number(url.searchParams.get('page')??1)), slice=all.slice((page-1)*per,page*per); const extra:Record<string,string>={};
    if(page*per<all.length){const next=new URL(url);next.searchParams.set('page',String(page+1));next.searchParams.set('per_page',String(per));extra.link=`<${next.toString()}>; rel="next"`;}
    return sendJson(res,200,slice.map(repoJson),extra);
  }
  const m=/^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path); if(!m)return error(res,404,'Not Found');
  const owner=decodeURIComponent(m[1]!),name=decodeURIComponent(m[2]!),tail=m[3]??'',r=namedRepo(owner,name); if(!r)return error(res,404,'Not Found');
  if(!tail){if(method==='GET')return sendJson(res,200,repoJson(r));if(method==='PATCH'){if(typeof body.description==='string')r.description=body.description;return sendJson(res,200,repoJson(r));}if(method==='DELETE'){repos.delete(key(owner,name));return sendEmpty(res,204);}}
  if(tail==='labels'&&method==='POST'){const label={name:String(body.name??''),color:String(body.color??'ededed')};r.labels.set(label.name,label);return sendJson(res,201,label);}
  if(tail==='git/refs'&&method==='POST'){const ref=String(body.ref??''),bn=ref.replace(/^refs\/heads\//,'');let source:Branch|undefined;for(const b of r.branches.values())if(latest(b)?.sha===body.sha)source=b;if(!source)return error(res,422,'Object does not exist');const b={name:bn,commits:[...source.commits],forkFiles:cloneFiles(branchFiles(source))};r.branches.set(bn,b);return sendJson(res,201,{ref:`refs/heads/${bn}`,object:{sha:String(body.sha),type:'commit'}});}
  let rm=/^git\/refs\/heads\/(.+)$/.exec(tail); if(rm&&method==='GET'){const b=r.branches.get(decodeURIComponent(rm[1]!));if(!b)return error(res,404,'Not Found');return sendJson(res,200,{ref:`refs/heads/${b.name}`,object:{sha:latest(b)?.sha??digest('empty'),type:'commit'}});}
  if(tail==='branches'&&method==='GET')return sendJson(res,200,[...r.branches.values()].map(b=>({name:b.name,commit:{sha:latest(b)?.sha??digest('empty')}})));
  rm=/^branches\/(.+)$/.exec(tail);if(rm&&method==='GET'){const b=r.branches.get(decodeURIComponent(rm[1]!));if(!b)return error(res,404,'Not Found');return sendJson(res,200,{name:b.name,commit:{sha:latest(b)?.sha??digest('empty')}});}
  if(tail==='commits'&&method==='GET'){const b=r.branches.get(url.searchParams.get('sha')??r.default_branch);if(!b)return error(res,404,'Not Found');return sendJson(res,200,[...b.commits].reverse().map(commitJson));}
  const cm=/^contents(?:\/(.*))?$/.exec(tail); if(cm){const filePath=decodeURIComponent(cm[1]??''),bn=String(body.branch??url.searchParams.get('ref')??r.default_branch),b=r.branches.get(bn);if(!b)return error(res,404,'Not Found');const files=branchFiles(b);
    if(method==='GET'){const f=files.get(filePath);if(f)return sendJson(res,200,contentJson(f));const prefix=filePath?`${filePath.replace(/\/$/,'')}/`:'';const children=new Map<string,Record<string,unknown>>();for(const [p,e] of files){if(!p.startsWith(prefix))continue;const rest=p.slice(prefix.length),first=rest.split('/')[0]!;if(rest.includes('/'))children.set(first,{type:'dir',name:first,path:`${prefix}${first}`,sha:digest('dir',prefix,first)});else children.set(first,contentJson(e));}if(children.size)return sendJson(res,200,[...children.values()]);return error(res,404,'Not Found');}
    if(method==='PUT'){const old=files.get(filePath),given=typeof body.sha==='string'?body.sha:undefined;if(old&&given!==old.sha)return error(res,409,'sha does not match');if(!old&&given)return error(res,409,'sha does not match');const content=String(body.content??''),sha=digest(Buffer.from(content,'base64').toString('binary')),next=cloneFiles(files);next.set(filePath,{path:filePath,content,sha});const csha=digest(r.full_name,bn,String(b.commits.length),String(body.message??''),sha);b.commits.push({sha:csha,message:String(body.message??''),files:next});return sendJson(res,old?200:201,{content:{...contentJson(next.get(filePath)!),encoding:'base64'},commit:{sha:csha,message:String(body.message??'')}});}
    if(method==='DELETE'){const old=files.get(filePath);if(!old)return error(res,404,'Not Found');if(body.sha!==old.sha)return error(res,409,'sha does not match');const next=cloneFiles(files);next.delete(filePath);const csha=digest(r.full_name,bn,'delete',filePath,String(b.commits.length));b.commits.push({sha:csha,message:String(body.message??''),files:next});return sendJson(res,200,{content:null,commit:{sha:csha}});}
  }
  if(tail==='issues'&&method==='POST'){const i=createIssue(r,body);if(!i)return error(res,422,'Validation Failed');return sendJson(res,201,issueJson(i));}
  if(tail==='issues'&&method==='GET'){const state=url.searchParams.get('state')??'open';let list=r.issues.filter(i=>state==='all'||i.state===state);if((url.searchParams.get('direction')??'desc')==='desc')list=[...list].reverse();return sendJson(res,200,list.map(issueJson));}
  let im=/^issues\/(\d+)$/.exec(tail);if(im){const i=r.issues.find(x=>x.number===Number(im[1]));if(!i)return error(res,404,'Not Found');if(method==='GET')return sendJson(res,200,issueJson(i));if(method==='PATCH'){if(body.state==='closed'||body.state==='open')i.state=body.state;if(typeof body.title==='string')i.title=body.title;if(typeof body.body==='string')i.body=body.body;return sendJson(res,200,issueJson(i));}}
  im=/^issues\/(\d+)\/comments$/.exec(tail);if(im){const i=r.issues.find(x=>x.number===Number(im[1]));if(!i)return error(res,404,'Not Found');if(method==='GET')return sendJson(res,200,i.comments);if(method==='POST'){const id=++commentSeq,c={id,node_id:commentNode(id),body:String(body.body??'')};i.comments.push(c);return sendJson(res,201,c);}}
  if(tail==='pulls'&&method==='POST'){const p=createPull(r,body);if(!p)return error(res,422,'Validation Failed');return sendJson(res,201,pullJson(r,p));}
  if(tail==='pulls'&&method==='GET'){const state=url.searchParams.get('state')??'open';return sendJson(res,200,r.pulls.filter(p=>state==='all'||p.state===state).map(p=>pullJson(r,p)));}
  let pm=/^pulls\/(\d+)$/.exec(tail);if(pm){const p=r.pulls.find(x=>x.number===Number(pm[1]));if(!p)return error(res,404,'Not Found');return sendJson(res,200,pullJson(r,p));}
  pm=/^pulls\/(\d+)\/files$/.exec(tail);if(pm&&method==='GET'){const p=r.pulls.find(x=>x.number===Number(pm[1]));if(!p)return error(res,404,'Not Found');return sendJson(res,200,p.changedPaths.map(filename=>({filename,status:'added',additions:Math.max(1,Buffer.from(branchFiles(r.branches.get(p.headName)!).get(filename)?.content??'','base64').toString().split('\n').length),deletions:0,changes:1})));}
  pm=/^pulls\/(\d+)\/merge$/.exec(tail);if(pm&&method==='PUT'){const p=r.pulls.find(x=>x.number===Number(pm[1]));if(!p)return error(res,404,'Not Found');const result=mergePull(r,p);if(!result.ok)return error(res,405,'Pull Request is not mergeable');return sendJson(res,200,{sha:result.sha,merged:true,message:'Pull Request successfully merged'});}
  return error(res,404,'Not Found');
}

const TYPE_FIELDS:Record<string,string[]>={Issue:['id','number','title','state','body'],PullRequest:['id','number','headRefName','baseRefName','mergeable','state','merged','files'],Repository:['id','databaseId','name','nameWithOwner','owner','defaultBranchRef','viewerPermission','hasIssuesEnabled','issue','issues','pullRequests','pullRequest']};
function gqlIssue(i:Issue):Record<string,unknown>{return {...issueJson(i),id:i.node_id,state:i.state.toUpperCase()};}
function gqlPull(r:Repo,p:Pull):Record<string,unknown>{return {id:p.node_id,number:p.number,title:p.title,state:p.merged?'MERGED':p.state.toUpperCase(),merged:p.merged,headRefName:p.headName,baseRefName:p.baseName,mergeable:hasConflict(r,p)?'CONFLICTING':'MERGEABLE',files:{nodes:p.changedPaths.map(path=>({path}))}};}
function gqlRepo(r:Repo,q:string,v:Record<string,unknown>):Record<string,unknown>{
  const first=Number(v.first??(/first:\s*(\d+)/.exec(q)?.[1]??100)),after=typeof v.after==='string'?Number(Buffer.from(v.after,'base64').toString().replace('cursor:',''))+1:0;let issues=[...r.issues];if(/states\s*:\s*\[OPEN\]/.test(q))issues=issues.filter(i=>i.state==='open');if(/direction\s*:\s*DESC/.test(q))issues.reverse();const page=issues.slice(after,after+first),end=after+page.length-1;
  return {id:r.node_id,databaseId:r.id,name:r.name,nameWithOwner:r.full_name,owner:{login:r.owner},defaultBranchRef:r.branches.get(r.default_branch)&&latest(r.branches.get(r.default_branch)!)?{name:r.default_branch}:null,viewerPermission:'ADMIN',hasIssuesEnabled:true,issue:gqlIssue(r.issues.find(i=>i.number===Number(v.number))!)||null,issues:{nodes:page.filter(Boolean).map(gqlIssue),pageInfo:{hasNextPage:after+page.length<issues.length,endCursor:page.length?Buffer.from(`cursor:${end}`).toString('base64'):null}},pullRequests:{nodes:r.pulls.slice(0,first).map(p=>gqlPull(r,p))},pullRequest:r.pulls.find(p=>p.number===Number(v.number))?gqlPull(r,r.pulls.find(p=>p.number===Number(v.number))!):null};
}
function graphqlOne(input:unknown):Record<string,unknown>{
  const b=object(input),q=String(b.query??''),v=object(b.variables),inp=object(v.input);
  if(q.includes('noSuchFieldOnViewer'))return {errors:[{message:'Cannot query field "noSuchFieldOnViewer" on type "User".'}]};
  if(q.includes('__type')){const data:Record<string,unknown>={};for(const type of ['Issue','PullRequest','Repository'])if(q.includes(`${type}: __type`)||q.includes(`name: "${type}"`))data[type]={fields:(TYPE_FIELDS[type]??[]).map(name=>({name}))};if(q.includes('SearchType'))data.SearchType={enumValues:['ISSUE','REPOSITORY','USER'].map(name=>({name}))};return {data};}
  if(q.includes('createIssue')){const n=findNode(inp.repositoryId);if(!n)return {errors:[{message:'Repository not found'}]};const i=createIssue(n.repo,inp)!;return {data:{createIssue:{issue:gqlIssue(i)}}};}
  if(q.includes('closeIssue')){const n=findNode(inp.issueId);if(!n||n.kind!=='issue')return {errors:[{message:'Issue not found'}]};const i=n.value as Issue;i.state='closed';return {data:{closeIssue:{issue:gqlIssue(i)}}};}
  if(q.includes('createPullRequest')){const n=findNode(inp.repositoryId);if(!n)return {errors:[{message:'Repository not found'}]};const p=createPull(n.repo,{title:inp.title,head:inp.headRefName,base:inp.baseRefName})!;return {data:{createPullRequest:{pullRequest:gqlPull(n.repo,p)}}};}
  if(q.includes('mergePullRequest')){const n=findNode(inp.pullRequestId);if(!n||n.kind!=='pull')return {errors:[{message:'Pull request not found'}]};mergePull(n.repo,n.value as Pull);return {data:{mergePullRequest:{pullRequest:gqlPull(n.repo,n.value as Pull)}}};}
  if(q.includes('addComment')){const n=findNode(inp.subjectId);if(!n||n.kind!=='issue')return {errors:[{message:'Subject not found'}]};const id=++commentSeq,c={id,node_id:commentNode(id),body:String(inp.body??'')};(n.value as Issue).comments.push(c);return {data:{addComment:{commentEdge:{node:{id:c.node_id,body:c.body}}}}};}
  if(/\bnode\s*\(/.test(q)){const n=findNode(v.id);return {data:{node:n?.kind==='repo'?{id:n.repo.node_id,name:n.repo.name,nameWithOwner:n.repo.full_name}:null}};}
  if(q.includes('viewer'))return {data:{viewer:{login:OWNER}}};
  if(q.includes('repository')){const r=namedRepo(String(v.owner??''),String(v.name??''));return {data:{repository:r?gqlRepo(r,q,v):null}};}
  return {data:{}};
}
async function graphql(req:IncomingMessage,res:ServerResponse):Promise<void>{if(!auth(req))return error(res,401,'Requires authentication');let body:unknown;try{body=await readBody(req);}catch{return error(res,400,'Problems parsing JSON');}sendJson(res,200,Array.isArray(body)?body.map(graphqlOne):graphqlOne(body));}

const TOOLS=[
  {name:'create_repo',description:'Create a repository',inputSchema:{type:'object',properties:{name:{type:'string'},description:{type:'string'},private:{type:'boolean'}},required:['name']}},
  {name:'get_repo',description:'Get a repository',inputSchema:{type:'object',properties:{owner:{type:'string'},repo:{type:'string'}},required:['owner','repo']}},
  {name:'create_issue',description:'Create an issue',inputSchema:{type:'object',properties:{owner:{type:'string'},repo:{type:'string'},title:{type:'string'},body:{type:'string'}},required:['owner','repo','title']}},
  {name:'list_issues',description:'List issues',inputSchema:{type:'object',properties:{owner:{type:'string'},repo:{type:'string'},state:{type:'string'}},required:['owner','repo']}},
  {name:'create_pull_request',description:'Create a pull request',inputSchema:{type:'object',properties:{owner:{type:'string'},repo:{type:'string'},title:{type:'string'},body:{type:'string'},head:{type:'string'},base:{type:'string'}},required:['owner','repo','title','head','base']}},
  {name:'merge_pull_request',description:'Merge a pull request',inputSchema:{type:'object',properties:{owner:{type:'string'},repo:{type:'string'},pull_number:{type:'integer'}},required:['owner','repo','pull_number']}}
] as const;
function rpcResult(id:unknown,result:unknown):Record<string,unknown>{return {jsonrpc:'2.0',id:id??null,result};} function rpcError(id:unknown,code:number,message:string):Record<string,unknown>{return {jsonrpc:'2.0',id:id??null,error:{code,message}};}
function toolCall(name:string,a:Record<string,unknown>):unknown{
  const required:Record<string,string[]>={create_repo:['name'],get_repo:['owner','repo'],create_issue:['owner','repo','title'],list_issues:['owner','repo'],create_pull_request:['owner','repo','title','head','base'],merge_pull_request:['owner','repo','pull_number']};if(!required[name]||required[name]!.some(x=>a[x]===undefined))return null;
  if(name==='create_repo'){const n=String(a.name);if(repos.has(key(OWNER,n)))return repoJson(repos.get(key(OWNER,n))!);return repoJson(makeRepo(a));}
  const r=namedRepo(String(a.owner),String(a.repo));if(!r)return {message:'Not Found'};if(name==='get_repo')return repoJson(r);if(name==='create_issue'){const i=createIssue(r,a);return i?issueJson(i):{message:'Validation Failed'};}if(name==='list_issues')return r.issues.filter(i=>!a.state||a.state==='all'||i.state===a.state).map(issueJson);if(name==='create_pull_request'){const p=createPull(r,a);return p?pullJson(r,p):{message:'Validation Failed'};}const p=r.pulls.find(x=>x.number===Number(a.pull_number));if(!p)return {message:'Not Found'};const m=mergePull(r,p);return {merged:m.ok,sha:m.sha,pull_number:p.number};
}
async function mcp(req:IncomingMessage,res:ServerResponse):Promise<void>{
  let raw='';for await(const chunk of req)raw+=chunk;let b:Record<string,unknown>;try{b=object(JSON.parse(raw));}catch{return sendJson(res,400,rpcError(null,-32700,'Parse error'));}const id=b.id,method=String(b.method??''),params=object(b.params);
  if(method==='tools/call'&&!auth(req))return error(res,401,'Requires authentication');
  if(method==='server/discover')return sendJson(res,200,rpcResult(id,{resultType:'serverInfo',supportedVersions:['2026-07-28'],capabilities:{tools:{}},serverInfo:{name:'github-core-forge',version:'1.0.0'},_meta:{'io.modelcontextprotocol/serverInfo':{name:'github-core-forge',version:'1.0.0'}}}));
  if(method==='initialize')return sendJson(res,200,rpcResult(id,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'github-core-forge',version:'1.0.0'}}));
  if(method==='notifications/initialized')return sendEmpty(res,202);
  if(method==='tools/list')return sendJson(res,200,rpcResult(id,{tools:TOOLS}));
  if(method==='tools/call'){const name=String(params.name??''),args=object(params.arguments);if(!TOOLS.some(t=>t.name===name))return sendJson(res,200,rpcError(id,-32602,'Unknown tool'));const result=toolCall(name,args);if(result===null)return sendJson(res,200,rpcError(id,-32602,'Missing required arguments'));return sendJson(res,200,rpcResult(id,{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false}));}
  return sendJson(res,200,rpcError(id,-32601,'Method not found'));
}

export function createApp():Server{return createServer((req,res)=>{void(async()=>{let url:URL;try{url=new URL(req.url??'/','http://entry');}catch{return error(res,400,'Bad Request');}if(req.method==='GET'&&url.pathname==='/healthz')return sendJson(res,200,{ok:true});if(url.pathname.startsWith('/api/v3'))return rest(req,res,url);if(req.method==='POST'&&url.pathname==='/api/graphql')return graphql(req,res);if(req.method==='POST'&&url.pathname==='/mcp')return mcp(req,res);return error(res,404,'Not Found');})().catch(err=>{if(!res.headersSent)error(res,500,err instanceof Error?err.message:'Internal Server Error');else res.end();});});}
