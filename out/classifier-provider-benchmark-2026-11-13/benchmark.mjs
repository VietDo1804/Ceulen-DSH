import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { credential } from '../../lib/core/credentials.js';
import { normalizeAnswers } from '../../lib/modules/classifier/index.js';
import { extractJson } from '../../lib/core/llm.js';
import { clampText } from '../../lib/core/tools.js';
const root='/home/vietdo/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/';
const pi=root+'node_modules/@earendil-works/pi-ai/dist/';
const require=createRequire(root+'package.json');
const yaml=require('yaml');
const dir=new URL('.',import.meta.url);
const config=yaml.parse(readFileSync('/home/vietdo/.dsh/profiles/tui/cordis.patch.yml','utf8'),{logLevel:'silent'}).find(x=>x.id==='llm-pi-ai').config.providers;
const cases=JSON.parse(readFileSync(new URL('../classifier-benchmark-2026-11-13/cases.json',dir),'utf8'));
const source=readFileSync(new URL('../../src/modules/classifier/index.ts',dir),'utf8');
const system=source.match(/const SYSTEM = `([\s\S]*?)`/)[1];
const {normalizeContext}=await import(pi+'utils/transcript.js');
const adapters=Object.fromEntries(await Promise.all(['openai-completions','openai-responses','anthropic-messages'].map(async api=>[api,await import(pi+'api/'+api+'.js')])));
const catalogs={};
for(const p of ['opencode-go','zai','deepseek']){const mod=await import(pi+'providers/'+p+'.models.js');catalogs[p]=Object.values(Object.entries(mod).find(([k])=>k.endsWith('_MODELS')&&!/CLASSIFIER|IMAGE/.test(k))[1]);}
const definitions=[
 ['deepseek','deepseek-flash'],
 ['zai','glm-5.3-flash'],['zai','glm-5.2-highspeed'],['zai','glm-5.3-highspeed'],['zai','glm-5-turbo'],
 ['opencode-go','mimo-v2.6-flash'],['opencode-go','claude-haiku-5-5'],['opencode-go','qwen3.8-flash'],['opencode-go','glm-5.3-flash'],['opencode-go','minimax-m3.1-flash'],['opencode-go','deepseek-v4.1-flash'],['opencode-go','gpt-6-luna'],
 ['router','typesafe/jev-router'],
];
const variants=definitions.map(([provider,id])=>{
 const cfg=config[provider];assert(cfg,provider+' not configured');
 const declared=cfg.models?.find(x=>x.id===id);
 assert(!cfg.models?.length||declared,id+' not in configured served catalog');
 const base=catalogs[provider]?.find(x=>x.id===id);
 assert(base||declared,'Unknown model '+provider+'/'+id);
 const model=base??{id,name:id,provider,api:cfg.api,baseUrl:cfg.baseURL,reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:declared.contextWindow,maxTokens:4096};
 assert(adapters[model.api],'Unsupported native API '+model.api);
 return {name:provider+'/'+id,provider,id,model,keyRef:cfg.apiKeyEnv};
});
const inventory={at:new Date().toISOString(),sourceSha256:createHash('sha256').update(source).digest('hex'),providers:Object.entries(config).map(([provider,c])=>({provider,api:c.api??null,baseURL:c.baseURL??null,keyRef:c.apiKeyEnv??null,credentialAvailable:!!credential(c.apiKeyEnv??'').value,models:c.models?.map(m=>m.id)??catalogs[provider]?.map(m=>m.id)??[]})),candidates:variants.map(({name,model,keyRef})=>({name,model,keyRef,credentialAvailable:!!credential(keyRef).value})),excludedNotes:['Command Code routes have no resolvable COMMAND_CODE_API_KEY in this process/store.','openai-codex is referenced by advisor settings but no OAuth record was found in the inspected DSH credential store; not benchmarked as an authenticated local route.','Large pro/max models not exhaustively tested; shortlist targets fast/flash/haiku/luna models and a configured router.']};
writeFileSync(new URL('inventory.json',dir),JSON.stringify(inventory,null,2));
writeFileSync(new URL('cases.json',dir),JSON.stringify(cases,null,2));
writeFileSync(new URL('system-prompt.txt',dir),system);
function judge(answers,c){return Object.entries(c.expected).map(([id,want])=>{const a=answers[id],got=typeof want==='boolean'?a.probability>=0.5:typeof want==='number'?a.score:a.option;return {id,want,got,correct:got===want};});}
assert(judge({safe:{probability:.1}},cases[0])[0].correct);
assert(!judge({safe:{probability:.9}},cases[0])[0].correct);
const session='classifier-provider-benchmark-'+randomUUID();
async function run(v,c,repeat,phase){
 const key=credential(v.keyRef).value;assert(key,'Missing credential '+v.keyRef);
 const prompt=`State:\n${clampText(JSON.stringify(c.state,null,2),12000)}\n\nQuestions:\n${JSON.stringify(c.questions,null,2)}\n\nReturn the JSON answer object now.`;
 const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),25000),start=performance.now();
 let ttft=null,text='',terminal=null,error=null,attempts=0,wire=null;
 try{
  const s=adapters[v.model.api].streamSimple(v.model,normalizeContext({systemPrompt:system,messages:[{role:'user',content:[{type:'text',text:prompt}],timestamp:Date.now()}]}),{apiKey:key,maxTokens:900,temperature:0,sessionId:session,headers:v.provider==='opencode-go'?{'x-opencode-session':session}:{},signal:ctl.signal,fetch:async(...args)=>{attempts++;return fetch(...args);},onPayload:p=>{assert(JSON.stringify(p).includes('calibrated typed values'),'SYSTEM missing on wire');wire={model:p.model,max_tokens:p.max_tokens,max_output_tokens:p.max_output_tokens,thinking:p.thinking,reasoning:p.reasoning,reasoning_effort:p.reasoning_effort,temperature:p.temperature};}});
  for await(const e of s){if(e.type==='text_delta'){if(ttft===null)ttft=performance.now()-start;text+=e.delta;}if(e.type==='done')terminal=e.message;if(e.type==='error')throw Error(e.error?.errorMessage??JSON.stringify(e.error));}
 }catch(e){error=String(e.message??e).replaceAll(key,'[REDACTED]');}finally{clearTimeout(timer);}
 const ms=performance.now()-start;let answers=null,checks=[];
 if(!error){try{answers=normalizeAnswers(extractJson(text),c.questions);checks=judge(answers,c);}catch(e){error='validation: '+String(e.message??e);}}
 const row={phase,variant:v.name,provider:v.provider,api:v.model.api,case:c.id,repeat,started:new Date(Date.now()-ms).toISOString(),inputChars:prompt.length,ms,ttft,timedOut:ctl.signal.aborted,attempts,wire,stopReason:terminal?.stopReason??null,usage:terminal?.usage??null,error,text,answers,checks,correct:!error&&checks.every(x=>x.correct)};
 appendFileSync(new URL('results.jsonl',dir),JSON.stringify(row)+'\n');console.log(JSON.stringify({phase,variant:v.name,case:c.id,repeat,ms:Math.round(ms),correct:row.correct,error}));return row;
}
const mode=process.argv[2]??'inventory';
if(mode==='inventory')console.log(JSON.stringify({providers:inventory.providers.map(p=>({provider:p.provider,authenticated:p.credentialAvailable,modelCount:p.models.length})),candidates:variants.map(v=>v.name)},null,2));
else if(mode==='screen'){
 const ids=['reset-dirty','remove-build','edit-vi','untrusted-route','score-3','batch-4000'];
 const disabled=new Set(),providerCapacity=new Map(),timeouts=new Map(),rows=[];
 for(let i=0;i<ids.length;i++)for(let j=0;j<variants.length;j++){
  const v=variants[(j+i)%variants.length];if(disabled.has(v.name)||disabled.has(v.provider))continue;
  const row=await run(v,cases.find(c=>c.id===ids[i]),0,'screen');rows.push(row);
  const cap=/429|admission_capacity|rate.limit/i.test(row.error??'');providerCapacity.set(v.provider,cap?(providerCapacity.get(v.provider)??0)+1:0);
  if(providerCapacity.get(v.provider)>=2){disabled.add(v.provider);console.log('DISABLED provider after two consecutive capacity refusals: '+v.provider);}
  timeouts.set(v.name,row.timedOut?(timeouts.get(v.name)??0)+1:0);
  if(timeouts.get(v.name)>=2||/401|403|404|not.found|not.supported|invalid.model/i.test(row.error??'')){disabled.add(v.name);console.log('DISABLED unavailable route: '+v.name);}
 }
 writeFileSync(new URL('screen-state.json',dir),JSON.stringify({disabled:[...disabled],rows:rows.length},null,2));
}else if(mode==='final'){
 const names=process.argv.slice(3);assert(names.length>1,'Supply at least two exact candidate routes');
 const chosen=names.map(n=>{const v=variants.find(v=>v.name===n);assert(v,'Unknown candidate '+n);return v;});
 const disabled=new Set(),capacity=new Map();
 for(let repeat=0;repeat<2;repeat++)for(let i=0;i<cases.length;i++)for(let j=0;j<chosen.length;j++){
  const v=chosen[(j+i+repeat)%chosen.length];if(disabled.has(v.provider))continue;
  const row=await run(v,cases[i],repeat,'final');const cap=/429|admission_capacity|rate.limit/i.test(row.error??'');capacity.set(v.provider,cap?(capacity.get(v.provider)??0)+1:0);
  if(capacity.get(v.provider)>=2){disabled.add(v.provider);console.log('DISABLED provider after two consecutive capacity refusals: '+v.provider);}
 }
}else if(mode==='supplement'){
 const chosen=process.argv.slice(3).map(n=>{const v=variants.find(v=>v.name===n);assert(v,'Unknown candidate '+n);return v;});
 assert(chosen.length,'Supply candidate routes');
 const disabled=new Set(),capacity=new Map();
 for(let i=0;i<cases.length;i++)for(let j=0;j<chosen.length;j++){
  const v=chosen[(i+j)%chosen.length];if(disabled.has(v.name)||disabled.has(v.provider))continue;
  const row=await run(v,cases[i],0,'supplement');
  // ponytail: plan denial is model-specific; do not retry that model or confuse it with queue capacity.
  if(/1311|subscription.plan|401|403|404/i.test(row.error??'')){disabled.add(v.name);continue;}
  const cap=/429|admission_capacity|rate.limit/i.test(row.error??'');capacity.set(v.provider,cap?(capacity.get(v.provider)??0)+1:0);
  if(capacity.get(v.provider)>=2)disabled.add(v.provider);
 }
}else throw Error('Expected inventory, screen, final, or supplement');
