import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const dir=new URL('.',import.meta.url),phase=process.argv[2]??'final';
const all=readFileSync(new URL('results.jsonl',dir),'utf8').trim().split('\n').map(JSON.parse),rows=all.filter(r=>r.phase===phase);
const cases=JSON.parse(readFileSync(new URL('cases.json',dir),'utf8'));
const groups=Object.fromEntries(cases.map(c=>[c.id,c.questions.length>1?'batch':c.questions[0].type]));
function q(a,p){if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),i=(b.length-1)*p;return b[Math.floor(i)]+(b[Math.ceil(i)]-b[Math.floor(i)])*(i%1);}
assert.equal(q([1,2,3,4],.5),2.5);
function stats(a){return a.length?{n:a.length,min:Math.min(...a),p50:q(a,.5),p90:q(a,.9),p95:q(a,.95),max:Math.max(...a),mean:a.reduce((s,x)=>s+x,0)/a.length}:null;}
function summarize(a){
 const valid=a.filter(r=>!r.error),checks=a.flatMap(r=>r.checks);
 const expected=a.reduce((s,r)=>s+Object.keys(cases.find(c=>c.id===r.case).expected).length,0);
 const unsafe=valid.flatMap(r=>r.checks.filter(c=>c.id==='safe'&&c.want===false));
 return {n:a.length,valid:valid.length,correct:a.filter(r=>r.correct).length,questionCorrect:checks.filter(c=>c.correct).length,questionExpected:expected,latency:stats(a.map(r=>r.ms)),successfulLatency:stats(valid.map(r=>r.ms)),ttft:stats(a.filter(r=>r.ttft!==null).map(r=>r.ttft)),timeouts:a.filter(r=>r.timedOut).length,capacity429:a.filter(r=>/429|admission_capacity/i.test(r.error??'')).length,schemaErrors:a.filter(r=>r.error?.startsWith('validation:')).length,budgetStops:a.filter(r=>['length','max-tokens'].includes(r.stopReason)).length,under2s:a.filter(r=>r.correct&&r.ms<2000).length,under5s:a.filter(r=>r.correct&&r.ms<5000).length,under10s:a.filter(r=>r.correct&&r.ms<10000).length,unsafeAllow:unsafe.filter(c=>c.got===true).length,unsafeAnswered:unsafe.length,attempts:a.reduce((s,r)=>s+r.attempts,0),errors:a.filter(r=>r.error).map(r=>({case:r.case,repeat:r.repeat,error:r.error,ms:r.ms,stopReason:r.stopReason})),wrong:a.filter(r=>!r.error&&!r.correct).map(r=>({case:r.case,repeat:r.repeat,checks:r.checks,answers:r.answers})),byGroup:Object.fromEntries(['noul','choice','score','batch'].map(g=>{const sub=a.filter(r=>groups[r.case]===g);return [g,{n:sub.length,valid:sub.filter(r=>!r.error).length,correct:sub.filter(r=>r.correct).length,p50:q(sub.map(r=>r.ms),.5),p95:q(sub.map(r=>r.ms),.95)}];})),byRepeat:Object.fromEntries([...new Set(a.map(r=>r.repeat))].map(i=>{const sub=a.filter(r=>r.repeat===i);return [i,{n:sub.length,correct:sub.filter(r=>r.correct).length,p50:q(sub.map(r=>r.ms),.5)}];})),wire:a[0]?.wire??null,tokens:{input:a.reduce((s,r)=>s+(r.usage?.input??0),0),cacheRead:a.reduce((s,r)=>s+(r.usage?.cacheRead??0),0),output:a.reduce((s,r)=>s+(r.usage?.output??0),0),reasoning:a.reduce((s,r)=>s+(r.usage?.reasoning??0),0)},catalogCost:a.reduce((s,r)=>s+(r.usage?.cost?.total??0),0)};
}
assert.equal(new Set(rows.map(r=>[r.variant,r.case,r.repeat].join('/'))).size,rows.length,'Duplicate samples in phase');
const variants=[...new Set(rows.map(r=>r.variant))];
const summary={phase,generatedAt:new Date().toISOString(),n:rows.length,variants:Object.fromEntries(variants.map(v=>[v,summarize(rows.filter(r=>r.variant===v))]))};
const baseline='opencode-go/mimo-v2.6-flash';
summary.pairedAgainstMimo=Object.fromEntries(variants.filter(v=>v!==baseline).map(v=>{const pairs=rows.filter(r=>r.variant===v).map(a=>({a,b:rows.find(b=>b.variant===baseline&&b.case===a.case&&b.repeat===a.repeat)})).filter(p=>p.b);return [v,{n:pairs.length,faster:pairs.filter(p=>p.a.ms<p.b.ms).length,medianMimoMinusCandidateMs:q(pairs.map(p=>p.b.ms-p.a.ms),.5),medianMimoOverCandidate:q(pairs.map(p=>p.b.ms/p.a.ms),.5)}];}));
writeFileSync(new URL(phase+'-summary.json',dir),JSON.stringify(summary,null,2));
console.log(JSON.stringify({phase,n:rows.length,table:Object.entries(summary.variants).map(([route,v])=>({route,n:v.n,correct:v.correct,p50:Math.round(v.latency.p50),p95:Math.round(v.latency.p95),ttft:v.ttft?Math.round(v.ttft.p50):null,under2s:v.under2s,under5s:v.under5s,timeouts:v.timeouts,capacity429:v.capacity429,schemaErrors:v.schemaErrors,unsafeAllow:v.unsafeAllow,wrong:v.wrong})),paired:summary.pairedAgainstMimo},null,2));
