import crypto from 'node:crypto';
import {MethodologyBlocked,normalizeValuationConvention} from '../m1/valuation.js';
import {createJointMortality} from '../m9/joint-mortality.js';
import {enumerateContractMenu} from '../m7/contract-options.js';
import {evaluateNativeAnnuitizationPointProfessionalSimulationBeta} from './native-annuitization-point.js';
import {DECISION_EPS} from '../shared/numerical-contract.js';

const EPS=1e-8,MODE='PROFESSIONAL_SIMULATION_BETA';
const fail=m=>{throw new MethodologyBlocked(m)};
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x)}return x};
const copyFreeze=x=>freeze(structuredClone(x));
const num=(v,label)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<0)fail(`${label} must be nonnegative finite`);return v};
const near=(a,b)=>Math.abs(a-b)<=Math.max(1e-7,Math.max(Math.abs(a),Math.abs(b))*1e-8);
const stable=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const hash=v=>crypto.createHash('sha256').update(stable(v)).digest('hex');
const forbiddenSlider=x=>{for(const k of ['memberDeathAge','spouseDeathAge','deathSlider','scenarioDeathAge'])if(Object.hasOwn(x,k))fail('scenario slider cannot enter q frontier generation')};
const forbiddenExternal=x=>{for(const k of ['qMax','qGrid','qPoints','points','scenarioValues','frontierValues','receiptSchedule','receipts'])if(Object.hasOwn(x,k))fail(`external q frontier economics forbidden: ${k}`)};
const branchEnd=b=>b.member.kind==='DEATH'?b.member.deathDate:b.member.terminalDate;

