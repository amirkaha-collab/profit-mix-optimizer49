import crypto from 'node:crypto';
import {evaluateQualifyingPolicy} from '../m5/qualifying-replay.js';
import {evaluateServiceAllocation} from '../m6/service-source.js';
import {enumerateContractMenu} from '../m7/contract-options.js';
import {replayContingentReceipt} from '../m8/contingent-receipts.js';
import {createJointMortality} from '../m9/joint-mortality.js';
import {normalizeValuationConvention,normalizeMoneyValue,MethodologyBlocked} from '../m1/valuation.js';
import {optimizeJointGlobal,optimizeJointGlobalControlledLive} from '../m10/joint-global-allocator.js';
import {validateVerifiedRuntimeEnvelope} from '../../l1/f8-l1-readiness.js';
import {assertNoQaLegacyEvidence} from '../../l2/f8-verified-runtime-envelope.js';
import {RightsLedger} from '../../F8_CORE/src/ledgers.js';
import {getNativeAnnuitizationFrontierCompilerPayload} from '../m8/native-annuitization-frontier.js';
import {DECISION_EPS} from '../shared/numerical-contract.js';

const EPS=1e-8;
const fail=m=>{throw new MethodologyBlocked(m)};
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x)}return x};
const cloneFreeze=x=>freeze(structuredClone(x));
const finite=(n,label)=>{if(typeof n!=='number'||!Number.isFinite(n)||n<0)fail(`${label} must be finite nonnegative`);return n};
const iso=s=>{if(typeof s!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)||Number.isNaN(Date.parse(`${s}T00:00:00Z`))||new Date(`${s}T00:00:00Z`).toISOString().slice(0,10)!==s)fail('exact ISO date required');return s};
const branchEnd=b=>b.member.kind==='DEATH'?b.member.deathDate:b.member.terminalDate;
const memberEnd=m=>m.kind==='DEATH'?m.deathDate:m.terminalDate;
const stable=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const hash=v=>crypto.createHash('sha256').update(stable(v)).digest('hex');
const near=(a,b)=>Math.abs(a-b)<=Math.max(1e-8,Math.max(Math.abs(a),Math.abs(b))*1e-9);

const frontierMeta=new WeakMap(),contractMeta=new WeakMap(),serviceMeta=new WeakMap();

function jointContext(raw){
  const joint=createJointMortality(raw.jointMortality),convention=normalizeValuationConvention(raw.valuationConvention);
  if(convention.baseDate!==raw.asOfDate)fail('integration base date must equal valuation base date');
  return {joint,convention};
}
function familyValue(amount,date,convention,currency,productId){return {amount,valuationDate:date,moneyBasis:convention.moneyBasis,taxStatus:'NET',ownerId:'family',productId,currency}}
function zeroScenarioValues(joint,convention,currency,productId){return joint.branches.map(b=>({branchId:b.id,familyValue:familyValue(0,branchEnd(b),convention,currency,productId)}))}
function assertCompleteScenarioValues(rows,joint,convention,currency,label){
  if(!Array.isArray(rows)||rows.length!==joint.branches.length)fail(`${label}: complete joint branch values required`);
  const map=new Map();
  for(const row of rows){if(!row?.branchId||map.has(row.branchId))fail(`${label}: duplicate/missing branch id`);const m=normalizeMoneyValue(row.familyValue);if(m.valuationDate!==branchEnd(joint.branches.find(b=>b.id===row.branchId)??{})||m.moneyBasis!==convention.moneyBasis||m.taxStatus!=='NET'||m.currency!==currency)fail(`${label}: branch value basis mismatch`);map.set(row.branchId,row)}
  for(const b of joint.branches)if(!map.has(b.id))fail(`${label}: missing branch ${b.id}`);
  return map;
}
function sourceFingerprint(source){
  if(!source?.id||!source.economicPathId||!source.ownerId||!source.currency||!source.asOfDate)fail('canonical dated source required');
  finite(source.amount,'source amount');return hash({id:source.id,economicPathId:source.economicPathId,ownerId:source.ownerId,currency:source.currency,asOfDate:source.asOfDate,amount:source.amount,basisNominal:source.basisNominal??null,basisIndexed:source.basisIndexed??null,sourceEventId:source.sourceEventId??null,wrapper:source.wrapper??null});
}
function makeEvidence(publicData,meta){const e=cloneFreeze(publicData);frontierMeta.set(e,meta);return e}
function evidenceMeta(e){const m=frontierMeta.get(e);if(!m)fail('unbranded strategy frontier evidence');return m}

/** Strict scenario-valued frontier for modules whose current isolated evaluator is not yet M1/M9-native.
 * It remains WORKING_QA/SYNTHETIC evidence only and can never itself confer production readiness. */
export function buildScenarioFrontierEvidence(raw){
  const d=structuredClone(raw);
  if(d?.schemaVersion!=='F8_SCENARIO_FRONTIER_EVIDENCE_V1'||!['SYNTHETIC_TEST_ONLY','WORKING_QA'].includes(d.mode)||!['RESIDUAL','ROTATION','OPTIONAL_ANNUITIZATION','OTHER'].includes(d.actionType)||!d.source||!d.destinationId||!d.entryRoute||!d.provenance?.version||!Array.isArray(d.quotes)||d.quotes.length<2)fail('complete scenario frontier evidence required');
  const {joint,convention}=jointContext(d);const fp=sourceFingerprint(d.source);
  let prior=-Infinity;
  const quotes=d.quotes.map((q,i)=>{finite(q.capital,'frontier capital');if(q.capital<=prior)fail('frontier capital strictly increasing');prior=q.capital;if(q.capital>d.source.amount+EPS)fail('frontier exceeds source');assertCompleteScenarioValues(q.scenarioValues,joint,convention,d.source.currency,'frontier quote');if(i===0&&(q.capital!==0||q.scenarioValues.some(v=>Math.abs(v.familyValue.amount)>EPS)))fail('frontier must anchor zero');return q});
  const valueStreamId=d.valueStreamId??`${d.actionType}:${d.source.id}:${d.destinationId}:${d.provenance.version}`;
  return makeEvidence({schemaVersion:'F8_BRANDED_FRONTIER_EVIDENCE_V1',mode:d.mode,actionType:d.actionType,sourceId:d.source.id,sourceFingerprint:fp,valueStreamId,destinationId:d.destinationId,entryRoute:d.entryRoute,maximum:quotes.at(-1).capital,quotes,provenance:d.provenance},
    {kind:'STATIC',source:cloneFreeze(d.source),jointVersion:joint.version,materialize:(amount)=>({economicActions:amount>DECISION_EPS?[{actionId:`${valueStreamId}:selected`,date:d.actionDate??d.asOfDate,actionType:d.actionType,sourceId:d.source.id,...(d.execution??{}),destinationId:d.destinationId,entryRoute:d.entryRoute,amount,reasonCode:'JOINT_GLOBAL_OPTIMUM',provenance:d.provenance}]:[],capacityClaimsByScenario:[],rightsClaims:[],moduleEvidence:{kind:'STRICT_SCENARIO_QUOTE',version:d.provenance.version}})});
}


