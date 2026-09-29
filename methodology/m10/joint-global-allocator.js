import {allocateUnifiedResidual} from '../m3/residual-allocator.js';
import {createJointMortality} from '../m9/joint-mortality.js';
import {evaluateClosedDistribution, normalizeValuationConvention, normalizeMoneyValue, valueAtBase, MethodologyBlocked} from '../m1/valuation.js';
import {DECISION_EPS} from '../shared/numerical-contract.js';

const EPS=1e-8;
const fail=m=>{throw new MethodologyBlocked(m)};
const deepFreeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(deepFreeze);Object.freeze(x)}return x};
const cloneFreeze=x=>deepFreeze(structuredClone(x));
const finite=(n,label)=>{if(typeof n!=='number'||!Number.isFinite(n)||n<0)fail(`${label} must be finite nonnegative`);return n};
const same=(a,b)=>Math.abs(a-b)<=Math.max(1e-9,Math.max(Math.abs(a),Math.abs(b))*1e-9);
const sameCapital=(a,b)=>Math.abs(a-b)<=Math.max(1e-11,8*Number.EPSILON*Math.max(1,Math.abs(a),Math.abs(b)));

function branchEndDate(branch){
  return branch.member.kind==='DEATH'?branch.member.deathDate:branch.member.terminalDate;
}
function branchKind(branch){return branch.member.kind==='DEATH'?'MEMBER_DEATH':'SURVIVE_TO_TERMINAL_HORIZON'}
function asClosedScenarios(values,joint,convention,label){
  if(!Array.isArray(values)||values.length!==joint.branches.length)fail(`${label}: complete joint branch values required`);
  const byId=new Map(values.map(v=>[v.branchId,v]));
  if(byId.size!==values.length)fail(`${label}: duplicate branch value`);
  const scenarios=joint.branches.map(branch=>{
    const row=byId.get(branch.id);if(!row)fail(`${label}: missing branch ${branch.id}`);
    const m=normalizeMoneyValue(row.familyValue);
    const end=branchEndDate(branch);
    if(m.valuationDate!==end||m.moneyBasis!==convention.moneyBasis||m.taxStatus!=='NET')
      fail(`${label}: normalized net value at branch date required`);
    const base={id:branch.id,kind:branchKind(branch),probability:branch.probability,familyValue:m};
    return base.kind==='MEMBER_DEATH'?{...base,memberDeathDate:end}:{...base,terminalDate:end};
  });
  return {expected:evaluateClosedDistribution(scenarios,convention),byId};
}
function zeroValues(joint,convention,ownerId,currency,productId='ZERO'){
  return joint.branches.map(b=>({branchId:b.id,familyValue:{amount:0,valuationDate:branchEndDate(b),
    moneyBasis:convention.moneyBasis,taxStatus:'NET',ownerId,productId,currency}}));
}
function validateRightIds(rows,commonIds,label){
  const seen=new Set();
  for(const row of rows){
    if(!Array.isArray(row.rightIds))continue;
    const local=new Set();
    for(const id of row.rightIds){if(typeof id!=='string'||!id)fail(`${label}: invalid right id`);
      if(commonIds.has(id))fail(`${label}: pre-existing right cannot be credited again`);
      if(local.has(id))fail(`${label}: duplicate right inside one scenario value`);local.add(id);seen.add(id)}
  }
  return seen;
}
function scenarioQuoteToExpected(quote,joint,convention,label){
  finite(quote.capital,`${label} capital`);
  return asClosedScenarios(quote.scenarioValues,joint,convention,label).expected.expectedNetFamilyValue;
}
function prepareOffers(candidate,input,joint,convention){
  if(!Array.isArray(candidate.offers)||!candidate.offers.length)fail('candidate offers required');
  const streams=new Set();
  const scenarioSegments=[],scenarioOffers=[];
  const offers=candidate.offers.map((o,oi)=>{
    if(!o.valueStreamId||streams.has(o.valueStreamId)||!o.actionType||!o.sourceId||!o.destinationId||
      !o.entryRoute||!o.provenance?.version||!Array.isArray(o.quotes)||o.quotes.length<2)
      fail('unique provenanced joint offer required');
    streams.add(o.valueStreamId);
    let prev=null;
    const quotes=o.quotes.map((q,qi)=>{
      const expected=scenarioQuoteToExpected(q,joint,convention,`candidate ${candidate.id} offer ${o.valueStreamId} quote ${qi}`);
      if(prev&&q.capital<=prev.capital)fail('strictly increasing joint quote capital required');
      if(qi===0&&(q.capital!==0||Math.abs(expected)>EPS))fail('joint offer zero quote must anchor zero value');
      if(prev){
        const fromMap=new Map(prev.scenarioValues.map(v=>[v.branchId,v.familyValue.amount]));
        const toMap=new Map(q.scenarioValues.map(v=>[v.branchId,v.familyValue.amount]));
        scenarioSegments.push({sourceId:o.sourceId,destinationId:o.destinationId,entryRoute:o.entryRoute,
          actionType:o.actionType,valueStreamId:o.valueStreamId,quotedFrom:prev.capital,quotedTo:q.capital,
          scenarioMarginals:Object.fromEntries(joint.branches.map(b=>[b.id,(toMap.get(b.id)-fromMap.get(b.id))/(q.capital-prev.capital)]))});
      }
      prev=q;
      return {capital:q.capital,netFamilyValue:expected};
    });
    scenarioOffers.push({sourceId:o.sourceId,destinationId:o.destinationId,entryRoute:o.entryRoute,actionType:o.actionType,valueStreamId:o.valueStreamId,quotes:o.quotes});
    return {sourceId:o.sourceId,destinationId:o.destinationId,entryRoute:o.entryRoute,actionType:o.actionType,valueStreamId:o.valueStreamId,
      provenance:o.provenance,quotes};
  });
  return {offers,scenarioSegments,scenarioOffers};
}
function interpolateAllocationScenario(allocation,segments,branchId){
  const segment=segments.find(s=>s.sourceId===allocation.sourceId&&s.destinationId===allocation.destinationId&&
    s.entryRoute===allocation.entryRoute&&same(s.quotedFrom,allocation.quotedFrom)&&same(s.quotedTo,allocation.quotedTo));
  if(!segment)fail('selected allocation cannot be mapped back to scenario-valued segment');
  return {segment,amount:allocation.amount*segment.scenarioMarginals[branchId]};
}