function provenanceOk(p,hashValue){return p?.verificationStatus==='SIMULATION_ASSUMPTION'&&p.productionVerified===false&&p.assumptionPackHash===hashValue&&!!p.version&&!!p.sourceReference}
function validateSliceSemantics(s,input){
  if(s?.schemaVersion!=='F8_M8_BETA_Q_SOURCE_SLICE_SEMANTICS_V1'||s.mode!==MODE||s.simulationAuthorized!==true||s.productionVerified!==false||
    s.assumptionPackHash!==input.assumptionPackHash||s.basisMethod!=='PRO_RATA_HOMOGENEOUS_SOURCE'||s.commitmentSemantics!=='HARD_EXOGENOUS_ONLY'||
    !Array.isArray(s.commitmentRecords)||!provenanceOk(s.provenance,input.assumptionPackHash))fail('explicit Beta q source-slice semantics required');
  const committed=num(s.committedCapital??0,'committed source capital');
  if(committed>input.sourceState.amount+EPS)fail('committed source capital exceeds source');
  const allowed=new Set(['REQUIRED_SERVICE_COMMITMENT','LEGAL_LOCK','PREEXISTING_IRREVOCABLE_COMMITMENT']);let sum=0,ids=new Set();
  for(const r of s.commitmentRecords){if(!r?.id||ids.has(r.id)||r.sourceId!==input.sourceState.id||r.asOfDate!==input.asOfDate||!allowed.has(r.reasonCode)||!provenanceOk(r.provenance,input.assumptionPackHash))fail('committed capital requires source-bound dated ex-ante provenance');ids.add(r.id);sum+=num(r.amount,'commitment amount')}
  if(!near(sum,committed))fail('committed capital must reconcile to explicit hard commitment records');
  return s;
}
function validateStructureAdapter(a,input){
  if(a?.schemaVersion!=='F8_M8_BETA_Q_FRONTIER_STRUCTURE_ADAPTER_V1'||a.mode!==MODE||a.simulationAuthorized!==true||a.productionVerified!==false||
    a.assumptionPackHash!==input.assumptionPackHash||a.piecewiseLinearCertified!==true||a.certificationScope!=='QR2_POINT_ECONOMICS'||
    a.certificationMethod!=='STRUCTURAL_KINK_COMPLETE_V1'||a.topologyInputContract!=='EX_ANTE_WHITELIST_V1'||
    !a.breakpointsByContractOptionId||Array.isArray(a.breakpointsByContractOptionId)||typeof a.breakpointsByContractOptionId!=='object'||
    Object.hasOwn(a,'economicBreakpoints')||!a.version||!provenanceOk(a.provenance,input.assumptionPackHash))fail('explicit static Beta q frontier-structure certificate required');
  return a;
}
function validateSource(s,input){
  if(!s?.id||!s.economicPathId||s.ownerId!==input.ownerId||s.currency!==input.currency||s.stateDate!==input.asOfDate||!s.wrapper||!s.exactQuotes)fail('canonical q frontier source state required');
  for(const f of ['amount','basisNominal','basisIndexed'])num(s[f],`q frontier source ${f}`);
  if(s.amount<=DECISION_EPS)fail('positive canonical q source required');
  return s;
}
function normalize(raw,adapters){
  const input=structuredClone(raw);forbiddenSlider(input);forbiddenExternal(input);
  if(input?.schemaVersion!=='F8_M8_NATIVE_Q_FRONTIER_V1'||input.mode!==MODE||!input.caseId||!input.ownerId||!input.currency||!input.asOfDate||
    !/^[a-f0-9]{64}$/i.test(input.assumptionPackHash??'')||!input.provenance?.version||input.provenance.simulationMode!==MODE||input.provenance.productionVerified!==false||
    !['NO','YES'].includes(input.qPermission)||!input.sourceState||!input.sourceSliceSemantics||!input.m7ContractMenu||!input.jointMortality||!input.valuationConvention||
    !input.paymentSemanticsByOptionId||!input.receiptTreatmentByOptionId||!input.receiptStateModels||!Array.isArray(input.capacity)||!input.residualDestination)
    fail('complete qR3 Professional Simulation frontier input required');
  const source=validateSource(input.sourceState,input),slice=validateSliceSemantics(input.sourceSliceSemantics,input),structure=validateStructureAdapter(adapters?.frontierStructureAdapter,input);
  if(!adapters?.sourceAnnuitizationAdapter||!adapters?.continuationAdapter)fail('qR2 adapters required by qR3');
  const joint=createJointMortality(input.jointMortality),valuation=normalizeValuationConvention(input.valuationConvention);
  if(valuation.baseDate!==input.asOfDate)fail('q frontier valuation base must equal source as-of date');
  const menu=enumerateContractMenu(input.m7ContractMenu);
  return {input:copyFreeze(input),source:copyFreeze(source),slice:copyFreeze(slice),structure,joint,valuation,menu,pointAdapters:{sourceAnnuitizationAdapter:adapters.sourceAnnuitizationAdapter,continuationAdapter:adapters.continuationAdapter}};
}
function sliceSource(input,source,slice,qCapital,option){
  if(qCapital<=DECISION_EPS)return copyFreeze(source);
  const available=source.amount-(slice.committedCapital??0);if(qCapital>available+EPS)fail('q point exceeds actually feasible source capital');
  if(source.availabilityDate&&source.availabilityDate>option.commencementDate)fail('q source is not available by contractual commencement');
  const ratio=qCapital/source.amount;
  return copyFreeze({...source,id:`${source.id}:qr3:${option.id}:${qCapital}`,economicPathId:`${source.economicPathId}:qr3:${option.id}:${qCapital}`,
    sourceEventId:`${source.sourceEventId??source.id}:qr3:${option.id}:${qCapital}`,amount:qCapital,basisNominal:source.basisNominal*ratio,basisIndexed:source.basisIndexed*ratio});
}
function pointInput(n,option,qCapital){
  const p=n.input.paymentSemanticsByOptionId[option.id],t=n.input.receiptTreatmentByOptionId[option.id];
  if(!p||!t)fail(`q option assumptions missing: ${option.id}`);
  return {schemaVersion:'F8_M8_NATIVE_Q_POINT_V1',mode:MODE,caseId:`${n.input.caseId}:qr3:${option.id}:${qCapital}`,ownerId:n.input.ownerId,currency:n.input.currency,
    assumptionPackHash:n.input.assumptionPackHash,provenance:{version:`QR3_POINT:${n.input.provenance.version}:${option.id}:${qCapital}`,simulationMode:MODE,productionVerified:false},qCapital,
    preExistingRightIds:[...(n.input.preExistingRightIds??[])],sourceState:sliceSource(n.input,n.source,n.slice,qCapital,option),m7ContractMenu:n.input.m7ContractMenu,contractOptionId:option.id,
    jointMortality:n.input.jointMortality,paymentSemantics:p,receiptTreatment:t,capacity:n.input.capacity,receiptQualifyingPolicyByDate:n.input.receiptQualifyingPolicyByDate??{},
    receiptStateModels:n.input.receiptStateModels,residualDestination:n.input.residualDestination,valuationConvention:n.input.valuationConvention};
}
function validatePoint(result,n,option,qCapital){
  if(result?.schemaVersion!=='F8_M8_NATIVE_Q_POINT_RESULT_V1'||result.qCapital!==qCapital||result.contractOptionId!==option.id||result.annuitizationDecisionCertified!==false)fail('qR2 point result contract changed');
  if(result.valuationBasis.baseDate!==n.valuation.baseDate||result.valuationBasis.moneyBasis!==n.valuation.moneyBasis||result.valuationBasis.conventionVersion!==n.valuation.version)fail('q frontier point valuation basis mismatch');
  if(qCapital>DECISION_EPS){if(Math.abs(result.reconciliation.sourceConversionGap)>EPS||result.reconciliation.receiptRootGaps.some(x=>Math.abs(x)>EPS)||result.reconciliation.receiptStateGaps.some(x=>Math.abs(x)>EPS)||result.reconciliation.branchFamilyValueGaps.some(x=>Math.abs(x)>EPS))fail('qR2 point reconciliation not closed');
    if(result.antiDoubleCount.sourceCapitalAndRight!==false||result.antiDoubleCount.receiptPvAndEstate!==false||result.antiDoubleCount.preExistingRightsCredited!==false)fail('qR2 anti-double-count contract changed')}
  return result;
}
function moneyScenarioValues(result,n){
  const map=new Map(result.scenarioValues.map(x=>[x.branchId,x.familyValue]));
  return n.joint.branches.map(b=>{if(!map.has(b.id))fail('qR2 branch value missing from frontier point');return {branchId:b.id,familyValue:{amount:map.get(b.id),valuationDate:branchEnd(b),moneyBasis:n.valuation.moneyBasis,taxStatus:'NET',ownerId:'family',productId:'QR3_OPTIONAL_ANNUITIZATION',currency:n.input.currency}}});
}
function pointPublic(result,n){return copyFreeze({qCapital:result.qCapital,contractOptionId:result.contractOptionId,commencementDate:result.commencementDate,scenarioValues:moneyScenarioValues(result,n),expectedNetFamilyValue:result.expectedNetFamilyValue,valuationBasis:result.valuationBasis,reconciliation:{sourceConversionGap:result.qCapital>DECISION_EPS?result.reconciliation.sourceConversionGap:0,branchFamilyValueGaps:result.qCapital>DECISION_EPS?result.reconciliation.branchFamilyValueGaps:[]},antiDoubleCount:result.qCapital>DECISION_EPS?result.antiDoubleCount:{sourceCapitalAndRight:false,receiptPvAndEstate:false,preExistingRightsCredited:false},provenance:result.provenance})}
function verifyAffineAuditPoint(a,m,b){
  const w=(m.qCapital-a.qCapital)/(b.qCapital-a.qCapital);
  const am=new Map(a.scenarioValues.map(x=>[x.branchId,x.familyValue.amount])),mm=new Map(m.scenarioValues.map(x=>[x.branchId,x.familyValue.amount])),bm=new Map(b.scenarioValues.map(x=>[x.branchId,x.familyValue.amount]));
  for(const [id,av] of am){const expected=av+w*(bm.get(id)-av);if(!near(mm.get(id),expected))fail(`unsupported q nonlinearity contradicts structural affine certificate: ${id}`)}
  if(!near(m.expectedNetFamilyValue,a.expectedNetFamilyValue+w*(b.expectedNetFamilyValue-a.expectedNetFamilyValue)))fail('unsupported q expected-value nonlinearity contradicts structural affine certificate');
}
function expectedSlope(a,b){return (b.expectedNetFamilyValue-a.expectedNetFamilyValue)/(b.qCapital-a.qCapital)}