const controlledBad=/WORKING_QA|SYNTHETIC_TEST_ONLY|LEGACY_COMPATIBILITY/;
export function controlledLiveRuntimeEnvelopeHash(runtimeEnvelope){return hash(runtimeEnvelope)}
function controlledSourceReferences(runtimeEnvelope){return new Set(runtimeEnvelope?.provenance?.sourceDocumentIds??[])}
function assertControlledReferences(runtimeEnvelope,refs,label){
  const allowed=controlledSourceReferences(runtimeEnvelope);
  if(!Array.isArray(refs)||!refs.length||refs.some(x=>typeof x!=='string'||!allowed.has(x)))fail(`${label}: exact verified source references required`);
  return [...new Set(refs)].sort();
}
function requiredControlledRefs(runtimeEnvelope,source,actionType){
  const fields=runtimeEnvelope.expertEvidence??{},refs=new Set();
  for(const name of ['existingProductBalances','fees'])if(fields[name]?.productionVerified===true)refs.add(fields[name].sourceReference);
  if(['savings_policy','taxable'].includes(source.wrapper)&&fields.policyTaxBasis?.productionVerified===true)refs.add(fields.policyTaxBasis.sourceReference);
  if(source.wrapper==='t190'&&fields.t190TaxBasis?.productionVerified===true)refs.add(fields.t190TaxBasis.sourceReference);
  const adapters=runtimeEnvelope.provenance?.ruleAdapters??[];
  for(const a of adapters)if(['MORTALITY_MODEL','TAX_RULES','NI_HEALTH'].includes(a.adapterType))refs.add(a.sourceReference);
  if(actionType==='ROTATION'){
    for(const name of ['officialContractualAnnuityFactor','spouseSurvivorPercentage','guaranteeMonths','commencementDate','productContractIdentifiers'])if(fields[name]?.productionVerified===true)refs.add(fields[name].sourceReference);
    for(const a of adapters)if(a.adapterType==='CONTRACTUAL_PAYMENT_SEMANTICS')refs.add(a.sourceReference);
  }
  return [...refs].filter(Boolean).sort();
}
function assertRequiredControlledRefs(runtimeEnvelope,source,actionType,refs){
  const have=new Set(refs),missing=requiredControlledRefs(runtimeEnvelope,source,actionType).filter(x=>!have.has(x));
  if(missing.length)fail(`CONTROLLED_LIVE evidence missing required verified references: ${missing.join(',')}`);
}
function assertControlledRuntime(runtimeEnvelope){
  const r=validateVerifiedRuntimeEnvelope(runtimeEnvelope);
  if(r.status!=='READY_FOR_CONTROLLED_LIVE_BINDING')fail(`verified runtime authority required: ${r.reason}`);
  assertNoQaLegacyEvidence(runtimeEnvelope);
  const docs=new Set(runtimeEnvelope.provenance?.sourceDocumentIds??[]),requiredFields=['officialContractualAnnuityFactor','spouseSurvivorPercentage','guaranteeMonths','commencementDate','policyTaxBasis','existingProductBalances','fees','productContractIdentifiers'];
  for(const name of requiredFields){const f=runtimeEnvelope.expertEvidence?.[name];if(f?.productionVerified!==true||f.verificationStatus!=='VERIFIED'||!iso(f.asOfDate)||!docs.has(f.sourceReference)||!f.verifiedBy)fail(`complete verified Rotation expert provenance required: ${name}`)}
  const adapters=runtimeEnvelope.provenance?.ruleAdapters??[],byType=new Map(adapters.map(a=>[a.adapterType,a])),eventDate=runtimeEnvelope.rotation?.commencementDate;
  for(const type of ['TAX_RULES','NI_HEALTH','MORTALITY_MODEL','CONTRACTUAL_PAYMENT_SEMANTICS']){const a=byType.get(type);if(!a?.ruleId||!a.version||!iso(a.effectiveFrom)||a.effectiveTo!=null&&!iso(a.effectiveTo)||!a.sourceType||!docs.has(a.sourceReference)||!a.verifiedBy)fail(`complete verified rule provenance required: ${type}`);const checkDate=type==='MORTALITY_MODEL'?runtimeEnvelope.expertEvidence.commencementDate.asOfDate:eventDate;if(checkDate<a.effectiveFrom||a.effectiveTo&&checkDate>a.effectiveTo)fail(`verified rule outside effective date: ${type}`)}
  if(runtimeEnvelope.rotation?.productionVerified!==true)fail('verified Rotation runtime required');
  if(runtimeEnvelope.eventExecution?.productionVerified!==true||runtimeEnvelope.eventExecution?.atomicCommit!==true||runtimeEnvelope.eventExecution?.exactDateLedger!==true||!runtimeEnvelope.eventExecution?.executorVersion)fail('verified exact-date execution authority required');
  return {runtime:r.runtime,runtimeEnvelopeHash:controlledLiveRuntimeEnvelopeHash(runtimeEnvelope)};
}
function normalizedJointBranchIdentity(branches){return branches.map(b=>({id:b.id,probability:b.probability,member:b.member,spouse:b.spouse})).sort((a,b)=>a.id.localeCompare(b.id))}
function assertMortalityBoundToRuntime(rawMortality,runtimeEnvelope){
  const joint=createJointMortality(rawMortality),verified=runtimeEnvelope.jointMortality;
  if(!verified||verified.productionVerified!==true||verified.version!==joint.version)fail('joint mortality version not bound to verified runtime');
  if(stable(normalizedJointBranchIdentity(joint.branches))!==stable(normalizedJointBranchIdentity(verified.branches)))fail('joint mortality branches not bound to verified runtime');
  return joint;
}
function assertControlledSource(source,runtimeEnvelope){
  sourceFingerprint(source);
  if(!source.productId)fail('CONTROLLED_LIVE source productId required');
  const balances=runtimeEnvelope.expertEvidence?.existingProductBalances;
  if(balances?.productionVerified!==true)fail('verified source balances required');
  const product=(balances.value??[]).find(x=>x.productId===source.productId);
  if(!product||product.balance!==source.amount||product.wrapper!==source.wrapper)fail('CONTROLLED_LIVE source state not bound to verified balance evidence');
  if(source.asOfDate!==balances.asOfDate)fail('CONTROLLED_LIVE source date not bound to verified balance evidence');
  if(['savings_policy','taxable'].includes(source.wrapper)){
    const basis=runtimeEnvelope.expertEvidence?.policyTaxBasis;
    if(basis?.productionVerified!==true||source.basisNominal!==basis.value||source.asOfDate!==basis.asOfDate)fail('CONTROLLED_LIVE source basis not bound to verified policy basis');
  }
  if(source.wrapper==='t190'){
    const basis=runtimeEnvelope.expertEvidence?.t190TaxBasis;
    if(basis?.productionVerified!==true||source.basisNominal!==basis.value||source.asOfDate!==basis.asOfDate)fail('CONTROLLED_LIVE source basis not bound to verified T190 basis');
  }
  return true;
}

/** Strict Live evidence builder. It does no economics: it brands already-supplied
 * scenario quotes only after binding them to one verified runtime envelope. */