function scenarioValueAtTotal(prepared,valueStreamId,total,branchId){
  const offer=prepared.scenarioOffers.find(o=>o.valueStreamId===valueStreamId);if(!offer)fail('selected value stream lacks original scenario frontier');
  if(total<=DECISION_EPS)return 0;
  const q=offer.quotes,last=q.at(-1);
  if(sameCapital(last.capital,total))return last.scenarioValues.find(v=>v.branchId===branchId)?.familyValue.amount??fail('scenario branch missing at terminal quote');
  const hi=q.findIndex(x=>x.capital>=total);if(hi<0)fail('selected total exceeds original scenario frontier');
  if(hi===0)return q[0].scenarioValues.find(v=>v.branchId===branchId)?.familyValue.amount??fail('scenario branch missing at zero quote');
  const lo=q[hi-1],up=q[hi],loRow=lo.scenarioValues.find(v=>v.branchId===branchId),upRow=up.scenarioValues.find(v=>v.branchId===branchId);
  if(!loRow||!upRow)fail('scenario branch missing from original frontier');
  if(sameCapital(up.capital,total))return upRow.familyValue.amount;
  const w=(total-lo.capital)/(up.capital-lo.capital);return loRow.familyValue.amount+w*(upRow.familyValue.amount-loRow.familyValue.amount);
}
function emptyCapitalPlan(sources){
  return {schemaVersion:'F8_UNIFIED_RESIDUAL_PLAN_V1',sources:sources.map(s=>({sourceId:s.id,originPathId:s.economicPathId,openingAmount:s.amount,allocated:0,unallocated:s.amount})),allocations:[],frontier:[],expectedNetFamilyValue:0,totalCapital:sources.reduce((n,s)=>n+s.amount,0),pathAllocationGap:sources.reduce((n,s)=>n+s.amount,0),globalCertificate:'PIECEWISE_CONCAVE_LP_ONLY',productionVerified:false};
}

