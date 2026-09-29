import {MethodologyBlocked} from '../m1/valuation.js';
const fail=m=>{throw new MethodologyBlocked(m)};
const cloneFreeze=x=>{const y=structuredClone(x);const f=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(f);Object.freeze(v)}return v};return f(y)};
const date=s=>{if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s)||
  !Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)
  fail('exact mortality event date required');return s};
const mass=(rows,label)=>{if(!Array.isArray(rows)||!rows.length)fail(`${label} distribution required`);
 let sum=0,terminal=false;const ids=new Set();for(const r of rows){
  if(!r.id||ids.has(r.id)||!['DEATH','SURVIVE_TO_TERMINAL_HORIZON'].includes(r.kind)||
    typeof r.probability!=='number'||!Number.isFinite(r.probability)||
    r.probability<0||r.probability>1)fail(`${label} branch invalid`);
  ids.add(r.id);date(r.kind==='DEATH'?r.deathDate:r.terminalDate);
  if(r.kind==='SURVIVE_TO_TERMINAL_HORIZON')terminal=true;
  sum+=r.probability;
 }if(Math.abs(sum-1)>1e-10||!terminal)fail(`${label} mass/terminal continuation incomplete`)};

/** Explicit independence is the V1 assumption, not an inferred relationship.
 * No death-age slider enters this ex-ante state space. */
export function createJointMortality(raw){
 const x=structuredClone(raw);
 if(x?.schemaVersion!=='F8_JOINT_MORTALITY_V1'||x.assumption!=='INDEPENDENT_V1'||
   !x.version||!Array.isArray(x.member)||!Array.isArray(x.spouse))
   fail('explicit versioned joint mortality assumption required');
 for(const f of ['memberDeathAge','spouseDeathAge','deathSlider'])
   if(Object.hasOwn(x,f))fail('scenario slider forbidden in mortality distribution');
 mass(x.member,'member');mass(x.spouse,'spouse');
 const branches=[];
 for(const m of x.member)for(const s of x.spouse){
   if(m.kind==='DEATH'&&s.kind==='SURVIVE_TO_TERMINAL_HORIZON'&&
      s.terminalDate<m.deathDate)
     fail('spouse terminal observation ends before member death');
   if(m.kind==='DEATH'&&s.kind==='DEATH'&&m.deathDate===s.deathDate)
     fail('same-day joint deaths require explicit ordering/contract rule');
   branches.push({id:`${m.id}|${s.id}`,member:m,spouse:s,
     probability:m.probability*s.probability,
     spouseAliveAtMemberDeath:m.kind==='DEATH'&&
       (s.kind==='SURVIVE_TO_TERMINAL_HORIZON'||s.deathDate>m.deathDate),
     spousePredeceasedMember:m.kind==='DEATH'&&s.kind==='DEATH'&&s.deathDate<m.deathDate,
     continuationRequired:m.kind==='SURVIVE_TO_TERMINAL_HORIZON'||
       s.kind==='SURVIVE_TO_TERMINAL_HORIZON'});
 }
 const total=branches.reduce((n,b)=>n+b.probability,0);
 if(Math.abs(total-1)>1e-10)fail('joint probability mass not closed');
 return cloneFreeze({schemaVersion:'F8_JOINT_MORTALITY_DISTRIBUTION_V1',
   version:x.version,assumption:x.assumption,probabilityMass:total,branches,
   dependenceSensitivity:'PENDING_VALUED_CONTRACT_OPTIONS',productionVerified:false});
}