export function buildControlledLiveScenarioFrontierEvidence(raw){
  const d=raw,{runtimeEnvelope}=d??{},authority=assertControlledRuntime(runtimeEnvelope);
  if(d?.schemaVersion!=='F8_CONTROLLED_LIVE_SCENARIO_FRONTIER_EVIDENCE_V1'||!['RESIDUAL','ROTATION'].includes(d.actionType)||!d.source||!d.destinationId||!d.entryRoute||!d.provenance?.version||!Array.isArray(d.quotes)||d.quotes.length<2)fail('complete CONTROLLED_LIVE frontier evidence required');
  assertNoQaLegacyEvidence(d);assertControlledSource(d.source,runtimeEnvelope);
  const refs=assertControlledReferences(runtimeEnvelope,d.evidenceReferences,'CONTROLLED_LIVE frontier');assertRequiredControlledRefs(runtimeEnvelope,d.source,d.actionType,refs);
  const {joint,convention}=jointContext(d);assertMortalityBoundToRuntime(d.jointMortality,runtimeEnvelope);
  if(d.valuationConvention?.productionVerified!==true||d.valuationConvention?.provenance?.runtimeEnvelopeHash!==authority.runtimeEnvelopeHash)fail('verified valuation convention bound to runtime required');
  assertControlledReferences(runtimeEnvelope,d.valuationConvention.provenance.sourceReferences,'valuation convention');
  const fp=sourceFingerprint(d.source);let prior=-Infinity;
  const quotes=d.quotes.map((q,i)=>{finite(q.capital,'frontier capital');if(q.capital<=prior)fail('frontier capital strictly increasing');prior=q.capital;if(q.capital>d.source.amount+EPS)fail('frontier exceeds source');assertCompleteScenarioValues(q.scenarioValues,joint,convention,d.source.currency,'frontier quote');if(i===0&&(q.capital!==0||q.scenarioValues.some(v=>Math.abs(v.familyValue.amount)>EPS)))fail('frontier must anchor zero');return q});
  const valueStreamId=d.valueStreamId??`${d.actionType}:${d.source.id}:${d.destinationId}:${d.provenance.version}`;
  const provenance=cloneFreeze({...d.provenance,productionVerified:true,runtimeEnvelopeHash:authority.runtimeEnvelopeHash,sourceReferences:refs});
  const execution=d.actionType==='ROTATION'?d.execution:null;
  if(d.actionType==='ROTATION'){
    const contract=(runtimeEnvelope.rotation?.contractIdentifiers??[]).find(x=>x.providerId===execution?.providerId&&x.contractId===execution?.contractId);
    if(!execution?.sourceLotId||execution.sourceLotId!==d.source.id||!execution?.providerId||!execution?.contractId||!execution?.conditionKey||!contract||d.actionDate!==runtimeEnvelope.rotation?.commencementDate)fail('verified Rotation execution identity/date required');
  }
  return makeEvidence({schemaVersion:'F8_BRANDED_FRONTIER_EVIDENCE_V1',mode:'CONTROLLED_LIVE',actionType:d.actionType,sourceId:d.source.id,sourceFingerprint:fp,valueStreamId,destinationId:d.destinationId,entryRoute:d.entryRoute,maximum:quotes.at(-1).capital,quotes,provenance},
    {kind:'CONTROLLED_LIVE_STATIC',source:cloneFreeze(d.source),jointVersion:joint.version,authorization:{runtimeEnvelopeHash:authority.runtimeEnvelopeHash,sourceReferences:refs},materialize:(amount)=>({economicActions:amount>EPS?[{actionId:`${valueStreamId}:selected`,date:d.actionDate??d.asOfDate,actionType:d.actionType,sourceId:d.source.id,...(execution??{}),destinationId:d.destinationId,entryRoute:d.entryRoute,amount,reasonCode:'JOINT_GLOBAL_OPTIMUM',provenance}]:[],capacityClaimsByScenario:[],rightsClaims:[],moduleEvidence:{kind:'STRICT_VERIFIED_SCENARIO_QUOTE',version:d.provenance.version,productionVerified:true}})});
}

function memberScenarios(rawMortality){return rawMortality.member.map(m=>({id:m.id,kind:m.kind==='DEATH'?'MEMBER_DEATH':'SURVIVE_TO_TERMINAL_HORIZON',probability:m.probability,...(m.kind==='DEATH'?{memberDeathDate:m.deathDate}:{terminalDate:m.terminalDate})}))}
function m5AtCapital(template,canonicalSource,capital,rawMortality){
  const x=structuredClone(template);if(x.sources?.length!==1)fail('integrated M5 V1 supports one policy lane source');const s=x.sources[0];
  if(s.id!==canonicalSource.id||s.economicPathId!==canonicalSource.economicPathId||s.ownerId!==canonicalSource.ownerId||x.baseDate!==canonicalSource.asOfDate||x.currency!==canonicalSource.currency)fail('M5 source is not canonical shared source');
  const ratio=canonicalSource.amount>EPS?capital/canonicalSource.amount:0;
  s.amount=capital;s.basisNominal=(canonicalSource.basisNominal??s.basisNominal)*ratio;s.basisIndexed=(canonicalSource.basisIndexed??s.basisIndexed)*ratio;s.stateDate=canonicalSource.asOfDate;s.availabilityDate=canonicalSource.asOfDate;
  x.scenarios=memberScenarios(rawMortality);
  for(const a of x.policy.actions)a.maxGross=Math.max(a.maxGross??0,capital);
  return evaluateQualifyingPolicy(x);
}
function m5ScenarioDelta(replay,memberId){const i=replay.planned.findIndex(x=>x.scenarioId===memberId);if(i<0)fail('M5 member branch missing');return replay.planned[i].familyValueAtEnd-replay.baseline[i].familyValueAtEnd}

function qualifyingCapacityKinkPoints(d){
  const maximum=d.source.amount;if(maximum<=DECISION_EPS)return {points:[maximum],certificate:{kind:'M5_CAPACITY_KINKS_V1',kinks:[]}};
  const actionsByYear=new Map();for(const a of d.m5Template.policy?.actions??[]){const y=Number(String(a.date).slice(0,4)),rows=actionsByYear.get(y)??[];rows.push(a);actionsByYear.set(y,rows)}
  const capacityByYear=new Map((d.m5Template.capacity??[]).map(c=>[c.taxYear,c]));
  const evalCache=new Map();const at=capital=>{const key=capital.toPrecision(17);if(!evalCache.has(key))evalCache.set(key,m5AtCapital(d.m5Template,d.source,capital,d.jointMortality));return evalCache.get(key)};
  const usedAt=(capital,year,lastDate)=>{if(capital<=DECISION_EPS)return 0;const out=at(capital);const eligible=out.planned.filter(r=>r.endDate>lastDate);if(!eligible.length)return 0;const vals=eligible.map(r=>r.executedCapacity.find(c=>c.taxYear===year)?.executed??0);const lo=Math.min(...vals),hi=Math.max(...vals);if(Math.abs(hi-lo)>1e-7)fail(`M5 structural capacity state differs across alive branches: ${year}`);return vals[0]};
  const kinks=[];for(const [year,actions] of [...actionsByYear.entries()].sort((a,b)=>a[0]-b[0])){const cap=capacityByYear.get(year);if(!cap)fail(`M5 structural topology missing capacity: ${year}`);const target=cap.available-cap.alreadyUsed;if(target<=DECISION_EPS)continue;const lastDate=[...actions].sort((a,b)=>a.date.localeCompare(b.date)).at(-1).date;const top=usedAt(maximum,year,lastDate);if(top<target-1e-7)continue;let lo=0,hi=maximum;for(let i=0;i<80&&hi-lo>Math.max(1e-5,maximum*1e-10);i++){const mid=(lo+hi)/2;if(usedAt(mid,year,lastDate)>=target-1e-7)hi=mid;else lo=mid}if(hi>DECISION_EPS&&hi<maximum-1e-7)kinks.push({capital:hi,taxYear:year,targetCapacity:target,lastActionDate:lastDate,reason:'ANNUAL_NET_CAPACITY_SATURATION'})}
  const sorted=kinks.sort((a,b)=>a.capital-b.capital),points=[];for(const k of sorted){if(!points.length||Math.abs(k.capital-points.at(-1))>1e-6)points.push(k.capital)}if(!points.length||Math.abs(maximum-points.at(-1))>1e-7)points.push(maximum);
  // Defense-in-depth: structural regimes delimited by capacity-state changes must be
  // branchwise affine. We test two non-midpoint interiors; this is validation of the
  // structural certificate, never the source of the topology itself.
  const all=[0,...points];for(let i=1;i<all.length;i++){const a=all[i-1],b=all[i];if(b-a<=1e-6)continue;const ea=a<=DECISION_EPS?null:at(a),eb=at(b);for(const w of [1/3,2/3]){const x=a+(b-a)*w,ex=at(x);for(let j=0;j<ex.planned.length;j++){const ya=ea?ea.planned[j].familyValueAtEnd:0,yb=eb.planned[j].familyValueAtEnd,y=ex.planned[j].familyValueAtEnd,lin=ya+w*(yb-ya);if(!near(y,lin))fail(`M5 structural Q segment is not exact-affine: ${a}..${b}`)}}}
  return {points,certificate:{kind:'M5_CAPACITY_KINKS_V1',sourceAmount:maximum,kinks:sorted,derivation:'DATED_CAPACITY_SATURATION_ROOTS',scenarioIndependent:true}};
}

