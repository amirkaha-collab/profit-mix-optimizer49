import {MethodologyBlocked} from '../m1/valuation.js';
const fail=m=>{throw new MethodologyBlocked(m)};
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x)}return x};
const finite=(v,name)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<0)fail(`nonnegative ${name} required`);return v};
const date=s=>{if(typeof s!=='string'||!/\d{4}-\d{2}-\d{2}/.test(s)||
  !Number.isFinite(Date.parse(`${s}T00:00:00Z`))||new Date(`${s}T00:00:00Z`).toISOString().slice(0,10)!==s)
  fail('exact contract date required');return s};

/** The discrete outer contract menu. Returns entitlements only: valuation and
 * continuous allocation must be supplied by M9/M10 before selecting a winner. */
export function enumerateContractMenu(raw){
  const d=structuredClone(raw);
  if(d?.schemaVersion!=='F8_CONTRACT_MENU_V1'||!d.personId||
     !['SYNTHETIC_TEST_ONLY','WORKING_QA'].includes(d.mode)||
     !Array.isArray(d.options)||!Array.isArray(d.coverageStates)||
     !d.options.length||!d.coverageStates.length)fail('explicit contractual menu required');
  for(const f of ['memberDeathAge','spouseDeathAge','deathSlider'])
    if(Object.hasOwn(d,f))fail('slider cannot select contract option');
  const options=new Set(),states=new Set(),feasible=[];
  for(const s of d.coverageStates){
    if(!s.id||states.has(s.id)||typeof s.spouseAlive!=='boolean'||
       !Array.isArray(s.requiredService))fail('distinct observable spouse state required');
    states.add(s.id);
    for(const r of s.requiredService){date(r.date);finite(r.net,'spouse protection floor')}
  }
  for(const o of d.options){
    if(!o.id||options.has(o.id)||!o.contractId||!o.entryRoute||
       !o.provenance?.version||!Array.isArray(o.entitlements)||
       !o.entitlements.length||!Number.isInteger(o.guaranteeMonths)||o.guaranteeMonths<0||
       !o.commencementDate||!o.annuityFactorId)fail('explicit contractual option required');
    options.add(o.id);date(o.commencementDate);finite(o.survivorPercent,'survivor percent');
    if(o.survivorPercent>1)fail('survivor share exceeds whole');
    const keys=new Set();
    for(const e of o.entitlements){
      date(e.date);
      const k=`${e.coverageStateId}|${e.date}|${e.recipient}|${e.rightId}`;
      if(!states.has(e.coverageStateId)||!['member','spouse','heirs'].includes(e.recipient)||
         !e.rightId||!e.ruleId||keys.has(k))fail('provenanced distinct right entitlement required');
      keys.add(k);finite(e.gross,'gross entitlement');
      if(!e.provenance?.version)fail('dated entitlement provenance required');
    }
    let allowed=true;
    for(const s of d.coverageStates){
      for(const r of s.requiredService){
        const net=o.entitlements.filter(e=>e.coverageStateId===s.id&&e.date===r.date&&e.recipient==='spouse')
          .reduce((n,e)=>n+(e.netQuote??0),0);
        if(o.entitlements.some(e=>e.coverageStateId===s.id&&e.date===r.date&&
            e.recipient==='spouse'&&e.netQuote===undefined))
          fail('spouse service floor needs explicit net quote');
        if(net+1e-8<r.net)allowed=false;
      }
    }
    if(allowed)feasible.push(o);
  }
  if(d.lockEvent){
    if(d.lockEvent.type!=='SERVICE_SOURCE_LOCKED'||!options.has(d.lockEvent.contractOptionId))
      fail('fixed contract requires explicit lock');
    const locked=feasible.filter(o=>o.id===d.lockEvent.contractOptionId);
    if(!locked.length)fail('locked option violates protection constraints');
    return freeze({schemaVersion:'F8_CONTRACT_MENU_ENUMERATION_V1',
      candidates:locked,excludedOptionIds:d.options.filter(o=>o.id!==locked[0].id).map(o=>o.id),
      globalOptimal:false,requiresJointValuation:true});
  }
  return freeze({schemaVersion:'F8_CONTRACT_MENU_ENUMERATION_V1',candidates:feasible,
    excludedOptionIds:d.options.filter(o=>!feasible.includes(o)).map(o=>o.id),
    globalOptimal:false,requiresJointValuation:true});
}