function trimOffersToSourceSupply(offers,sources){
  const caps=new Map(sources.map(s=>[s.id,s.amount]));
  return offers.map(o=>{
    const cap=caps.get(o.sourceId);if(cap===undefined)fail('offer source missing after required allocation');
    if(cap<=DECISION_EPS)return null;
    const q=o.quotes;if(q.at(-1).capital<cap||sameCapital(q.at(-1).capital,cap))return o;
    const kept=q.filter(x=>x.capital<cap&&!sameCapital(x.capital,cap));
    let exact=q.find(x=>sameCapital(x.capital,cap));
    if(!exact){
      const hi=q.findIndex(x=>x.capital>cap);if(hi<=0)fail('cannot interpolate trimmed offer');
      const lo=q[hi-1],up=q[hi],w=(cap-lo.capital)/(up.capital-lo.capital),upMap=new Map(up.scenarioValues.map(v=>[v.branchId,v]));
      exact={capital:cap,scenarioValues:lo.scenarioValues.map(v=>{const u=upMap.get(v.branchId);if(!u)fail('trimmed offer branch mismatch');return {...v,familyValue:{...v.familyValue,amount:v.familyValue.amount+w*(u.familyValue.amount-v.familyValue.amount)}}})};
    }
    return {...o,quotes:[...kept,exact]};
  }).filter(Boolean);
}
function candidatePlan(candidate,input,joint,convention,common,{productionVerified=false}={}){
  if(!candidate.id||candidate.serviceSatisfied!==true||candidate.protectionSatisfied!==true||
     !candidate.contractOptionId||!candidate.serviceChoiceId||!candidate.provenance?.version)
    fail('feasible discrete contract/service candidate required');
  const required=Array.isArray(candidate.requiredCapitalAllocations)?candidate.requiredCapitalAllocations:[];
  const sourceMap=new Map(input.sources.map(s=>[s.id,s]));
  const reservedBySource=new Map(input.sources.map(s=>[s.id,0]));
  const requiredValues=zeroValues(joint,convention,input.ownerId,input.currency,`REQUIRED:${candidate.id}`);
  const requiredByBranch=new Map(requiredValues.map(v=>[v.branchId,v]));
  const requiredActions=[];
  for(const [i,r] of required.entries()){
    if(!r?.id||!r.actionType||!r.sourceId||!r.destinationId||!r.entryRoute||!r.provenance?.version)
      fail('required capital allocation needs explicit provenance');
    const source=sourceMap.get(r.sourceId);if(!source)fail('required allocation source missing');
    finite(r.amount,`required allocation ${r.id} amount`);
    reservedBySource.set(r.sourceId,(reservedBySource.get(r.sourceId)||0)+r.amount);
    if(reservedBySource.get(r.sourceId)>source.amount+EPS)fail('required capital exceeds source');
    if(!Object.hasOwn(r,'scenarioValues')||r.scenarioValues==null)fail(`required allocation ${r.id}: explicit scenario values required`);
    const closedRequired=asClosedScenarios(r.scenarioValues,joint,convention,`required allocation ${r.id}`);
    validateRightIds(r.scenarioValues,common.rightIds,`required allocation ${r.id}`);
    for(const branch of joint.branches){
      const row=requiredByBranch.get(branch.id),add=closedRequired.byId.get(branch.id);
      row.familyValue.amount+=add.familyValue.amount;
      row.rightIds=[...(row.rightIds??[]),...(add.rightIds??[])];
    }
    requiredActions.push({actionId:r.id,actionType:r.actionType,sourceId:r.sourceId,
      originPathId:source.economicPathId,destinationId:r.destinationId,entryRoute:r.entryRoute,
      amount:r.amount,expectedNetFamilyValue:closedRequired.expected.expectedNetFamilyValue,
      valueStreamId:r.valueStreamId??`required:${r.id}`,reasonCode:r.reasonCode??'REQUIRED_CONSTRAINT_ALLOCATION',
      provenance:r.provenance,required:true});
  }
  if(Object.hasOwn(candidate,'fixedScenarioValues')&&candidate.fixedScenarioValues==null)fail(`candidate ${candidate.id}: fixed scenario values cannot be null/UNKNOWN`);
  const hasFixed=Object.hasOwn(candidate,'fixedScenarioValues');
  if(!hasFixed&&candidate.fixedScenarioMode!=='NONE'&&input.mode!=='SYNTHETIC_TEST_ONLY')fail(`candidate ${candidate.id}: fixed scenario economics missing/UNKNOWN`);
  const fixed=hasFixed?candidate.fixedScenarioValues:zeroValues(joint,convention,input.ownerId,input.currency,`FIXED_NONE:${candidate.id}`);
  const fixedResult=asClosedScenarios(fixed,joint,convention,`candidate ${candidate.id} fixed values`);
  validateRightIds(fixed,common.rightIds,`candidate ${candidate.id}`);
  const requiredResult=asClosedScenarios([...requiredByBranch.values()],joint,convention,`candidate ${candidate.id} required values`);
  const remainingSources=input.sources.map(s=>({...s,amount:s.amount-(reservedBySource.get(s.id)||0)}));
  if(remainingSources.some(s=>s.amount< -EPS))fail('negative source after required allocation');
  const activeSources=remainingSources.filter(s=>s.amount>DECISION_EPS),activeIds=new Set(activeSources.map(s=>s.id));
  const trimmedOffers=trimOffersToSourceSupply(candidate.offers,remainingSources).filter(o=>activeIds.has(o.sourceId));
  const prepared=trimmedOffers.length?prepareOffers({...candidate,offers:trimmedOffers},input,joint,convention):{offers:[],scenarioSegments:[],scenarioOffers:[]};
  const residualInput={schemaVersion:'F8_UNIFIED_RESIDUAL_V1',asOfDate:input.asOfDate,ownerId:input.ownerId,
    currency:input.currency,sources:activeSources,destinationCaps:candidate.destinationCaps,offers:prepared.offers};
  const capitalPlan=activeSources.length?allocateUnifiedResidual(residualInput):emptyCapitalPlan(remainingSources);
  if(Math.abs(capitalPlan.pathAllocationGap)>EPS)fail('joint candidate left capital without one economic path');
  const sourceConservation=input.sources.map(s=>{const requiredAmount=reservedBySource.get(s.id)||0;
    const planned=capitalPlan.sources.find(x=>x.sourceId===s.id)?.allocated??0;
    const gap=s.amount-requiredAmount-planned; if(Math.abs(gap)>EPS)fail('candidate source capital not fully partitioned');
    return {sourceId:s.id,openingAmount:s.amount,requiredAmount,optimizedAmount:planned,gap};});
  const selectedTotals=new Map();
  for(const allocation of capitalPlan.allocations){const v=interpolateAllocationScenario(allocation,prepared.scenarioSegments,joint.branches[0]?.id);const key=v.segment.valueStreamId,row=selectedTotals.get(key)??{segment:v.segment,capital:0};row.capital+=allocation.amount;selectedTotals.set(key,row)}
  const scenarios=joint.branches.map(branch=>{
    const commonRow=common.byId.get(branch.id),fixedRow=fixedResult.byId.get(branch.id),requiredRow=requiredResult.byId.get(branch.id);
    let amount=commonRow.familyValue.amount+fixedRow.familyValue.amount+requiredRow.familyValue.amount;
    const contributions=[];
    for(const {segment,capital} of selectedTotals.values()){
      const value=scenarioValueAtTotal(prepared,segment.valueStreamId,capital,branch.id);
      amount+=value;contributions.push({valueStreamId:segment.valueStreamId,actionType:segment.actionType,
        sourceId:segment.sourceId,destinationId:segment.destinationId,capital,familyValueAmount:value});
    }
    return {branchId:branch.id,kind:branchKind(branch),probability:branch.probability,
      spouseAliveAtMemberDeath:branch.spouseAliveAtMemberDeath,
      spousePredeceasedMember:branch.spousePredeceasedMember,
      continuationRequired:branch.continuationRequired,
      familyValue:{amount,valuationDate:branchEndDate(branch),moneyBasis:convention.moneyBasis,
        taxStatus:'NET',ownerId:'family',productId:'F8_M10_FAMILY',currency:input.currency},contributions};
  });
  const closed=asClosedScenarios(scenarios,joint,convention,`candidate ${candidate.id} total`);
  const expectedViaParts=common.expected.expectedNetFamilyValue+fixedResult.expected.expectedNetFamilyValue+
    requiredResult.expected.expectedNetFamilyValue+capitalPlan.expectedNetFamilyValue;
  if(!same(closed.expected.expectedNetFamilyValue,expectedViaParts))
    fail('joint expected objective does not reconcile to scenario values');
  const optimizedActions=capitalPlan.allocations.map((a,i)=>{
    const seg=prepared.scenarioSegments.find(s=>s.sourceId===a.sourceId&&s.destinationId===a.destinationId&&
      s.entryRoute===a.entryRoute&&same(s.quotedFrom,a.quotedFrom)&&same(s.quotedTo,a.quotedTo));
    return {actionId:`${candidate.id}:${i}:${seg.actionType}`,actionType:seg.actionType,sourceId:a.sourceId,
      originPathId:a.originPathId,destinationId:a.destinationId,entryRoute:a.entryRoute,amount:a.amount,
      expectedNetFamilyValue:a.netFamilyValue,valueStreamId:seg.valueStreamId,reasonCode:'JOINT_GLOBAL_OPTIMUM',
      provenance:a.provenance,required:false};
  });
  const economicActions=[...requiredActions,...optimizedActions];
  const byType=Object.fromEntries(['RESIDUAL','ROTATION','QUALIFYING','OPTIONAL_ANNUITIZATION','SERVICE_SOURCE','OTHER']
    .map(t=>[t,economicActions.filter(a=>a.actionType===t).reduce((n,a)=>n+a.amount,0)]));
  return cloneFreeze({candidateId:candidate.id,contractOptionId:candidate.contractOptionId,
    serviceChoiceId:candidate.serviceChoiceId,expectedNetFamilyValue:closed.expected.expectedNetFamilyValue,
    fixedExpectedNetFamilyValue:fixedResult.expected.expectedNetFamilyValue,
    requiredExpectedNetFamilyValue:requiredResult.expected.expectedNetFamilyValue,
    capitalExpectedNetFamilyValue:capitalPlan.expectedNetFamilyValue,capitalPlan,economicActions,
    sourceConservation,allocationByType:byType,scenarios,serviceSatisfied:true,protectionSatisfied:true,
    globalCertificate:capitalPlan.globalCertificate,productionVerified});
}