/** Q frontier is generated from M5 at structurally-derived economic kinks.
 * Arbitrary capital grids are retained only for legacy callers that do not claim
 * structural exactness; q1A uses the certified topology path. */
export function buildQualifyingFrontierEvidence(raw){
  const d=raw;if(d?.schemaVersion!=='F8_QUALIFYING_FRONTIER_BUILD_V1'||!d.source||!d.m5Template||!d.provenance?.version)fail('qualifying frontier build input required');
  const {joint,convention}=jointContext(d);const fp=sourceFingerprint(d.source);
  const structural=d.topologyAuthority==='M5_CAPACITY_KINKS_V1'?qualifyingCapacityKinkPoints(d):null;
  if(!structural&&(!Array.isArray(d.capitalPoints)||!d.capitalPoints.length))fail('qualifying frontier capital points or structural topology required');
  const rawPoints=structural?.points??d.capitalPoints,points=[0,...rawPoints.filter(x=>x>EPS)].sort((a,b)=>a-b);
  if(new Set(points).size!==points.length||points.at(-1)>d.source.amount+EPS)fail('invalid Q lane capital points');
  const runs=new Map();
  const quotes=points.map(capital=>{
    if(capital===0)return {capital:0,scenarioValues:zeroScenarioValues(joint,convention,d.source.currency,'Q:ZERO')};
    const out=m5AtCapital(d.m5Template,d.source,capital,d.jointMortality);runs.set(capital,out);
    const scenarioValues=joint.branches.map(b=>{const i=out.planned.findIndex(x=>x.scenarioId===b.member.id);if(i<0)fail('M5 member branch missing');return {branchId:b.id,familyValue:familyValue(out.planned[i].familyValueAtEnd,branchEnd(b),convention,d.source.currency,'M5_QUALIFYING_VALUE')}});
    return {capital,scenarioValues};
  });
  const valueStreamId=d.valueStreamId??`QUALIFYING:${d.source.id}:${d.provenance.version}`;
  return makeEvidence({schemaVersion:'F8_BRANDED_FRONTIER_EVIDENCE_V1',mode:d.m5Template.mode,actionType:'QUALIFYING',sourceId:d.source.id,sourceFingerprint:fp,valueStreamId,destinationId:d.destinationId??'qualifying',entryRoute:'QUALIFYING_FUNDING',maximum:points.at(-1),quotes,provenance:d.provenance,...(structural?{frontierCertificate:structural.certificate}: {})},
    {kind:'M5',source:cloneFreeze(d.source),jointVersion:joint.version,materialize:(amount)=>{
      if(amount<=DECISION_EPS)return {economicActions:[],capacityClaimsByScenario:[],rightsClaims:[],moduleEvidence:{kind:'M5',policyVersion:d.m5Template.policy.version,exactSelectedPoint:true,expectedNetFamilyValue:0,scenarioValues:zeroScenarioValues(joint,convention,d.source.currency,'M5_SELECTED_ZERO')}};
      const out=m5AtCapital(d.m5Template,d.source,amount,d.jointMortality);
      const actions=[];for(const row of out.planned)for(const a of row.economicActions)actions.push({...a,rootActionId:a.actionId,actionId:`${a.actionId}:${row.scenarioId}`,scenarioId:row.scenarioId,actionType:'QUALIFYING',policyLaneCapital:amount});
      // Capacity is a contingent execution claim on a realized mortality branch. Expand the
      // member-only M5 replay onto the joint member/spouse tree instead of reserving globally.
      const byMember=new Map(out.planned.map(row=>[row.scenarioId,row]));
      const capacityClaimsByScenario=joint.branches.map(branch=>{const row=byMember.get(branch.member.id);if(!row)fail('M5 joint branch cannot find member replay');return {scenarioId:branch.id,memberScenarioId:branch.member.id,claims:row.executedCapacity.filter(c=>c.executed>DECISION_EPS).map(c=>({taxYear:c.taxYear,amount:c.executed,verifiedAmount:c.available,alreadyUsed:c.alreadyUsed}))}});
      const exactScenarioValues=joint.branches.map(b=>{const i=out.planned.findIndex(x=>x.scenarioId===b.member.id);if(i<0)fail('M5 selected member branch missing');return {branchId:b.id,familyValue:familyValue(out.planned[i].familyValueAtEnd,branchEnd(b),convention,d.source.currency,'M5_QUALIFYING_SELECTED')}});
      return {economicActions:actions,capacityClaimsByScenario,rightsClaims:[],moduleEvidence:{kind:'M5',policyVersion:out.policyVersion,expectedNetFamilyValue:out.expectedNetFamilyValue,baselineExpectedNetFamilyValue:out.baselineExpectedNetFamilyValue,scenarioValues:exactScenarioValues,exactSelectedPoint:true}};
    }});
}


/** The apples-to-apples stay/current-wrapper frontier for a source used by M5.
 * It is derived from M5 baseline replay at the identical lane sizes and dates. */
export function buildQualifyingBaselineFrontierEvidence(raw){
  const d=raw;if(d?.schemaVersion!=='F8_QUALIFYING_FRONTIER_BUILD_V1'||!d.source||!d.m5Template||!Array.isArray(d.capitalPoints)||!d.capitalPoints.length||!d.provenance?.version)fail('qualifying baseline frontier build input required');
  const {joint,convention}=jointContext(d);const fp=sourceFingerprint(d.source),points=[0,...d.capitalPoints.filter(x=>x>EPS)].sort((a,b)=>a-b);
  if(new Set(points).size!==points.length||points.at(-1)>d.source.amount+EPS)fail('invalid baseline lane capital points');
  const quotes=points.map(capital=>{if(capital===0)return {capital:0,scenarioValues:zeroScenarioValues(joint,convention,d.source.currency,'M5_BASELINE_ZERO')};const out=m5AtCapital(d.m5Template,d.source,capital,d.jointMortality);const scenarioValues=joint.branches.map(b=>{const i=out.baseline.findIndex(x=>x.scenarioId===b.member.id);if(i<0)fail('M5 baseline member branch missing');return {branchId:b.id,familyValue:familyValue(out.baseline[i].familyValueAtEnd,branchEnd(b),convention,d.source.currency,'M5_BASELINE_VALUE')}});return {capital,scenarioValues}});
  const valueStreamId=d.baselineValueStreamId??`RESIDUAL:${d.source.id}:M5_BASELINE:${d.provenance.version}`;
  return makeEvidence({schemaVersion:'F8_BRANDED_FRONTIER_EVIDENCE_V1',mode:d.m5Template.mode,actionType:'RESIDUAL',sourceId:d.source.id,sourceFingerprint:fp,valueStreamId,destinationId:`stay:${d.source.id}`,entryRoute:'STAY',maximum:points.at(-1),quotes,provenance:{...d.provenance,baselineOf:'M5'}},
    {kind:'M5_BASELINE',source:cloneFreeze(d.source),jointVersion:joint.version,materialize:(amount)=>({economicActions:amount>DECISION_EPS?[{actionId:`${valueStreamId}:stay`,date:d.asOfDate,actionType:'RESIDUAL',sourceId:d.source.id,destinationId:`stay:${d.source.id}`,entryRoute:'STAY',amount,reasonCode:'BEST_RESIDUAL_ALTERNATIVE',provenance:{...d.provenance,baselineOf:'M5'}}]:[],capacityClaimsByScenario:[],rightsClaims:[],moduleEvidence:{kind:'M5_BASELINE',policyVersion:d.m5Template.policy.version}})});
}

