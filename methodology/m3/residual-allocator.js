import {solveContinuousFunding} from '../../F8_CORE/qualifying/linear-program.js';
import {MethodologyBlocked} from '../m1/valuation.js';
import {DECISION_EPS,RECONCILIATION_EPS} from '../shared/numerical-contract.js';

const fail=m=>{throw new MethodologyBlocked(m)};
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x)}return x};
const number=(v,label)=>{if(typeof v!=='number'||!Number.isFinite(v))fail(`${label} finite number required`);return v};

/** Continuous piecewise-linear frontier. Breakpoints must be actual quoted
 * economic kinks, not an optimizer grid. Unsupported non-concave curves block. */
export function allocateUnifiedResidual(raw) {
  const d=structuredClone(raw);
  if(d?.schemaVersion!=='F8_UNIFIED_RESIDUAL_V1'||!d.asOfDate||!d.ownerId||
    !d.currency||!Array.isArray(d.sources)||!d.sources.length||
    !Array.isArray(d.offers)||!d.offers.length||!Array.isArray(d.destinationCaps))
    fail('dated residual frontier required');
  for(const k of ['memberDeathAge','spouseDeathAge','deathSlider','disabilityAge'])
    if(Object.hasOwn(d,k))fail('scenario slider cannot enter ex-ante allocation');
  const sourceMap=new Map();
  for(const s of d.sources){
    if(!s.id||!s.economicPathId||sourceMap.has(s.id)||s.ownerId!==d.ownerId||
      s.asOfDate!==d.asOfDate||s.currency!==d.currency||number(s.amount,'source amount')<0)
      fail('unique owned dated source required');
    sourceMap.set(s.id,s);
  }
  const capMap=new Map();
  for(const c of d.destinationCaps){
    if(!c.destinationId||capMap.has(c.destinationId)||number(c.maximum,'destination cap')<0)
      fail('unique shared destination capacity required');
    capMap.set(c.destinationId,c.maximum);
  }
  const segments=[],offers=new Set();
  const priority={RESIDUAL:0,ROTATION:1,QUALIFYING:2,OPTIONAL_ANNUITIZATION:3,SERVICE_SOURCE:4};
  const orderedOffers=[...d.offers].sort((a,b)=>String(a.sourceId).localeCompare(String(b.sourceId))||((priority[a.actionType]??50)-(priority[b.actionType]??50))||String(a.destinationId).localeCompare(String(b.destinationId))||String(a.entryRoute).localeCompare(String(b.entryRoute))||String(a.valueStreamId??'').localeCompare(String(b.valueStreamId??'')));
  for(const offer of orderedOffers){
    const source=sourceMap.get(offer.sourceId),key=`${offer.sourceId}|${offer.destinationId}`;
    if(!source||!capMap.has(offer.destinationId)||offers.has(key)||
       !offer.entryRoute||!offer.provenance?.version||
       !Array.isArray(offer.quotes)||offer.quotes.length<2)
      fail('complete unique destination quote required');
    offers.add(key);
    if(offer.destinationId===`stay:${source.id}` && offer.entryRoute!=='STAY')
      fail('existing wrapper retention must use STAY');
    let previousCapital=0,previousValue=0,previousSlope=Infinity;
    const first=offer.quotes[0];
    if(first.capital!==0||first.netFamilyValue!==0)fail('zero quote must anchor value');
    for(const q of offer.quotes.slice(1)){
      const x=number(q.capital,'quoted capital'),y=number(q.netFamilyValue,'net family value');
      if(x<=previousCapital||x>source.amount+1e-8)fail('quoted breakpoints outside source supply');
      const slope=(y-previousValue)/(x-previousCapital);
      if(slope>previousSlope+1e-10)fail('unsupported non-concave offer; no false global certificate');
      segments.push({sourceId:source.id,originPathId:source.economicPathId,
        destinationId:offer.destinationId,entryRoute:offer.entryRoute,
        quotedFrom:previousCapital,quotedTo:x,capacity:x-previousCapital,
        marginalNetFamilyValue:slope,provenance:offer.provenance});
      previousCapital=x;previousValue=y;previousSlope=slope;
    }
    if(offer.destinationId===`stay:${source.id}` &&
       Math.abs(previousCapital-source.amount)>1e-8)
      fail('safe retention offer must cover entire source');
  }
  for(const s of d.sources)
    if(!offers.has(`${s.id}|stay:${s.id}`))fail('every source needs its explicit stay frontier');
  const lowest=Math.min(...segments.map(s=>s.marginalNetFamilyValue));
  // A common source-independent offset forces full conservation in a <= simplex.
  // It cancels from every complete allocation; it is not an economic value.
  const offset=Math.max(0,-lowest)+1;
  const limits=[],coefficients=[];
  for(const s of d.sources){limits.push(s.amount);coefficients.push(segments.map(x=>x.sourceId===s.id?1:0))}
  for(const [dest,max] of capMap){limits.push(max);coefficients.push(segments.map(x=>x.destinationId===dest?1:0))}
  for(let i=0;i<segments.length;i++){limits.push(segments[i].capacity);
    coefficients.push(segments.map((_,j)=>i===j?1:0))}
  const solution=solveContinuousFunding({coefficients,limits,
    objectives:segments.map(x=>x.marginalNetFamilyValue+offset)});
  // One numerical-zero contract: amounts at/below DECISION_EPS receive no economic
  // credit in the returned solver-facing plan. Any dropped dust is conserved by the
  // canonical stay path, so downstream materialization never sees value disappear.
  const normalizedAmounts=solution.amounts.map(x=>x>DECISION_EPS?x:0);
  for(const source of d.sources){
    const used=segments.reduce((n,s,i)=>n+(s.sourceId===source.id?normalizedAmounts[i]:0),0),dust=source.amount-used;
    if(dust>0&&dust<=DECISION_EPS+1e-12){
      const candidates=segments.map((s,i)=>({s,i})).filter(x=>x.s.sourceId===source.id&&x.s.destinationId===`stay:${source.id}`&&normalizedAmounts[x.i]+dust<=x.s.capacity+1e-12);
      // If every stay segment is already full, the residual can only be floating-point
      // summation noise rather than a dropped economic decision. Reconciliation tolerance
      // handles that separately from the decision-zero threshold.
      if(!candidates.length){if(dust<=RECONCILIATION_EPS)continue;fail('decision-zero dust cannot be conserved on canonical stay path')}
      const chosen=candidates.find(x=>normalizedAmounts[x.i]>0)??candidates[0];normalizedAmounts[chosen.i]+=dust;
    }
  }
  const bySource=d.sources.map(s=>({sourceId:s.id,originPathId:s.economicPathId,
    openingAmount:s.amount,allocated:0,unallocated:0}));
  const allocations=segments.flatMap((s,i)=>normalizedAmounts[i]>DECISION_EPS?
    [{...s,amount:normalizedAmounts[i],netFamilyValue:normalizedAmounts[i]*s.marginalNetFamilyValue}]:[]);
  for(const row of bySource){row.allocated=allocations.filter(a=>a.sourceId===row.sourceId)
    .reduce((sum,a)=>sum+a.amount,0);row.unallocated=row.openingAmount-row.allocated;
    if(Math.abs(row.unallocated)>1e-7)fail('residual capital did not retain a path')}
  return freeze({schemaVersion:'F8_UNIFIED_RESIDUAL_PLAN_V1',asOfDate:d.asOfDate,
    sources:bySource,allocations,frontier:segments,
    expectedNetFamilyValue:allocations.reduce((sum,a)=>sum+a.netFamilyValue,0),
    totalCapital:d.sources.reduce((sum,s)=>sum+s.amount,0),
    pathAllocationGap:bySource.reduce((sum,s)=>sum+s.unallocated,0),
    globalCertificate:'PIECEWISE_CONCAVE_LP_ONLY',productionVerified:false});
}