function evaluateDependenceSensitivity(plans,cases,joint,convention,currency,baseWinner){
  if(cases==null)return {tested:false,fragile:false,cases:[]};
  if(!Array.isArray(cases)||!cases.length)fail('explicit dependence sensitivity cases required');
  const branchIds=new Set(joint.branches.map(b=>b.id));
  const results=cases.map(c=>{
    if(!c.id||!Array.isArray(c.branchProbabilities)||c.branchProbabilities.length!==joint.branches.length)
      fail('complete dependence sensitivity probability case required');
    const probs=new Map();let mass=0;
    for(const r of c.branchProbabilities){if(!branchIds.has(r.branchId)||probs.has(r.branchId)||typeof r.probability!=='number'||!Number.isFinite(r.probability)||r.probability<0||r.probability>1)fail('invalid dependence sensitivity probability');probs.set(r.branchId,r.probability);mass+=r.probability}
    if(Math.abs(mass-1)>1e-10)fail('dependence sensitivity probability mass incomplete');
    const ranked=plans.map(p=>{let expected=0;for(const scenario of p.scenarios){
      const base=valueAtBase(scenario.familyValue,convention);expected+=(probs.get(scenario.branchId)??0)*base.amount;
    }return {candidateId:p.candidateId,expectedNetFamilyValue:expected}}).sort((a,b)=>b.expectedNetFamilyValue-a.expectedNetFamilyValue||a.candidateId.localeCompare(b.candidateId));
    return {id:c.id,winnerCandidateId:ranked[0].candidateId,ranked};
  });
  return {tested:true,fragile:results.some(r=>r.winnerCandidateId!==baseWinner),cases:results};
}