export function buildContractMenuEvidence(raw){const enumeration=enumerateContractMenu(raw);const e=cloneFreeze({schemaVersion:'F8_BRANDED_CONTRACT_MENU_V1',mode:raw.mode,personId:raw.personId,candidateOptionIds:enumeration.candidates.map(x=>x.id),excludedOptionIds:enumeration.excludedOptionIds});contractMeta.set(e,{raw,enumeration});return e}
function getContract(e){const m=contractMeta.get(e);if(!m)fail('unbranded contract menu evidence');return m}

/** Service feasibility is executed through M6. Capital cost remains an explicit contract/economic quote,
 * because M6 deliberately models service receipts rather than purchase cost. */
export function buildServiceEvidence(raw){
  const d=structuredClone(raw);if(d?.schemaVersion!=='F8_SERVICE_EVIDENCE_BUILD_V1'||!d.source||!d.serviceState||!Array.isArray(d.choices)||!Array.isArray(d.capitalCosts)||!d.provenance?.version)fail('service evidence input required');
  const {joint,convention}=jointContext(d);const fp=sourceFingerprint(d.source),result=evaluateServiceAllocation(d.serviceState,d.choices);
  const costs=new Map(d.capitalCosts.map(x=>[x.optionId,x.capitalPerUnit]));let amount=0;for(const c of d.choices){const cost=costs.get(c.optionId);finite(cost,`service capital cost ${c.optionId}`);amount+=c.units*cost}if(amount>d.source.amount+EPS)fail('service source cost exceeds capital');
  const scenarioValues=d.scenarioValues??zeroScenarioValues(joint,convention,d.source.currency,'SERVICE_ZERO');assertCompleteScenarioValues(scenarioValues,joint,convention,d.source.currency,'service values');
  const id=d.id??`SERVICE:${hash({choices:d.choices,version:d.provenance.version}).slice(0,16)}`;
  const e=cloneFreeze({schemaVersion:'F8_BRANDED_SERVICE_EVIDENCE_V1',id,sourceId:d.source.id,sourceFingerprint:fp,amount,scenarioValues,choices:d.choices,serviceMode:result.mode,provenance:d.provenance});serviceMeta.set(e,{result,source:d.source,materialize:()=>({economicActions:amount>EPS?[{actionId:`${id}:capital`,date:d.asOfDate,actionType:'SERVICE_SOURCE',sourceId:d.source.id,destinationId:id,entryRoute:'SERVICE_SOURCE',amount,reasonCode:'REQUIRED_SERVICE_CONSTRAINT',provenance:d.provenance}]:[],capacityClaimsByScenario:[],rightsClaims:[],serviceResult:result})});return e}
function getService(e){const m=serviceMeta.get(e);if(!m)fail('unbranded service evidence');return m}

/** q evidence must be attached to a feasible M7 option and each future receipt is replayed by M8.
 * Scenario family values remain explicit dated valuation evidence; M8 proves contingent receipt/reinvestment semantics. */
export function buildAnnuitizationFrontierEvidence(raw){
  const d=raw;if(d?.schemaVersion!=='F8_ANNUITIZATION_FRONTIER_BUILD_V1'||!d.source||!d.contractEvidence||!d.contractOptionId||!Array.isArray(d.points)||d.points.length<2||!d.provenance?.version)fail('annuitization evidence input required');
  const {joint,convention}=jointContext(d),contract=getContract(d.contractEvidence);const option=contract.enumeration.candidates.find(x=>x.id===d.contractOptionId);if(!option)fail('annuitization contract option is not feasible');const fp=sourceFingerprint(d.source);
  let prior=-Infinity;const pointMeta=new Map();const quotes=d.points.map((p,i)=>{
    finite(p.capital,'annuitization capital');if(p.capital<=prior||p.capital>d.source.amount+EPS)fail('annuitization capital points invalid');prior=p.capital;assertCompleteScenarioValues(p.scenarioValues,joint,convention,d.source.currency,'annuitization values');
    if(i===0&&(p.capital!==0||p.scenarioValues.some(v=>Math.abs(v.familyValue.amount)>EPS)))fail('annuitization zero point required');
    const receiptRuns=[];
    for(const rr of p.receipts??[]){if(rr.receipt?.contractId!==option.contractId)fail('receipt contract does not match selected option');if(!option.entitlements.some(e=>e.rightId===rr.receipt?.rightId))fail('receipt right not present in selected contract option');const x=structuredClone(rr);x.scenarios=memberScenarios(d.jointMortality);receiptRuns.push(replayContingentReceipt(x))}
    pointMeta.set(p.capital,{receiptRuns,rights:(p.rights??[])});return {capital:p.capital,scenarioValues:p.scenarioValues};
  });
  const valueStreamId=d.valueStreamId??`OPTIONAL_ANNUITIZATION:${d.source.id}:${option.id}:${d.provenance.version}`;
  return makeEvidence({schemaVersion:'F8_BRANDED_FRONTIER_EVIDENCE_V1',mode:contract.raw.mode,actionType:'OPTIONAL_ANNUITIZATION',sourceId:d.source.id,sourceFingerprint:fp,valueStreamId,destinationId:d.destinationId??`annuity:${option.id}`,entryRoute:option.entryRoute,maximum:d.points.at(-1).capital,quotes,provenance:d.provenance,contractOptionId:option.id},
    {kind:'M7_M8',source:cloneFreeze(d.source),jointVersion:joint.version,materialize:(amount)=>{
      if(amount<=DECISION_EPS)return {economicActions:[],capacityClaimsByScenario:[],rightsClaims:[],moduleEvidence:{kind:'M7_M8',contractOptionId:option.id}};
      let hi=d.points.findIndex(p=>p.capital>=amount-EPS);if(hi<0)fail('selected annuitization beyond evidence');if(d.points[hi].capital<amount-EPS)fail('annuitization evidence range');
      const p=d.points[hi],ratio=p.capital>EPS?amount/p.capital:0,meta=pointMeta.get(p.capital);
      const rightsClaims=(p.rights??[]).map(r=>({...r,sourceAssetId:`${valueStreamId}:capital`,amountScale:ratio}));
      return {economicActions:[{actionId:`${valueStreamId}:annuitize`,date:option.commencementDate,actionType:'OPTIONAL_ANNUITIZATION',sourceId:d.source.id,destinationId:d.destinationId??`annuity:${option.id}`,entryRoute:option.entryRoute,amount,contractOptionId:option.id,reasonCode:'JOINT_GLOBAL_OPTIMUM',provenance:d.provenance}],capacityClaimsByScenario:[],rightsClaims,moduleEvidence:{kind:'M7_M8',contractOptionId:option.id,receiptReplayCount:meta.receiptRuns.length}};
    }});
}


/** qR3 Professional Simulation path. The frontier topology is branded by qR3 and
 * every economic point/materialized selected amount is owned by qR2. No external
 * scenarioValues, receipt schedule, or annuitization point economics are accepted. */