const frontierMeta=new WeakMap();
export function getNativeAnnuitizationFrontierCompilerPayload(packet,optionId){
  const meta=frontierMeta.get(packet);if(!meta)fail('unbranded native q frontier packet');const f=meta.options.get(optionId);if(!f)fail('native q frontier option missing');
  return {permission:meta.permission,source:meta.source,jointMortality:meta.jointMortality,valuationConvention:meta.valuationConvention,option:f.option,points:f.points,
    provenance:f.provenance,evaluateAt:f.evaluateAt,maximum:f.maximum,frontierVersion:packet.provenance.version,assumptionPackHash:meta.assumptionPackHash,capacity:meta.capacity};
}

/** qR3 only: produces M10-ready native q frontier alternatives from qR2 point economics.
 * It does not run M10, choose a winner, or certify an annuitization decision. */
export function buildNativeAnnuitizationFrontierProfessionalSimulationBeta(raw,adapters){
  const n=normalize(raw,adapters),available=Math.max(0,n.source.amount-(n.slice.committedCapital??0)),cache=new Map(),optionMeta=new Map(),frontiers=[];
  const evaluate=(option,capital)=>{const key=`${option.id}|${capital}`;if(cache.has(key))return cache.get(key);const result=validatePoint(evaluateNativeAnnuitizationPointProfessionalSimulationBeta(pointInput(n,option,capital),n.pointAdapters),n,option,capital);cache.set(key,result);return result};
  const feasibleOptions=n.menu.candidates;
  if(!feasibleOptions.length)fail('no M7-feasible contract option for q frontier');
  for(const option of feasibleOptions){
    const max=option.commencementDate<(n.source.availabilityDate??n.source.stateDate)?0:available;
    const zero=pointPublic(evaluate(option,0),n);
    if(n.input.qPermission==='NO'||max<=DECISION_EPS){const provenance=copyFreeze({version:`QR3_FRONTIER:${n.input.provenance.version}:${option.id}`,simulationMode:MODE,productionVerified:false,derivation:'QR2_NATIVE_POINT_ECONOMICS',structureAdapterVersion:n.structure.version});const row=copyFreeze({contractOptionId:option.id,commencementDate:option.commencementDate,feasibleRange:{min:0,max:0},points:[zero],m10OfferReady:false,provenance,annuitizationDecisionCertified:false});frontiers.push(row);optionMeta.set(option.id,{option:copyFreeze(option),points:row.points,maximum:0,provenance,evaluateAt:amount=>{if(amount>DECISION_EPS)fail('q permission NO permits zero only');return evaluate(option,0)}});continue}
    const rawBreaks=n.structure.breakpointsByContractOptionId[option.id];
    if(!Array.isArray(rawBreaks))fail(`static kink-complete breakpoint rows required for option ${option.id}`);
    const capitals=[0];for(const r of rawBreaks){if(!r?.reason||!r.provenance?.version||r.topologyOrigin!=='EX_ANTE_WHITELIST')fail('economic breakpoint static topology provenance required');num(r.capital,'economic breakpoint capital');if(r.capital<=DECISION_EPS||r.capital>=max-DECISION_EPS)fail('internal economic breakpoint must lie strictly inside feasible range');capitals.push(r.capital)}capitals.push(max);capitals.sort((a,b)=>a-b);for(let i=1;i<capitals.length;i++)if(capitals[i]-capitals[i-1]<=DECISION_EPS)fail('duplicate/degenerate q breakpoint');
    const points=capitals.map(c=>pointPublic(evaluate(option,c),n));
    // Structural certificate is the authority; these deterministic probes are an adversarial
    // consistency audit, not a sampled proof of completeness.
    for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i];for(const f of [.25,.5,.75]){const c=a.qCapital+f*(b.qCapital-a.qCapital),m=pointPublic(evaluate(option,c),n);verifyAffineAuditPoint(a,m,b)}}
    let prevSlope=Infinity;for(let i=1;i<points.length;i++){const s=expectedSlope(points[i-1],points[i]);if(s>prevSlope+1e-9)fail('native q frontier is non-concave and cannot enter frozen M10');prevSlope=s}
    const provenance=copyFreeze({version:`QR3_FRONTIER:${n.input.provenance.version}:${option.id}`,simulationMode:MODE,productionVerified:false,derivation:'QR2_NATIVE_POINT_ECONOMICS',structureAdapterVersion:n.structure.version,structureCertificationMethod:n.structure.certificationMethod,topologyInputContract:n.structure.topologyInputContract,breakpointDigest:hash(rawBreaks)}),row=copyFreeze({contractOptionId:option.id,commencementDate:option.commencementDate,feasibleRange:{min:0,max},points,internalEconomicBreakpoints:rawBreaks.map(x=>copyFreeze(x)),m10OfferReady:true,provenance,annuitizationDecisionCertified:false});
    frontiers.push(row);optionMeta.set(option.id,{option:copyFreeze(option),points:row.points,maximum:max,provenance,evaluateAt:amount=>{num(amount,'selected q amount');if(amount>max+DECISION_EPS)fail('selected q amount beyond frontier');return evaluate(option,amount)}});
  }
  const packet=copyFreeze({schemaVersion:'F8_M8_NATIVE_Q_FRONTIER_RESULT_V1',mode:MODE,caseId:n.input.caseId,qPermission:n.input.qPermission,sourceId:n.source.id,sourceFingerprint:hash({id:n.source.id,economicPathId:n.source.economicPathId,ownerId:n.source.ownerId,currency:n.source.currency,stateDate:n.source.stateDate,amount:n.source.amount,basisNominal:n.source.basisNominal,basisIndexed:n.source.basisIndexed}),feasibleSourceCapital:available,contractOptionIds:frontiers.map(x=>x.contractOptionId),frontiers,valuationBasis:{baseDate:n.valuation.baseDate,moneyBasis:n.valuation.moneyBasis,conventionVersion:n.valuation.version},mortalityVersion:n.joint.version,assumptionPackHash:n.input.assumptionPackHash,provenance:{version:`QR3_NATIVE_FRONTIER:${n.input.provenance.version}`,simulationMode:MODE,productionVerified:false,structureAdapterVersion:n.structure.version,structureCertificationMethod:n.structure.certificationMethod,topologyInputContract:n.structure.topologyInputContract},annuitizationDecisionCertified:false,globalOptimal:false,productionReady:false});
  frontierMeta.set(packet,{permission:n.input.qPermission,source:n.source,jointMortality:n.input.jointMortality,valuationConvention:n.input.valuationConvention,assumptionPackHash:n.input.assumptionPackHash,capacity:copyFreeze(n.input.capacity),options:optionMeta});return packet;
}