/** Outer finite contract/service enumeration × inner continuous piecewise-concave
 * allocation on one shared capital state. Authorization is intentionally kept out
 * of the shared solver core so QA and CONTROLLED_LIVE run identical economics. */
function validateJointGlobalInput(raw,allowedModes){
  const input=structuredClone(raw);
  if(input?.schemaVersion!=='F8_M10_JOINT_GLOBAL_V1'||!allowedModes.includes(input.mode)||
    !input.ownerId||!input.currency||!input.asOfDate||!Array.isArray(input.sources)||!input.sources.length||
    !Array.isArray(input.candidates)||!input.candidates.length||!input.jointMortality||!input.valuationConvention)
    fail('complete M10 joint optimizer DTO required');
  for(const k of ['memberDeathAge','spouseDeathAge','deathSlider','displayBasis'])if(Object.hasOwn(input,k))
    fail('scenario/display controls cannot enter M10 optimizer');
  return input;
}

function optimizeJointGlobalCore(input,{productionVerified=false}={}){
  const convention=normalizeValuationConvention(input.valuationConvention);
  if(convention.baseDate!==input.asOfDate)fail('M10 capital state and valuation base date must match');
  const joint=createJointMortality(input.jointMortality);
  if(Object.hasOwn(input,'commonStateScenarioValues')&&input.commonStateScenarioValues==null)fail('common pre-existing state cannot be null/UNKNOWN');
  const hasCommon=Object.hasOwn(input,'commonStateScenarioValues');
  if(!hasCommon&&input.commonStateMode!=='NONE'&&input.mode!=='SYNTHETIC_TEST_ONLY')fail('common pre-existing state missing/UNKNOWN');
  const commonValues=hasCommon?input.commonStateScenarioValues:zeroValues(joint,convention,input.ownerId,input.currency,'COMMON_NONE');
  const common=asClosedScenarios(commonValues,joint,convention,'common pre-existing state');
  const commonRightIds=new Set();
  for(const row of commonValues){const local=new Set();for(const id of row.rightIds??[]){if(local.has(id))fail('duplicate common right id inside one scenario value');local.add(id);commonRightIds.add(id)}}
  common.rightIds=commonRightIds;
  const ids=new Set();
  const plans=input.candidates.map(c=>{if(ids.has(c.id))fail('duplicate discrete candidate id');ids.add(c.id);return candidatePlan(c,input,joint,convention,common,{productionVerified})});
  if(!ids.has(input.baselineCandidateId))fail('explicit baseline candidate required');
  const ranked=[...plans].sort((a,b)=>b.expectedNetFamilyValue-a.expectedNetFamilyValue||a.candidateId.localeCompare(b.candidateId));
  const winner=ranked[0],baseline=plans.find(p=>p.candidateId===input.baselineCandidateId);
  const nearTieTolerance=finite(input.nearTieTolerance??0,'near tie tolerance');
  const nearTies=ranked.filter(p=>winner.expectedNetFamilyValue-p.expectedNetFamilyValue<=nearTieTolerance+EPS).map(p=>p.candidateId);
  if(nearTieTolerance>0&&nearTies.length>1&&!input.dependenceSensitivityCases)fail('near-tie contract decision requires mortality dependence sensitivity');
  const sensitivity=evaluateDependenceSensitivity(plans,input.dependenceSensitivityCases,joint,convention,input.currency,winner.candidateId);
  return {schemaVersion:'F8_M10_JOINT_GLOBAL_RESULT_V1',mode:input.mode,
    baseDate:convention.baseDate,moneyBasis:convention.moneyBasis,jointMortalityVersion:joint.version,
    probabilityMass:joint.probabilityMass,baselineCandidateId:baseline.candidateId,winnerCandidateId:winner.candidateId,
    expectedNetFamilyValue:winner.expectedNetFamilyValue,baselineExpectedNetFamilyValue:baseline.expectedNetFamilyValue,
    expectedDeltaVsBaseline:winner.expectedNetFamilyValue-baseline.expectedNetFamilyValue,winner,baseline,
    candidates:plans,nearTieCandidateIds:nearTies,mortalityDependenceSensitivity:sensitivity,
    mortalityDependenceFragile:sensitivity.fragile,
    globalOptimal:true,globalCertificate:'FINITE_DISCRETE_OUTER_X_PIECEWISE_CONCAVE_INNER'};
}