export function buildNativeAnnuitizationFrontierEvidenceProfessionalSimulationBeta(raw){
  const d=raw;if(d?.schemaVersion!=='F8_NATIVE_ANN_FRONTIER_EVIDENCE_BUILD_V1'||!d.frontierPacket||!d.contractEvidence||!d.contractOptionId)fail('native qR3 frontier evidence input required');
  for(const k of ['points','scenarioValues','receiptSchedule','receipts','qGrid','qMax','qPoints'])if(Object.hasOwn(d,k))fail('external q economics forbidden on native q evidence path');
  const p=getNativeAnnuitizationFrontierCompilerPayload(d.frontierPacket,d.contractOptionId);if(p.permission!=='YES'||p.maximum<=EPS||p.points.length<2)fail('positive native q frontier required for Strategy Compiler evidence');
  const contract=getContract(d.contractEvidence),option=contract.enumeration.candidates.find(x=>x.id===d.contractOptionId);if(!option||option.id!==p.option.id||option.contractId!==p.option.contractId)fail('native q frontier option not present in M7 contract evidence');
  const source={...structuredClone(p.source),asOfDate:p.source.asOfDate??p.source.stateDate};const {joint,convention}=jointContext({asOfDate:source.asOfDate,jointMortality:p.jointMortality,valuationConvention:p.valuationConvention});const fp=sourceFingerprint(source);
  if(p.points.at(-1).qCapital!==p.maximum)fail('native q frontier maximum mismatch');let prior=-Infinity;
  const quotes=p.points.map((x,i)=>{finite(x.qCapital,'native q frontier capital');if(x.qCapital<=prior)fail('native q frontier points must be strictly increasing');prior=x.qCapital;assertCompleteScenarioValues(x.scenarioValues,joint,convention,source.currency,'native q frontier values');if(i===0&&(x.qCapital!==0||x.scenarioValues.some(v=>Math.abs(v.familyValue.amount)>EPS)))fail('native q zero point required');return {capital:x.qCapital,scenarioValues:x.scenarioValues}});
  const provenance={...structuredClone(p.provenance),simulationMode:'PROFESSIONAL_SIMULATION_BETA',productionVerified:false,derivation:'QR3_NATIVE_QR2_POINT_ECONOMICS'},valueStreamId=`OPTIONAL_ANNUITIZATION:${source.id}:${option.id}:${p.frontierVersion}`;
  return makeEvidence({schemaVersion:'F8_BRANDED_FRONTIER_EVIDENCE_V1',mode:contract.raw.mode,actionType:'OPTIONAL_ANNUITIZATION',sourceId:source.id,sourceFingerprint:fp,valueStreamId,destinationId:`annuity:${option.id}`,entryRoute:option.entryRoute,maximum:p.maximum,quotes,provenance,contractOptionId:option.id},
    {kind:'M8_NATIVE_QR3',source:cloneFreeze(source),jointVersion:joint.version,materialize:(amount)=>{
      if(amount<=DECISION_EPS)return {economicActions:[],capacityClaimsByScenario:[],rightsClaims:[],moduleEvidence:{kind:'M8_NATIVE_QR3',contractOptionId:option.id,annuitizationDecisionCertified:false}};
      const result=p.evaluateAt(amount);if(result.qCapital!==amount||result.contractOptionId!==option.id||result.annuitizationDecisionCertified!==false)fail('qR2 selected-point materialization mismatch');
      const qAction=result.economicActions.find(a=>a.type==='OPTIONAL_ANNUITIZATION_POINT');if(!qAction)fail('qR2 selected point lacks annuitization action');
      const economicActions=[{...qAction,actionType:'OPTIONAL_ANNUITIZATION',type:undefined,date:qAction.actionDate,amount:qAction.qCapital,destinationId:`annuity:${option.id}`,entryRoute:option.entryRoute,reasonCode:'JOINT_GLOBAL_OPTIMUM',provenance},...result.economicActions.filter(a=>a!==qAction)];
      const byMember=new Map(result.receiptPipeline.scenarios.map(s=>[s.scenarioId,s])),capacityRows=new Map((p.capacity??[]).map(c=>[c.taxYear,c]));
      const capacityClaimsByScenario=joint.branches.map(branch=>{const row=byMember.get(branch.member.id);if(!row)fail('qR2 selected point missing member receipt branch');return {scenarioId:branch.id,memberScenarioId:branch.member.id,claims:(row.capacityExecution??[]).filter(c=>c.executed>EPS).map(c=>{const cap=capacityRows.get(c.taxYear);if(!cap)fail('qR2 selected point capacity provenance missing');return {taxYear:c.taxYear,amount:c.executed,verifiedAmount:cap.available,alreadyUsed:cap.alreadyUsed}})}});
      const rm=new Map(result.scenarioValues.map(x=>[x.branchId,x.familyValue]));const exactScenarioValues=joint.branches.map(b=>{if(!rm.has(b.id))fail('qR2 exact selected branch missing');return {branchId:b.id,familyValue:familyValue(rm.get(b.id),branchEnd(b),convention,source.currency,'QR2_SELECTED_Q')}});
      return {economicActions,capacityClaimsByScenario,rightsClaims:result.rightsCreated,moduleEvidence:{kind:'M8_NATIVE_QR3',contractOptionId:option.id,qCapital:amount,expectedNetFamilyValue:result.expectedNetFamilyValue,scenarioValues:result.scenarioValues,exactScenarioValues,valuationBasis:result.valuationBasis,receiptSchedule:result.receiptSchedule,annuitizationDecisionCertified:false,pointProvenance:result.provenance,exactSelectedPoint:true}};
    }});
}

function validateEvidenceAgainstSource(evidence,source,joint){const m=evidenceMeta(evidence);if(evidence.sourceId!==source.id||evidence.sourceFingerprint!==sourceFingerprint(source)||m.jointVersion!==joint.version)fail('frontier evidence not bound to canonical source/mortality state')}
function offerFromEvidence(e){return {sourceId:e.sourceId,destinationId:e.destinationId,actionType:e.actionType,valueStreamId:e.valueStreamId,entryRoute:e.entryRoute,provenance:e.provenance,quotes:e.quotes}}
function capFromEvidence(e){return {destinationId:e.destinationId,maximum:e.maximum}}
function findSegmentEvidence(evidences,action){return evidences.find(e=>e.valueStreamId===action.valueStreamId&&e.sourceId===action.sourceId&&e.destinationId===action.destinationId)}

function stateHash(raw){return hash({asOfDate:raw.asOfDate,ownerId:raw.ownerId,currency:raw.currency,sources:raw.sources.map(s=>({...s})),commonRights:raw.commonRightIds??[],jointMortality:raw.jointMortality,valuationConvention:raw.valuationConvention,capacityState:raw.capacityState??[],ruleVersion:raw.ruleVersion??null})}


function materializationRequests(actions,evidences){
  const byStream=new Map();
  for(const a of actions){const e=findSegmentEvidence(evidences,a);if(!e)fail('selected action lacks branded evidence');const key=e.valueStreamId,row=byStream.get(key)??{e,amount:0};row.amount+=a.amount;byStream.set(key,row)}
  return [...byStream.values()].filter(x=>x.amount>DECISION_EPS);
}
function exactSelectedPointGate(selection,materialized,m10Winner){
  const m=materialized.moduleEvidence;if(m?.exactSelectedPoint!==true)return;
  const expected=m10Winner.economicActions.filter(a=>!a.required&&a.valueStreamId===selection.e.valueStreamId).reduce((n,a)=>n+a.expectedNetFamilyValue,0);
  if(typeof m.expectedNetFamilyValue!=='number'||!near(expected,m.expectedNetFamilyValue))fail(`exact selected-point expected value mismatch: ${selection.e.valueStreamId}`);
  if(!Array.isArray(m.scenarioValues))fail(`exact selected-point branch values required: ${selection.e.valueStreamId}`);
  const rows=m.exactScenarioValues??m.scenarioValues;const exact=new Map(rows.map(x=>[x.branchId,typeof x.familyValue==='number'?x.familyValue:x.familyValue?.amount]));
  for(const scenario of m10Winner.scenarios){const c=scenario.contributions.find(x=>x.valueStreamId===selection.e.valueStreamId),frontier=c?.familyValueAmount??0,actual=exact.get(scenario.branchId);if(typeof actual!=='number'||!near(frontier,actual))fail(`exact selected-point branch mismatch: ${selection.e.valueStreamId}:${scenario.branchId}`)}
}

/** Shared integrated compilation core. Mode authorization happens only in the
 * explicit QA/CONTROLLED_LIVE wrappers below; candidate construction, M10 solving,
 * materialization and reconciliation are identical. */
