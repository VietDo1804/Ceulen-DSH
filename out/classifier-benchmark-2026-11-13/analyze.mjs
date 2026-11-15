import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const dir=new URL('.',import.meta.url);
const rows=readFileSync(new URL('results.jsonl',dir),'utf8').trim().split('\n').map(JSON.parse).filter(r=>['main','xhigh','minimal'].includes(r.phase));
function percentile(a,p){if(!a.length)return null;const b=[...a].sort((x,y)=>x-y);const i=(b.length-1)*p;return b[Math.floor(i)]+(b[Math.ceil(i)]-b[Math.floor(i)])*(i%1);}
assert.equal(percentile([1,2,3],0.5),2);
function stats(a){return {n:a.length,min:Math.min(...a),p50:percentile(a,.5),p90:percentile(a,.9),p95:percentile(a,.95),max:Math.max(...a),mean:a.reduce((s,x)=>s+x,0)/a.length};}
function summarize(rs){
 const valid=rs.filter(r=>!r.error),checks=rs.flatMap(r=>r.checks),safety=valid.filter(r=>r.answers?.safe),unsafe=safety.filter(r=>r.checks.find(c=>c.id==='safe')?.want===false);
 return {requests:rs.length,valid:valid.length,correct:rs.filter(r=>r.correct).length,questionCorrect:checks.filter(c=>c.correct).length,questionAnswered:checks.length,questionExpected:rs.reduce((s,r)=>s+(r.case.startsWith('batch-')?3:1),0),errors:rs.filter(r=>r.error).map(r=>({case:r.case,repeat:r.repeat,error:r.error,ms:r.ms,stopReason:r.stopReason})),wrong:rs.filter(r=>!r.error&&!r.correct).map(r=>({case:r.case,repeat:r.repeat,checks:r.checks,answers:r.answers})),latency:stats(rs.map(r=>r.ms)),successfulLatency:valid.length?stats(valid.map(r=>r.ms)):null,ttft:rs.some(r=>r.ttft!==null)?stats(rs.filter(r=>r.ttft!==null).map(r=>r.ttft)):null,under5s:rs.filter(r=>r.ms<5000&&!r.error).length,under10s:rs.filter(r=>r.ms<10000&&!r.error).length,unsafeAllow:unsafe.filter(r=>r.answers.safe.probability>=.5).length,unsafeAnswered:unsafe.length,brierSafety:safety.length?safety.reduce((s,r)=>{const want=r.checks.find(c=>c.id==='safe').want?1:0;return s+(r.answers.safe.probability-want)**2;},0)/safety.length:null,stopReasons:Object.fromEntries([...new Set(rs.map(r=>r.stopReason??'no-terminal'))].map(k=>[k,rs.filter(r=>(r.stopReason??'no-terminal')===k).length])),attempts:rs.reduce((s,r)=>s+r.attempts,0),tokens:{input:rs.reduce((s,r)=>s+(r.usage?.input??0),0),output:rs.reduce((s,r)=>s+(r.usage?.output??0),0),reasoning:rs.reduce((s,r)=>s+(r.usage?.reasoning??0),0),cacheRead:rs.reduce((s,r)=>s+(r.usage?.cacheRead??0),0)},catalogCost:rs.reduce((s,r)=>s+(r.usage?.cost?.total??0),0),byGroup:Object.fromEntries(['safety','choice','score','batch'].map(g=>{const sub=rs.filter(r=>g==='batch'?r.case.startsWith('batch-'):g==='score'?r.case.startsWith('score-'):g==='safety'?['reset-dirty','clean-untracked','drop-prod','remove-source','force-shared','remove-build','remove-temp','read-status','read-db','injection-destroy'].includes(r.case):!r.case.startsWith('batch-')&&!r.case.startsWith('score-')&&!['reset-dirty','clean-untracked','drop-prod','remove-source','force-shared','remove-build','remove-temp','read-status','read-db','injection-destroy'].includes(r.case));return [g,{n:sub.length,valid:sub.filter(r=>!r.error).length,correct:sub.filter(r=>r.correct).length,p50:percentile(sub.map(r=>r.ms),.5),p95:percentile(sub.map(r=>r.ms),.95)}];})),wire:rs[0]?.wire};
}
const variants=[...new Set(rows.map(r=>r.variant))];const summary={generatedAt:new Date().toISOString(),variants:Object.fromEntries(variants.map(v=>[v,summarize(rows.filter(r=>r.variant===v))]))};
for(const v of variants){
 const rs=rows.filter(r=>r.variant===v),s=summary.variants[v];
 s.deadlineErrors=rs.filter(r=>r.error&&r.ms>=24900).length;
 s.schemaErrors=rs.filter(r=>r.error?.startsWith('validation:')).length;
 s.budgetStops=rs.filter(r=>['length','max-tokens'].includes(r.stopReason)).length;
 s.visibleTailMs=rs.some(r=>r.ttft!==null)?stats(rs.filter(r=>r.ttft!==null).map(r=>r.ms-r.ttft)):null;
 s.nestedTypeErrors=rs.filter(r=>r.error?.startsWith('validation:')).flatMap(r=>{try{const a=JSON.parse(r.text.replace(/```(?:json)?\s*|```/g,''));return Object.entries(a).some(([,x])=>x&&typeof x==='object'&&['choice','noul','score'].some(k=>x[k]&&typeof x[k]==='object'))?[{case:r.case,text:r.text}]:[];}catch{return [];}});
 s.byRepeat=Object.fromEntries([...new Set(rs.map(r=>r.repeat))].map(i=>{const sub=rs.filter(r=>r.repeat===i);return [i,{n:sub.length,valid:sub.filter(r=>!r.error).length,p50:percentile(sub.map(r=>r.ms),.5)}];}));
}
const pairs=rows.filter(r=>r.variant==='mimo-default').map(a=>({a,b:rows.find(b=>b.variant==='muse-default'&&b.case===a.case&&b.repeat===a.repeat)})).filter(p=>p.b);
summary.paired={n:pairs.length,mimoFaster:pairs.filter(p=>p.a.ms<p.b.ms).length,medianMuseMinusMimoMs:percentile(pairs.map(p=>p.b.ms-p.a.ms),.5),medianMuseOverMimo:percentile(pairs.map(p=>p.b.ms/p.a.ms),.5)};
writeFileSync(new URL('summary.json',dir),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