/** Existing QA/synthetic entrypoint. Its authorization restrictions and output
 * readiness semantics intentionally remain unchanged. */
export function optimizeJointGlobal(raw){
  const input=structuredClone(raw??{});
  if(!['SYNTHETIC_TEST_ONLY','WORKING_QA'].includes(input.mode))fail('complete M10 joint optimizer DTO required');
  const validated=validateJointGlobalInput(input,['SYNTHETIC_TEST_ONLY','WORKING_QA']);
  return cloneFreeze({...optimizeJointGlobalCore(validated,{productionVerified:false}),
    productionReady:false,blockedReasons:['PRODUCTION_LEGAL_ECONOMIC_CONTRACTS_UNVERIFIED','LIVE_COMMIT_NOT_BOUND']});
}

const forbiddenLiveEvidence=/WORKING_QA|SYNTHETIC_TEST_ONLY|LEGACY_COMPATIBILITY/;
function assertNoForbiddenLiveEvidence(v,path='authority'){
  if(typeof v==='string'&&forbiddenLiveEvidence.test(v))fail(`CONTROLLED_LIVE forbidden evidence at ${path}`);
  if(v&&typeof v==='object')for(const [k,x] of Object.entries(v))assertNoForbiddenLiveEvidence(x,`${path}.${k}`);
}
function validateControlledLiveAuthority(authority){
  const a=structuredClone(authority??{});
  if(a.schemaVersion!=='F8_M10_CONTROLLED_LIVE_AUTHORITY_V1'||a.productionVerified!==true||
    !/^[a-f0-9]{64}$/.test(a.runtimeEnvelopeHash??'')||!/^[a-f0-9]{64}$/.test(a.evidenceDigest??'')||
    a.exactDateExecution!=='VERIFIED'||a.winnerRequiredEvidenceVerified!==true)
    fail('strict M10 CONTROLLED_LIVE authority required');
  assertNoForbiddenLiveEvidence(a);
  return a;
}

/** Native controlled-live entrypoint. It performs authorization only, then calls
 * the exact same shared solver core used by optimizeJointGlobal(). */
export function optimizeJointGlobalControlledLive(raw,authority){
  const input=validateJointGlobalInput(raw,['CONTROLLED_LIVE']);
  const a=validateControlledLiveAuthority(authority);
  return cloneFreeze({...optimizeJointGlobalCore(input,{productionVerified:true}),
    productionReady:true,blockedReasons:[],authorization:{schemaVersion:a.schemaVersion,runtimeEnvelopeHash:a.runtimeEnvelopeHash,evidenceDigest:a.evidenceDigest,exactDateExecution:a.exactDateExecution}});
}