function compileIntegratedPlanCore(d,{optimizer,productionReady,blockedReasons,controlledContext=null}){
  iso(d.asOfDate);const {joint}=jointContext(d);const sourceById=new Map();for(const s of d.sources){if(sourceById.has(s.id)||s.ownerId!==d.ownerId||s.currency!==d.currency||s.asOfDate!==d.asOfDate)fail('unique canonical integrated source required');sourceFingerprint(s);if(controlledContext)assertControlledSource(s,controlledContext.runtimeEnvelope);sourceById.set(s.id,s)}
  const contract=d.contractEvidence?getContract(d.contractEvidence):null;
  const m10Candidates=[];const recipeById=new Map();
  for(const recipe of d.candidates){if(!recipe.id||recipeById.has(recipe.id)||!recipe.contractOptionId||!recipe.serviceChoiceId||!recipe.provenance?.version||!Array.isArray(recipe.frontiers)||!recipe.frontiers.length)fail('complete integrated candidate recipe required');recipeById.set(recipe.id,recipe);
    if(contract&&!contract.enumeration.candidates.some(x=>x.id===recipe.contractOptionId))fail('candidate contract option excluded by M7');
    const evidences=recipe.frontiers;const streams=new Set();let optionalAnnuitizationCount=0;for(const e of evidences){const source=sourceById.get(e.sourceId);if(!source)fail('evidence source absent from canonical state');validateEvidenceAgainstSource(e,source,joint);if(streams.has(e.valueStreamId))fail('duplicate evidence stream in candidate');streams.add(e.valueStreamId);
      if(e.actionType==='OPTIONAL_ANNUITIZATION'){optionalAnnuitizationCount++;if(!e.contractOptionId||e.contractOptionId!==recipe.contractOptionId)fail('annuitization evidence contract option must match discrete candidate')}
      if(controlledContext){const m=evidenceMeta(e);if(e.mode!=='CONTROLLED_LIVE'||!['RESIDUAL','ROTATION'].includes(e.actionType)||m.kind!=='CONTROLLED_LIVE_STATIC'||m.authorization?.runtimeEnvelopeHash!==controlledContext.runtimeEnvelopeHash)fail('unverified/non-Rotation evidence cannot enter CONTROLLED_LIVE compiler');}}
    if(optionalAnnuitizationCount>1)fail('one discrete candidate may contain only one mutually-exclusive annuitization frontier');
    for(const s of d.sources)if(!evidences.some(e=>e.sourceId===s.id&&e.actionType==='RESIDUAL'&&e.destinationId===`stay:${s.id}`&&e.maximum>=s.amount-EPS))fail('candidate needs full canonical stay frontier');
    const service=recipe.serviceEvidence??null;let requiredCapitalAllocations=[];if(service){if(controlledContext)fail('L3 CONTROLLED_LIVE Rotation scope forbids serviceEvidence');const sm=getService(service),source=sourceById.get(service.sourceId);if(!source||service.sourceFingerprint!==sourceFingerprint(source))fail('service evidence source mismatch');if(service.id!==recipe.serviceChoiceId)fail('service choice identity mismatch');requiredCapitalAllocations=[{id:`${recipe.id}:required-service`,actionType:'SERVICE_SOURCE',sourceId:service.sourceId,destinationId:service.id,entryRoute:'SERVICE_SOURCE',amount:service.amount,scenarioValues:service.scenarioValues,reasonCode:'REQUIRED_SERVICE_CONSTRAINT',provenance:service.provenance,valueStreamId:`required:${service.id}`}];if(sm.result.serviceSatisfied!==true)fail('M6 service evidence not satisfied')}
    const m10Candidate={id:recipe.id,contractOptionId:recipe.contractOptionId,serviceChoiceId:recipe.serviceChoiceId,serviceSatisfied:true,protectionSatisfied:true,provenance:recipe.provenance,requiredCapitalAllocations,destinationCaps:evidences.map(capFromEvidence),offers:evidences.map(offerFromEvidence)};
    // The integration schema historically used null for "no fixed component". M10 now
    // treats null as UNKNOWN, so normalize only this trusted legacy NONE spelling by omission.
    if(Object.hasOwn(recipe,'fixedScenarioValues')){if(recipe.fixedScenarioValues==null)fail('fixed scenario economics cannot be null/UNKNOWN');m10Candidate.fixedScenarioValues=recipe.fixedScenarioValues}else m10Candidate.fixedScenarioMode='NONE';
    m10Candidates.push(m10Candidate);
  }
  const m10Input={schemaVersion:'F8_M10_JOINT_GLOBAL_V1',mode:d.mode,ownerId:d.ownerId,currency:d.currency,asOfDate:d.asOfDate,sources:d.sources.map(s=>({id:s.id,economicPathId:s.economicPathId,ownerId:s.ownerId,asOfDate:s.asOfDate,currency:s.currency,amount:s.amount})),valuationConvention:d.valuationConvention,jointMortality:d.jointMortality,nearTieTolerance:d.nearTieTolerance??0,dependenceSensitivityCases:d.dependenceSensitivityCases,baselineCandidateId:d.baselineCandidateId,candidates:m10Candidates};
  if(Object.hasOwn(d,'commonStateScenarioValues')){if(d.commonStateScenarioValues==null)fail('common scenario economics cannot be null/UNKNOWN');m10Input.commonStateScenarioValues=d.commonStateScenarioValues}else m10Input.commonStateMode='NONE';
  const m10=controlledContext?optimizer(m10Input,controlledContext.m10Authority):optimizer(m10Input);
  const recipe=recipeById.get(m10.winnerCandidateId),evidences=recipe.frontiers;const materialized=[];
  for(const a of m10.winner.economicActions.filter(x=>x.required)){const service=recipe.serviceEvidence;if(!service)fail('required M10 action lacks M6 evidence');materialized.push(...getService(service).materialize().economicActions)}
  const selections=materializationRequests(m10.winner.economicActions.filter(x=>!x.required),evidences),materializationRows=[];
  for(const s of selections){const result=evidenceMeta(s.e).materialize(s.amount);exactSelectedPointGate(s,result,m10.winner);materializationRows.push({s,result});materialized.push(...result.economicActions)}
  const actionIds=new Set();for(const a of materialized){if(!a.actionId||actionIds.has(a.actionId))fail('selected materialization produced duplicate/missing action id');actionIds.add(a.actionId)}
  const capacityClaimsByScenario=[];const rightsClaims=[];const moduleEvidence=[];
  for(const {s,result:m} of materializationRows){capacityClaimsByScenario.push(...m.capacityClaimsByScenario.map(x=>({...x,valueStreamId:s.e.valueStreamId})));rightsClaims.push(...m.rightsClaims.map(x=>({...x,valueStreamId:s.e.valueStreamId})));moduleEvidence.push({valueStreamId:s.e.valueStreamId,...m.moduleEvidence})}
  if(recipe.serviceEvidence)moduleEvidence.push({valueStreamId:`required:${recipe.serviceEvidence.id}`,kind:'M6',serviceMode:getService(recipe.serviceEvidence).result.mode});
  const rightIds=new Set(d.commonRightIds??[]),rightsLedger=new RightsLedger();
  for(const r of rightsClaims){if(!r.id||rightIds.has(r.id))fail('new plan right duplicates pre-existing/selected right');rightIds.add(r.id);try{rightsLedger.add(r)}catch(err){fail(`selected right fails F8 RightsLedger validation: ${err.message}`)}}
  const scenarioIds=new Set(joint.branches.map(b=>b.id)),capacityTotals=new Map();
  for(const row of capacityClaimsByScenario){if(!scenarioIds.has(row.scenarioId))fail('capacity claim is not bound to a joint mortality branch');for(const c of row.claims){const key=`${row.scenarioId}|${c.taxYear}`,prior=capacityTotals.get(key);if(prior&&(prior.verifiedAmount!==c.verifiedAmount||prior.alreadyUsed!==c.alreadyUsed))fail('capacity claim provenance mismatch across materialized streams');const next={verifiedAmount:c.verifiedAmount,alreadyUsed:c.alreadyUsed,amount:(prior?.amount??0)+c.amount};capacityTotals.set(key,next);if(next.amount>next.verifiedAmount-next.alreadyUsed+EPS)fail('selected contingent capacity claim exceeds verified cumulative capacity')}}
  if(controlledContext){for(const a of materialized){if(a.actionType==='RESIDUAL')continue;if(a.actionType!=='ROTATION'||!a.sourceLotId||!a.providerId||!a.contractId||!a.conditionKey||!iso(a.date))fail('winner action is not exact-date executor-compatible')}}
  const openingStateHash=stateHash(d);
  return cloneFreeze({schemaVersion:'F8_INTEGRATED_PLAN_DRAFT_V1',mode:d.mode,openingStateHash,planId:`plan:${hash({openingStateHash,winner:m10.winnerCandidateId,actions:m10.winner.economicActions}).slice(0,24)}`,winnerCandidateId:m10.winnerCandidateId,baselineCandidateId:d.baselineCandidateId,expectedNetFamilyValue:m10.expectedNetFamilyValue,baselineExpectedNetFamilyValue:m10.baselineExpectedNetFamilyValue,expectedDeltaVsBaseline:m10.expectedDeltaVsBaseline,contractOptionId:m10.winner.contractOptionId,serviceChoiceId:m10.winner.serviceChoiceId,sourceConservation:m10.winner.sourceConservation,economicActions:materialized,optimizerActions:m10.winner.economicActions,capacityClaimsByScenario,rightsClaims,moduleEvidence,scenarioValues:m10.winner.scenarios,mortalityDependenceFragile:m10.mortalityDependenceFragile,globalCertificate:m10.globalCertificate,productionReady,blockedReasons,...(controlledContext?{authorization:{schemaVersion:'F8_CONTROLLED_LIVE_COMPILER_AUTHORIZATION_V1',runtimeEnvelopeHash:controlledContext.runtimeEnvelopeHash,evidenceDigest:controlledContext.evidenceDigest,exactDateExecution:'VERIFIED',productionVerified:true}}:{})});
}

/** Existing QA/synthetic entrypoint. Kept API-compatible and non-production. */
export function compileIntegratedPlan(raw){
  const d=raw;if(d?.schemaVersion!=='F8_INTEGRATED_PLAN_INPUT_V1'||!['SYNTHETIC_TEST_ONLY','WORKING_QA'].includes(d.mode)||!d.ownerId||!d.currency||!d.asOfDate||!Array.isArray(d.sources)||!d.sources.length||!Array.isArray(d.candidates)||!d.candidates.length||!d.baselineCandidateId)fail('complete integrated plan input required');
  return compileIntegratedPlanCore(d,{optimizer:optimizeJointGlobal,productionReady:false,blockedReasons:['PRODUCTION_LEGAL_ECONOMIC_CONTRACTS_UNVERIFIED','LIVE_EVENT_EXECUTION_NOT_BOUND']});
}

function controlledEvidenceDigest(d){return hash(d.candidates.flatMap(c=>c.frontiers.map(e=>({candidateId:c.id,evidence:e}))))}
function controlledCommonStateIsZero(d){return (d.commonStateScenarioValues??[]).every(x=>Math.abs(x?.familyValue?.amount??0)<=EPS&&(x.rightIds??[]).length===0)}
function validateControlledLiveIntegratedInput(runtimeEnvelope,d){
  const authority=assertControlledRuntime(runtimeEnvelope);assertNoQaLegacyEvidence(d);
  if(d?.schemaVersion!=='F8_INTEGRATED_PLAN_INPUT_V1'||d.mode!=='CONTROLLED_LIVE'||d.productionVerified!==true||!d.ownerId||!d.currency||!d.asOfDate||!Array.isArray(d.sources)||d.sources.length!==1||!Array.isArray(d.candidates)||d.candidates.length!==2||!d.baselineCandidateId)fail('complete first-scope CONTROLLED_LIVE integrated input required');
  const refs=assertControlledReferences(runtimeEnvelope,d.provenance?.sourceReferences,'CONTROLLED_LIVE integrated input');
  if(d.provenance?.runtimeEnvelopeHash!==authority.runtimeEnvelopeHash||d.provenance?.productionVerified!==true)fail('integrated input not cryptographically bound to verified runtime envelope');
  if(d.contractEvidence)fail('L3 Rotation-only CONTROLLED_LIVE forbids contract menu/Q/q evidence');
  if(!controlledCommonStateIsZero(d))fail('L3 Rotation-only CONTROLLED_LIVE requires zero explicitly-known common state');
  assertMortalityBoundToRuntime(d.jointMortality,runtimeEnvelope);
  if(d.valuationConvention?.productionVerified!==true||d.valuationConvention?.provenance?.runtimeEnvelopeHash!==authority.runtimeEnvelopeHash)fail('verified valuation convention bound to runtime required');
  assertControlledReferences(runtimeEnvelope,d.valuationConvention.provenance.sourceReferences,'valuation convention');
  for(const s of d.sources)assertControlledSource(s,runtimeEnvelope);
  const baseline=d.candidates.find(c=>c.id===d.baselineCandidateId),positive=d.candidates.find(c=>c.id!==d.baselineCandidateId);
  if(!baseline||!positive||baseline.frontiers.some(e=>e.actionType!=='RESIDUAL')||positive.frontiers.filter(e=>e.actionType==='ROTATION').length!==1||positive.frontiers.some(e=>!['RESIDUAL','ROTATION'].includes(e.actionType)))fail('L3 scope is residual baseline versus one positive Rotation candidate');
  for(const c of d.candidates){if(c.serviceEvidence)fail('L3 Rotation-only candidate cannot contain service evidence');for(const e of c.frontiers){const m=evidenceMeta(e);if(e.mode!=='CONTROLLED_LIVE'||m.kind!=='CONTROLLED_LIVE_STATIC'||m.authorization?.runtimeEnvelopeHash!==authority.runtimeEnvelopeHash)fail('candidate evidence not bound to verified runtime')}}
  const evidenceDigest=controlledEvidenceDigest(d);
  const m10Authority=cloneFreeze({schemaVersion:'F8_M10_CONTROLLED_LIVE_AUTHORITY_V1',productionVerified:true,runtimeEnvelopeHash:authority.runtimeEnvelopeHash,evidenceDigest,exactDateExecution:'VERIFIED',winnerRequiredEvidenceVerified:true,sourceReferences:refs});
  return {runtimeEnvelope, runtimeEnvelopeHash:authority.runtimeEnvelopeHash,evidenceDigest,m10Authority};
}

/** Native CONTROLLED_LIVE entrypoint. No mode translation and no fallback. */
export function compileIntegratedPlanControlledLive({runtimeEnvelope,integratedInput}){
  const controlledContext=validateControlledLiveIntegratedInput(runtimeEnvelope,integratedInput);
  return compileIntegratedPlanCore(integratedInput,{optimizer:optimizeJointGlobalControlledLive,productionReady:true,blockedReasons:[],controlledContext});
}

export class IntegratedPlanStore{
  #stateHash;#selected=null;
  constructor(canonicalState){this.#stateHash=stateHash(canonicalState)}
  stateHash(){return this.#stateHash}
  selected(){return this.#selected}
  replaceCanonicalState(canonicalState){this.#stateHash=stateHash(canonicalState);this.#selected=null}
  commit(draft){if(draft?.schemaVersion!=='F8_INTEGRATED_PLAN_DRAFT_V1')fail('integrated plan draft required');if(draft.openingStateHash!==this.#stateHash)fail('stale integrated plan draft');const committed=cloneFreeze({...draft,status:'COMMITTED_PLAN_SNAPSHOT'});this.#selected=committed;return committed}
}
