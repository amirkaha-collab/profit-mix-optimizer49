import {evaluateNativeAnnuitizationPointProfessionalSimulationBeta} from '../../methodology/m8/native-annuitization-point.js';
import {evaluateQualifyingPolicyProfessionalSimulationBeta} from '../../methodology/m5/qualifying-replay.js';
import {buildF8PlanProjection,buildF8ScenarioProjection} from '../../u1/f8-binding.js';
import {stableHash} from '../../u1/f8-stable-hash.js';
import {DECISION_EPS,RECONCILIATION_EPS,isDecisionPositive} from '../../methodology/shared/numerical-contract.js';
import {contractualEqualityStatus} from './q1b-contractual-equality.js';

const MODE='PROFESSIONAL_SIMULATION_BETA';
const BASE='2029-01-01';
const DEFAULT_COMMENCEMENT='2030-01-01';
const HASH='c'.repeat(64);
const SUPPORT_TERMINAL='2035-12-31';
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){for(const v of Object.values(x))freeze(v);Object.freeze(x)}return x};
const clone=x=>structuredClone(x);
const fail=m=>{throw new Error(`Q1B_OPTIONAL_ANNUITIZATION: ${m}`)};
const sum=(xs,f=x=>x)=>xs.reduce((n,x)=>n+f(x),0);
const dateOk=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&new Date(`${s}T00:00:00Z`).toISOString().slice(0,10)===s;
const factor=(fromDate,toDate)=>({fromDate,toDate,grossReturnFactor:1,feeRetentionFactor:1,basisIndexFactor:1,provenance:{version:`Q1B_FACTOR:${fromDate}:${toDate}`}});

export const Q1B_FIXTURE_IDS=freeze([
  'Q1B_Q_ZERO',
  'Q1B_Q_ONLY_DELAYED_FIRST_RECEIPT',
  'Q1B_Q_PLUS_ROTATION',
  'Q1B_Q_PLUS_QUALIFYING',
  'Q1B_R_Q_q_MIXED',
  'Q1B_SURVIVOR_GUARANTEE',
  'Q1B_RECEIPT_FUNDED_Q'
]);

const delayedPayments=['2030-02-01','2030-03-01','2030-04-01','2030-05-01','2030-06-01','2030-07-01','2030-08-01','2030-09-01','2030-10-01','2031-02-01'];
const standardTreat={taxFractionOfGross:0,niHealthFractionOfGross:0,requiredConsumption:0};

const FIXTURE_CONFIG=freeze({
  Q1B_Q_ZERO:{alloc:{R:250,Q:200,q:0,Residual:550},commencementDate:null,paymentDates:[],annuityFactor:null,survivorPercent:0,guaranteeMonths:0,guaranteePaymentDates:[],receiptFundedQ:false,capacity:{available:250,externalAlreadyUsed:10},expectedFamilyValue:1160},
  Q1B_Q_ONLY_DELAYED_FIRST_RECEIPT:{alloc:{R:0,Q:0,q:1000,Residual:0},commencementDate:DEFAULT_COMMENCEMENT,paymentDates:delayedPayments,annuityFactor:10,survivorPercent:0,guaranteeMonths:0,guaranteePaymentDates:[],receiptFundedQ:false,capacity:{available:50,externalAlreadyUsed:0},expectedFamilyValue:1100},
  Q1B_Q_PLUS_ROTATION:{alloc:{R:250,Q:0,q:750,Residual:0},commencementDate:DEFAULT_COMMENCEMENT,paymentDates:delayedPayments,annuityFactor:10,survivorPercent:0,guaranteeMonths:0,guaranteePaymentDates:[],receiptFundedQ:false,capacity:{available:50,externalAlreadyUsed:0},expectedFamilyValue:1200},
  Q1B_Q_PLUS_QUALIFYING:{alloc:{R:0,Q:200,q:800,Residual:0},commencementDate:DEFAULT_COMMENCEMENT,paymentDates:delayedPayments,annuityFactor:10,survivorPercent:0,guaranteeMonths:0,guaranteePaymentDates:[],receiptFundedQ:false,capacity:{available:250,externalAlreadyUsed:10},directQDate:'2030-01-10',expectedFamilyValue:1250},
  Q1B_R_Q_q_MIXED:{alloc:{R:250,Q:200,q:550,Residual:0},commencementDate:DEFAULT_COMMENCEMENT,paymentDates:delayedPayments,annuityFactor:10,survivorPercent:0,guaranteeMonths:0,guaranteePaymentDates:[],receiptFundedQ:true,capacity:{available:250,externalAlreadyUsed:10},directQDate:'2030-01-10',receiptQMaxGross:50,expectedFamilyValue:1325},
  Q1B_SURVIVOR_GUARANTEE:{alloc:{R:0,Q:0,q:1000,Residual:0},commencementDate:DEFAULT_COMMENCEMENT,paymentDates:delayedPayments,annuityFactor:10,survivorPercent:.5,guaranteeMonths:4,guaranteePaymentDates:delayedPayments.slice(0,4),receiptFundedQ:false,capacity:{available:50,externalAlreadyUsed:0},expectedFamilyValue:1150},
  Q1B_RECEIPT_FUNDED_Q:{alloc:{R:0,Q:0,q:1000,Residual:0},commencementDate:DEFAULT_COMMENCEMENT,paymentDates:delayedPayments,annuityFactor:10,survivorPercent:0,guaranteeMonths:0,guaranteePaymentDates:[],receiptFundedQ:true,receiptQMaxGross:50,capacity:{available:50,externalAlreadyUsed:0},treatment:{taxFractionOfGross:.10,niHealthFractionOfGross:.05,requiredConsumption:25},expectedFamilyValue:1100}
});

function normalizedConfig(id){
  const c=FIXTURE_CONFIG[id];if(!c)fail(`unknown fixture ${id}`);
  return clone({...c,treatment:{...standardTreat,...(c.treatment??{})}});
}

function optionFor(id,c){
  if(c.alloc.q<=DECISION_EPS)return null;
  return freeze({id:`${id}:q-option`,contractId:`${id}:Q_CONTRACT`,entryRoute:'DIRECT',survivorPercent:c.survivorPercent,guaranteeMonths:c.guaranteeMonths,commencementDate:c.commencementDate,annuityFactorId:`${id}:factor-${c.annuityFactor}`,provenance:{version:`${id}:M7_OPTION_V1`},entitlements:[
    {coverageStateId:'spouse_alive',date:c.paymentDates[0]??c.commencementDate,recipient:c.survivorPercent>0?'spouse':'member',rightId:`${id}:m7:alive`,ruleId:`${id}:M7_RULE`,gross:1,provenance:{version:`${id}:M7_ENT_ALIVE`}},
    {coverageStateId:'spouse_predeceased',date:c.paymentDates[0]??c.commencementDate,recipient:'member',rightId:`${id}:m7:pre`,ruleId:`${id}:M7_RULE`,gross:1,provenance:{version:`${id}:M7_ENT_PRE`}}
  ]});
}

function frozenSchedule(id,c,option){
  if(!option)return [];
  const consideration=c.alloc.q, gross=consideration/c.annuityFactor, rightId=`qr2:q1b:${id}:annuity-right`;
  return c.paymentDates.map(d=>freeze({id:`qr2:q1b:${id}:receipt:${d}`,date:d,gross,rightId,contractId:option.contractId,ruleId:`Q1B_PAY_PROV:${id}:${option.id}:${option.id}`,sourceEventId:`qr2:q1b:${id}:annuity-payment:${d}`,economicPathId:`qr2:q1b:${id}:receipt-path:${d}`,provenance:{version:`QR2_RECEIPT:Q1B_PAY:${id}:${d}`}}));
}

function optimizerActions(id,c,option){
  const rows=[];
  for(const [type,key] of [['ROTATION','R'],['QUALIFYING','Q'],['OPTIONAL_ANNUITIZATION','q'],['RESIDUAL','Residual']])if(c.alloc[key]>DECISION_EPS)rows.push({actionId:`${id}:selected:${type}`,actionType:type,amount:c.alloc[key],sourceId:`${id}:source`,destinationId:`${id}:${type}`,entryRoute:type==='RESIDUAL'?'STAY':type,reasonCode:'UPSTREAM_SELECTED_PLAN'});
  return rows;
}

function economicActions(id,c,option){
  const rows=[];
  if(c.alloc.R>DECISION_EPS)rows.push({actionId:`${id}:rotation`,date:BASE,actionType:'ROTATION',sourceId:`${id}:source:R`,destinationId:`${id}:rotation`,amount:c.alloc.R,entryRoute:'ROTATION',reasonCode:'UPSTREAM_SELECTED_PLAN'});
  if(c.alloc.Q>DECISION_EPS)rows.push({actionId:`${id}:direct-q`,date:c.directQDate??'2030-01-10',actionType:'QUALIFYING',sourceId:`${id}:source:Q`,destinationId:`${id}:t190`,amount:c.alloc.Q,entryRoute:'QUALIFYING_FUNDING',reasonCode:'UPSTREAM_SELECTED_PLAN'});
  if(c.alloc.q>DECISION_EPS)rows.push({actionId:`qr2:q1b:${id}:annuitize`,date:c.commencementDate,actionType:'OPTIONAL_ANNUITIZATION',sourceId:`${id}:source:q`,destinationId:`annuity:${option.id}`,amount:c.alloc.q,entryRoute:'DIRECT',contractOptionId:option.id,reasonCode:'UPSTREAM_SELECTED_PLAN'});
  if(c.alloc.Residual>DECISION_EPS)rows.push({actionId:`${id}:residual`,date:BASE,actionType:'RESIDUAL',sourceId:`${id}:source:Residual`,destinationId:`stay:${id}`,amount:c.alloc.Residual,entryRoute:'STAY',reasonCode:'UPSTREAM_SELECTED_PLAN'});
  return rows;
}

function planProjectionFor(id,c,option,schedule){
  const semantic={id,alloc:c.alloc,commencementDate:c.commencementDate,optionId:option?.id??null,survivorPercent:c.survivorPercent,guaranteeMonths:c.guaranteeMonths,paymentDates:c.paymentDates,receiptFundedQ:c.receiptFundedQ};
  const planId=`plan:q1b:${stableHash(semantic).slice(0,24)}`;
  const committed=freeze({schemaVersion:'F8_INTEGRATED_PLAN_DRAFT_V1',status:'COMMITTED_PLAN_SNAPSHOT',openingStateHash:stableHash({id,base:BASE,total:sum(Object.values(c.alloc))}),planId,winnerCandidateId:`${id}:UPSTREAM_SELECTED`,baselineCandidateId:`${id}:BASELINE`,expectedNetFamilyValue:c.expectedFamilyValue,baselineExpectedNetFamilyValue:sum(Object.values(c.alloc)),expectedDeltaVsBaseline:c.expectedFamilyValue-sum(Object.values(c.alloc)),contractOptionId:option?.id??null,serviceChoiceId:'none',economicActions:economicActions(id,c,option),optimizerActions:optimizerActions(id,c,option),capacityClaimsByScenario:[],rightsClaims:option?[{id:`qr2:q1b:${id}:annuity-right`,contractId:option.contractId,rightType:'optional_annuity',commencementDate:c.commencementDate,survivorPct:c.survivorPercent,guaranteeMonths:c.guaranteeMonths}]:[],moduleEvidence:[{kind:'Q1B_UPSTREAM_SELECTED_PLAN_FIXTURE',fixtureId:id,qCapital:c.alloc.q,contractOptionId:option?.id??null,commencementDate:c.commencementDate,survivorPercent:c.survivorPercent,guaranteeMonths:c.guaranteeMonths,receiptSchedule:clone(schedule),receiptPolicy:c.receiptFundedQ?'FROZEN_RECEIPT_FUNDED_Q':'RESIDUAL_ONLY'}],mortalityDependenceFragile:false,globalCertificate:'UPSTREAM_SELECTED_PLAN_FROZEN_FOR_Q1B',productionReady:false,blockedReasons:[]});
  const identity={generation:'Q1B',inputHash:stableHash(semantic),rulesVersion:'Q1B_FIXED_REPLAY_V1',modelVersion:'F8_Q1B_OPTIONAL_ANNUITIZATION_V1'};
  return buildF8PlanProjection({committedPlan:committed,identity,constraints:{},capabilities:{residual:'SUPPORTED_CONDITIONAL',rotation:c.alloc.R>0?'SUPPORTED_CONDITIONAL':'NOT_APPLICABLE',qualifying:c.alloc.Q>0?'SUPPORTED_CONDITIONAL':'NOT_APPLICABLE',optionalAnnuitization:c.alloc.q>0?'SUPPORTED_CONDITIONAL':'NOT_APPLICABLE'},assumptions:{simulationMode:MODE,contractualEqualityConvention:'Q1B_DATE_ONLY_CONTRACTUAL_EQUALITY_V1'},provenance:{simulationMode:MODE,fixtureId:id,selectionStage:'UPSTREAM_PRESELECTED_PLAN',optimizerCallsDuringReplay:0},sourceSummary:{initialCapital:sum(Object.values(c.alloc)),residualCapital:c.alloc.Residual,openingState:{asOfDate:BASE,capitalForPlanning:sum(Object.values(c.alloc))}}});
}

export function buildQ1BFrozenFixture(id){
  const c=normalizedConfig(id),option=optionFor(id,c),schedule=frozenSchedule(id,c,option),planProjection=planProjectionFor(id,c,option,schedule);
  const frozenDecision=freeze({fixtureId:id,planId:planProjection.planId,qCapital:c.alloc.q,contractOptionId:option?.id??null,contractId:option?.contractId??null,commencementDate:c.commencementDate,survivorPercent:c.survivorPercent,guaranteeMonths:c.guaranteeMonths,selectedR:c.alloc.R,selectedQ:c.alloc.Q,selectedResidual:c.alloc.Residual,expectedFamilyValue:planProjection.expectedFamilyValue,baselineExpectedFamilyValue:planProjection.baselineExpectedFamilyValue,receiptPolicyId:c.receiptFundedQ?`${id}:RECEIPT_Q_POLICY_V1`:'RESIDUAL_ONLY',paymentSemanticsVersion:option?`Q1B_PAY:${id}`:null,receiptTreatmentVersion:option?`Q1B_TREAT:${id}`:null,sourceAnnuitizationAdapterVersion:option?`Q1B_SOURCE_ADAPTER:${id}`:null,continuationAdapterVersion:option?`Q1B_CONTINUATION:${id}`:null});
  return freeze({schemaVersion:'F8_Q1B_FROZEN_SELECTED_PLAN_V1',mode:MODE,fixtureId:id,config:c,option,planProjection,frozenDecision,frozenReceiptSchedule:schedule,optimizerCalls:0});
}

function normalizeScenario(spec){
  if(!spec?.id)fail('scenario id required');
  const forbidden=[
    'qCapital','contractOptionId','commencementDate','survivorPercent','guaranteeMonths',
    'selectedR','selectedQ','selectedResidual','winnerCandidateId','qFrontier',
    'alternativeOptions','receiptPolicy','expectedFamilyValue'
  ];
  const attempted=forbidden.filter(k=>Object.prototype.hasOwnProperty.call(spec,k));
  if(attempted.length)fail(`scenario may not mutate frozen selected plan: ${attempted.sort().join(',')}`);
  const memberKind=spec.memberKind??(spec.memberDeathDate?'DEATH':'SURVIVE_TO_TERMINAL_HORIZON'),spouseKind=spec.spouseKind??(spec.spouseDeathDate?'DEATH':'SURVIVE_TO_TERMINAL_HORIZON');
  const memberDate=memberKind==='DEATH'?spec.memberDeathDate:spec.memberTerminalDate,spouseDate=spouseKind==='DEATH'?spec.spouseDeathDate:spec.spouseTerminalDate;
  if(!['DEATH','SURVIVE_TO_TERMINAL_HORIZON'].includes(memberKind)||!['DEATH','SURVIVE_TO_TERMINAL_HORIZON'].includes(spouseKind)||!dateOk(memberDate)||!dateOk(spouseDate))fail('explicit exact member/spouse scenario dates required');
  return freeze({id:spec.id,memberKind,memberDate,spouseKind,spouseDate});
}

function equalityReasons(ctx,s){
  const c=ctx.config,reasons=[];
  if(s.memberKind==='DEATH'&&s.spouseKind==='DEATH'&&s.memberDate===s.spouseDate)reasons.push('SAME_DAY_MEMBER_SPOUSE_DEATH');
  if(c.alloc.q<=DECISION_EPS)return reasons;
  if(s.memberKind==='DEATH'&&s.memberDate===c.commencementDate)reasons.push('MEMBER_DEATH_EQUALS_Q_COMMENCEMENT');
  if(s.memberKind==='DEATH'&&c.paymentDates.includes(s.memberDate))reasons.push('MEMBER_DEATH_EQUALS_CONTRACTUAL_Q_RECEIPT');
  if(s.memberKind==='SURVIVE_TO_TERMINAL_HORIZON'&&c.paymentDates.includes(s.memberDate))reasons.push('TERMINAL_HORIZON_EQUALS_CONTRACTUAL_Q_RECEIPT');
  if(s.memberKind==='DEATH'&&s.spouseKind==='DEATH'&&s.spouseDate>s.memberDate&&c.paymentDates.includes(s.spouseDate)){
    const guaranteed=c.guaranteePaymentDates.includes(s.spouseDate),survivor=c.survivorPercent>DECISION_EPS;
    if(guaranteed||survivor)reasons.push('SPOUSE_DEATH_EQUALS_SURVIVOR_OR_GUARANTEE_PAYMENT');
  }
  return reasons;
}

function rawMortality(s){
  const member=s.memberKind==='DEATH'?[{id:'m',kind:'DEATH',deathDate:s.memberDate,probability:1},{id:'mt0',kind:'SURVIVE_TO_TERMINAL_HORIZON',terminalDate:SUPPORT_TERMINAL,probability:0}]:[{id:'m',kind:'SURVIVE_TO_TERMINAL_HORIZON',terminalDate:s.memberDate,probability:1}];
  const spouse=s.spouseKind==='DEATH'?[{id:'s',kind:'DEATH',deathDate:s.spouseDate,probability:1},{id:'st0',kind:'SURVIVE_TO_TERMINAL_HORIZON',terminalDate:SUPPORT_TERMINAL,probability:0}]:[{id:'s',kind:'SURVIVE_TO_TERMINAL_HORIZON',terminalDate:s.spouseDate,probability:1}];
  return {schemaVersion:'F8_JOINT_MORTALITY_V1',assumption:'INDEPENDENT_V1',version:`Q1B_MORTALITY:${s.id}`,member,spouse};
}

function memberScenariosFromRaw(raw){return raw.member.map(m=>m.kind==='DEATH'?{id:m.id,kind:'MEMBER_DEATH',memberDeathDate:m.deathDate,probability:m.probability}:{id:m.id,kind:'SURVIVE_TO_TERMINAL_HORIZON',terminalDate:m.terminalDate,probability:m.probability})}
function memberEndDates(raw){return [...new Set(raw.member.map(m=>m.kind==='DEATH'?m.deathDate:m.terminalDate))]}
function valuation(raw,id){const dates=[BASE,DEFAULT_COMMENCEMENT,...memberEndDates(raw)];return {schemaVersion:'F8_VALUATION_CONVENTION_V1',version:`Q1B_VAL:${id}`,baseDate:BASE,moneyBasis:'NOMINAL',productionVerified:false,valuationDiscountCurve:{version:`Q1B_DISC:${id}`,moneyBasis:'NOMINAL',factors:dates.map(date=>({date,factorToBase:1}))},inflationConvention:{version:`Q1B_CPI:${id}`,baseDate:BASE,priceIndices:dates.map(date=>({date,indexFromBase:1}))}}}

function directQReplay(ctx,s,raw){
  const c=ctx.config;if(c.alloc.Q<=DECISION_EPS)return null;
  const actionDate=c.directQDate??'2030-01-10',endDates=memberEndDates(raw),sourceId=`${ctx.fixtureId}:direct-q-source`,qid=`q:${ctx.fixtureId}:direct-q-action`;
  const exact={[sourceId]:{}};
  for(const e of new Set([actionDate,...endDates]))if(e>BASE)exact[sourceId][`${BASE}|${e}`]=factor(BASE,e);
  for(const e of endDates)if(e>actionDate)exact[sourceId][`${actionDate}|${e}`]=factor(actionDate,e);
  exact[qid]={};for(const e of endDates)if(e>actionDate)exact[qid][`${actionDate}|${e}`]=factor(actionDate,e);
  const capacity=[capacityRow(ctx,c.capacity.externalAlreadyUsed)];
  const input={schemaVersion:'F8_M5_QUALIFYING_REPLAY_V1',mode:MODE,personId:'member',currency:'ILS',baseDate:BASE,sources:[{id:sourceId,economicPathId:`${sourceId}:path`,sourceEventId:`${sourceId}:event`,sourceType:'transfer',ownerId:'member',wrapper:'savings_policy',currency:'ILS',amount:c.alloc.Q,basisNominal:c.alloc.Q,basisIndexed:c.alloc.Q,contributionDate:BASE,availabilityDate:BASE,stateDate:BASE}],capacity,scenarios:memberScenariosFromRaw(raw),exactQuotes:exact,deathRules:{savings_policy:{version:`${ctx.fixtureId}:DQ_DEATH`,basis:'exempt',rate:0},t190:{version:`${ctx.fixtureId}:DQ_T190_DEATH`,basis:'exempt',rate:0}},terminalContinuationRules:{savings_policy:{version:`${ctx.fixtureId}:DQ_TERM`,basis:'exempt',rate:0},t190:{version:`${ctx.fixtureId}:DQ_T190_TERM`,basis:'exempt',rate:0}},valuationConvention:valuation(raw,`${ctx.fixtureId}:direct-q:${s.id}`),policy:{schemaVersion:'F8_CONTINGENT_POLICY_V1',version:`${ctx.fixtureId}:DIRECT_Q_POLICY`,personId:'member',actions:[{id:`${ctx.fixtureId}:direct-q-action`,date:actionDate,type:'QUALIFYING_DEPOSIT',sourceLotId:sourceId,contractId:`${ctx.fixtureId}:DIRECT_Q_CONTRACT`,maxGross:c.alloc.Q,taxRule:{source:'EXPLICIT_QUOTE',version:`${ctx.fixtureId}:DIRECT_Q_TAX`,basis:'exempt',rate:0},destinationBasis:{version:`${ctx.fixtureId}:DIRECT_Q_BASIS`,nominalPerNet:1,indexedPerNet:1}}]},provenance:{simulationMode:MODE,assumptionPackHash:HASH,productionVerified:false,version:`${ctx.fixtureId}:DIRECT_Q_INPUT`}};
  const authority={schemaVersion:'F8_M5_BETA_AUTHORITY_V1',simulationAuthorized:true,productionVerified:false,assumptionPackHash:HASH,caseId:`${ctx.fixtureId}:direct-q`};
  const out=evaluateQualifyingPolicyProfessionalSimulationBeta(input,authority),row=out.planned.find(x=>x.scenarioId==='m');if(!row)fail('direct Q actual member row missing');return freeze({out,row});
}

function capacityRow(ctx,alreadyUsed,taxYear=2030){const c=ctx.config;return {taxYear,personId:'member',ruleId:`${ctx.fixtureId}:CAP_${taxYear}`,available:c.capacity.available,alreadyUsed,provenance:{version:`${ctx.fixtureId}:CAP_PROV:${taxYear}`},legalRule:{ruleId:`${ctx.fixtureId}:CAP_${taxYear}`,status:'SIMULATION_ASSUMPTION',source:'F8_BETA_QUALIFYING_CAPACITY_ASSUMPTION_V1',jurisdiction:'IL_SIMULATION_ONLY',effectiveFrom:`${taxYear}-01-01`,calculationVersion:`${ctx.fixtureId}:CAP_V1:${taxYear}`,productionVerified:false,simulationMode:MODE,assumptionPackHash:HASH}}}

function stateModel(ctx,wrapper,paymentDates,raw){
  const intervals={};for(const d of paymentDates)for(const e of memberEndDates(raw))if(e>d)intervals[`${d}|${e}`]=factor(d,e);
  return {wrapper,basisNominalPerUnit:1,basisIndexedPerUnit:1,provenance:{version:`${ctx.fixtureId}:STATE:${wrapper}`},deathRule:{version:`${ctx.fixtureId}:STATE_DEATH:${wrapper}`,basis:'exempt',rate:0},terminalContinuationRule:{version:`${ctx.fixtureId}:STATE_TERM:${wrapper}`,basis:'exempt',rate:0},intervalQuotes:intervals};
}

function menu(ctx){const o=ctx.option;return {schemaVersion:'F8_CONTRACT_MENU_V1',mode:'WORKING_QA',personId:'member',coverageStates:[{id:'spouse_alive',spouseAlive:true,requiredService:[]},{id:'spouse_predeceased',spouseAlive:false,requiredService:[]}],options:[clone(o)]}}
function paymentSemantics(ctx){const c=ctx.config,o=ctx.option;return {schemaVersion:'F8_M8_BETA_Q_PAYMENT_SEMANTICS_V1',mode:MODE,simulationAuthorized:true,productionVerified:false,assumptionPackHash:HASH,version:`Q1B_PAY:${ctx.fixtureId}`,contractOptionId:o.id,annuityFactorId:o.annuityFactorId,annuityFactor:c.annuityFactor,paymentDates:[...c.paymentDates],guaranteePaymentDates:[...c.guaranteePaymentDates],survivorMode:'OPTION_SURVIVOR_PERCENT_OF_MEMBER_PAYMENT',guaranteeMode:'FULL_MEMBER_PAYMENT',guaranteeRecipientIfSpousePredeceased:c.guaranteeMonths>0?'heirs':'NONE',guaranteeRecipientAfterSpouseDeath:c.guaranteeMonths>0?'heirs':'NONE',provenance:{version:`Q1B_PAY_PROV:${ctx.fixtureId}:${o.id}`,verificationStatus:'SIMULATION_ASSUMPTION',productionVerified:false,assumptionPackHash:HASH,sourceReference:`Q1B_ASSUMPTIONS#${ctx.fixtureId}:payment`}}}
function receiptTreatment(ctx){const c=ctx.config;return {schemaVersion:'F8_M8_BETA_Q_RECEIPT_TREATMENT_V1',mode:MODE,simulationAuthorized:true,productionVerified:false,assumptionPackHash:HASH,version:`Q1B_TREAT:${ctx.fixtureId}`,provenance:{version:`Q1B_TREAT_PROV:${ctx.fixtureId}`,verificationStatus:'SIMULATION_ASSUMPTION',productionVerified:false,assumptionPackHash:HASH,sourceReference:`Q1B_ASSUMPTIONS#${ctx.fixtureId}:receipt`},rows:c.paymentDates.map(date=>({date,taxFractionOfGross:c.treatment.taxFractionOfGross,niHealthFractionOfGross:c.treatment.niHealthFractionOfGross,requiredConsumption:c.treatment.requiredConsumption,provenance:{version:`Q1B_TREAT:${ctx.fixtureId}:${date}`,verificationStatus:'SIMULATION_ASSUMPTION',productionVerified:false,assumptionPackHash:HASH,sourceReference:`Q1B_ASSUMPTIONS#${ctx.fixtureId}:receipt`}}))}}

function qAdapters(ctx){return {sourceAnnuitizationAdapter:{schemaVersion:'F8_M8_BETA_Q_SOURCE_ANNUITIZATION_ADAPTER_V1',mode:MODE,simulationAuthorized:true,productionVerified:false,assumptionPackHash:HASH,version:`Q1B_SOURCE_ADAPTER:${ctx.fixtureId}`,provenance:{version:`Q1B_SOURCE_ADAPTER_PROV:${ctx.fixtureId}`,verificationStatus:'SIMULATION_ASSUMPTION',productionVerified:false,assumptionPackHash:HASH,sourceReference:`Q1B_ASSUMPTIONS#${ctx.fixtureId}:source`},quote({sourceState,valuationDate}){return {valuationDate,grossSourceValue:sourceState.value,basisNominal:sourceState.basisNominal,basisIndexed:sourceState.basisIndexed,taxAmount:0,fees:0,netConsideration:sourceState.value,provenance:{version:`Q1B_SOURCE_QUOTE:${ctx.fixtureId}`,verificationStatus:'SIMULATION_ASSUMPTION',productionVerified:false,assumptionPackHash:HASH,sourceReference:`Q1B_ASSUMPTIONS#${ctx.fixtureId}:source`}}}},continuationAdapter:{schemaVersion:'F8_M8_BETA_Q_CONTINUATION_ADAPTER_V1',mode:MODE,simulationAuthorized:true,productionVerified:false,assumptionPackHash:HASH,version:`Q1B_CONTINUATION:${ctx.fixtureId}`,provenance:{version:`Q1B_CONTINUATION_PROV:${ctx.fixtureId}`,verificationStatus:'SIMULATION_ASSUMPTION',productionVerified:false,assumptionPackHash:HASH,sourceReference:`Q1B_ASSUMPTIONS#${ctx.fixtureId}:continuation`},valueContinuation({valuationDate,state}){if(state.contractState){const value=[...state.contractState.scheduled,...state.contractState.continuation].reduce((n,x)=>n+x.gross,0),p=state.livePaths[0];return {valuationDate,continuationValue:value,components:[{id:`q1b:${ctx.fixtureId}:cont:right:${state.label}`,category:'q_contract_continuation',value,backingPathIds:[p.id],rightIds:state.rights.map(r=>r.id)}],verificationStatus:MODE,productionVerified:false,provenance:{version:`Q1B_CONT_RIGHT:${ctx.fixtureId}`,sourceReference:`Q1B_ASSUMPTIONS#${ctx.fixtureId}:continuation`}}}const grouped=new Map();for(const p of state.livePaths)grouped.set(p.id,(grouped.get(p.id)??0)+p.amount);const components=[...grouped].map(([pathId,value],i)=>({id:`q1b:${ctx.fixtureId}:cont:state:${i}:${pathId}`,category:'receipt_state_continuation',value,backingPathIds:[pathId],rightIds:[]}));return {valuationDate,continuationValue:sum(components,x=>x.value),components,verificationStatus:MODE,productionVerified:false,provenance:{version:`Q1B_CONT_STATE:${ctx.fixtureId}`,sourceReference:`Q1B_ASSUMPTIONS#${ctx.fixtureId}:continuation`}}}}}}

function qPointInput(ctx,s,raw,directUsed){
  const c=ctx.config,q=c.alloc.q,sourceId=`${ctx.fixtureId}:q-source`,exact={};for(const e of new Set([c.commencementDate,...memberEndDates(raw)]))if(e>BASE)exact[`${BASE}|${e}`]=factor(BASE,e);
  const receiptPolicy={};if(c.receiptFundedQ)for(const d of c.paymentDates)receiptPolicy[d]={selected:true,actionId:`${ctx.fixtureId}:receipt-q:${d}`,contractId:`${ctx.fixtureId}:RECEIPT_Q_CONTRACT`,maxGross:c.receiptQMaxGross??50,taxRule:{source:'EXPLICIT_QUOTE',version:`${ctx.fixtureId}:RECEIPT_Q_TAX`,basis:'exempt',rate:0},destinationBasis:{version:`${ctx.fixtureId}:RECEIPT_Q_BASIS`,nominalPerNet:1,indexedPerNet:1}};
  const alreadyUsed=c.capacity.externalAlreadyUsed+directUsed;
  return {schemaVersion:'F8_M8_NATIVE_Q_POINT_V1',mode:MODE,caseId:`q1b:${ctx.fixtureId}`,ownerId:'member',currency:'ILS',assumptionPackHash:HASH,provenance:{version:`Q1B_POINT_INPUT:${ctx.fixtureId}`,simulationMode:MODE,productionVerified:false},qCapital:q,preExistingRightIds:[`${ctx.fixtureId}:preexisting-right`],sourceState:{id:sourceId,economicPathId:`${sourceId}:path`,sourceEventId:`${sourceId}:event`,ownerId:'member',currency:'ILS',wrapper:'savings_policy',stateDate:BASE,contributionDate:BASE,availabilityDate:BASE,sourceType:'transfer',amount:q,basisNominal:q,basisIndexed:q,deathRule:{version:`${ctx.fixtureId}:Q_SOURCE_DEATH`,basis:'exempt',rate:0},terminalContinuationRule:{version:`${ctx.fixtureId}:Q_SOURCE_TERM`,basis:'exempt',rate:0},exactQuotes:exact},m7ContractMenu:menu(ctx),contractOptionId:ctx.option.id,jointMortality:raw,paymentSemantics:paymentSemantics(ctx),receiptTreatment:receiptTreatment(ctx),capacity:[capacityRow(ctx,alreadyUsed,2030),capacityRow(ctx,0,2031)],receiptQualifyingPolicyByDate:receiptPolicy,receiptStateModels:{cash:stateModel(ctx,'cash',c.paymentDates,raw),qualifying:stateModel(ctx,'t190',c.paymentDates,raw),residual:stateModel(ctx,'savings_policy',c.paymentDates,raw)},residualDestination:{destinationId:'stay',entryRoute:'STAY',netFamilyValuePerCapital:1,provenance:{version:`${ctx.fixtureId}:Q_RESIDUAL`}},valuationConvention:valuation(raw,`${ctx.fixtureId}:q:${s.id}`)};
}

function receiptScheduleSemantic(rows){return rows.map(r=>({id:r.id,date:r.date,gross:r.gross,rightId:r.rightId,contractId:r.contractId,ruleId:r.ruleId,sourceEventId:r.sourceEventId,economicPathId:r.economicPathId,provenance:r.provenance}))}
function assertFrozen(ctx,result){const f=ctx.frozenDecision;if(result.qCapital!==f.qCapital||result.contractOptionId!==f.contractOptionId||result.commencementDate!==f.commencementDate)fail('scenario replay mutated frozen q decision');const got=receiptScheduleSemantic(result.receiptSchedule),want=receiptScheduleSemantic(ctx.frozenReceiptSchedule);if(JSON.stringify(got)!==JSON.stringify(want))fail('scenario replay mutated frozen contractual receipt schedule')}

function combinedCapacity(ctx,directQ,qBranch){
  const c=ctx.config,byYear=new Map();
  const directRows=directQ?.row.executedCapacity??[];for(const r of directRows)byYear.set(r.taxYear,{taxYear:r.taxYear,available:r.available,externalAlreadyUsed:r.alreadyUsed,directQ:r.executed,receiptFundedQ:0});
  if(!byYear.has(2030))byYear.set(2030,{taxYear:2030,available:c.capacity.available,externalAlreadyUsed:c.capacity.externalAlreadyUsed,directQ:0,receiptFundedQ:0});
  for(const r of qBranch?.receiptPipelineScenario?.capacityExecution??[]){const row=byYear.get(r.taxYear)??{taxYear:r.taxYear,available:c.capacity.available,externalAlreadyUsed:r.taxYear===2030?c.capacity.externalAlreadyUsed:0,directQ:0,receiptFundedQ:0};row.receiptFundedQ+=r.executed;byYear.set(r.taxYear,row)}
  const rows=[...byYear.values()].map(r=>({...r,totalUsed:r.externalAlreadyUsed+r.directQ+r.receiptFundedQ,overuse:r.externalAlreadyUsed+r.directQ+r.receiptFundedQ-r.available}));
  if(rows.some(r=>r.overuse>RECONCILIATION_EPS))fail('direct Q + receipt-funded Q capacity overuse');return freeze(rows);
}

function unresolved(ctx,s,ordering){return freeze({schemaVersion:'F8_Q1B_SCENARIO_EVIDENCE_V1',status:'ORDERING_UNRESOLVED',scenario:s,planId:ctx.planProjection.planId,planIdentityHash:ctx.planProjection.identityHash,optimizerCalls:0,frozenDecision:ctx.frozenDecision,planProjection:ctx.planProjection,scenarioProjection:null,ordering,realizedExecution:null,inferredRecipient:null,inferredPaymentStatus:null});}

export function replayQ1BFixedSelectedPlanScenario(ctx,spec){
  if(ctx?.schemaVersion!=='F8_Q1B_FROZEN_SELECTED_PLAN_V1')fail('frozen selected q1B plan required');
  const s=normalizeScenario(spec),ordering=contractualEqualityStatus(equalityReasons(ctx,s));if(ordering)return unresolved(ctx,s,ordering);
  const raw=rawMortality(s),directQ=directQReplay(ctx,s,raw),directUsed=directQ?.row.executedCapacity.find(x=>x.taxYear===2030)?.executed??0;
  let qResult=null,qBranch=null;
  if(ctx.config.alloc.q>DECISION_EPS){qResult=evaluateNativeAnnuitizationPointProfessionalSimulationBeta(qPointInput(ctx,s,raw,directUsed),qAdapters(ctx));assertFrozen(ctx,qResult);qBranch=qResult.branchResults.find(b=>b.branchId==='m|s');if(!qBranch)fail('actual q joint branch missing')}
  const cap=combinedCapacity(ctx,directQ,qBranch),qValue=qBranch?.familyValue??0,directQValue=directQ?.row.familyValueAtEnd??0,planned=ctx.config.alloc.R+ctx.config.alloc.Residual+qValue+directQValue,baseline=sum(Object.values(ctx.config.alloc));
  const memberReceipts=qBranch?.receiptPipelineScenario?.receipts??[],executedMemberReceipts=memberReceipts.filter(r=>r.status==='RECEIPT_EXECUTED'),skippedMemberReceipts=memberReceipts.filter(r=>r.status!=='RECEIPT_EXECUTED'),contractCashflows=qBranch?.contractCashflows??{scheduled:[],continuation:[]};
  const replay=freeze({schemaVersion:'F8_SCENARIO_REPLAY_V1',planId:ctx.planProjection.planId,scenarioId:s.id,memberDeathAge:null,spouseDeathAge:null,valuationDate:s.memberDate,moneyBasis:'NOMINAL',familyValueAtMemberDeath:planned,baselineValueAtMemberDeath:baseline,immediateCapital:null,survivorValue:null,guaranteeValue:null,spouseContinuationValue:null,eventualEstateValue:null,productBalancesAtDeath:[],scenarioCashflows:[...contractCashflows.scheduled,...contractCashflows.continuation],yearlyRows:[],warnings:[],unavailableComponents:[],provenance:{simulationMode:MODE,fixedSelectedPlanReplay:true,optimizerCalls:0,qCapital:ctx.frozenDecision.qCapital,contractOptionId:ctx.frozenDecision.contractOptionId,commencementDate:ctx.frozenDecision.commencementDate,survivorPercent:ctx.frozenDecision.survivorPercent,guaranteeMonths:ctx.frozenDecision.guaranteeMonths,selectedR:ctx.frozenDecision.selectedR,selectedQ:ctx.frozenDecision.selectedQ,selectedResidual:ctx.frozenDecision.selectedResidual,expectedFamilyValueFrozen:ctx.frozenDecision.expectedFamilyValue,combinedCapacity:cap}});
  const scenarioProjection=buildF8ScenarioProjection(ctx.planProjection,replay);if(scenarioProjection.planId!==ctx.planProjection.planId||scenarioProjection.planIdentityHash!==ctx.planProjection.identityHash)fail('scenario projection changed selected plan identity');
  const receiptWaterfalls=executedMemberReceipts.map(r=>r.waterfall).filter(Boolean),maxWaterfallGap=Math.max(0,...receiptWaterfalls.map(w=>Math.abs(w.gap))),receiptQActions=executedMemberReceipts.flatMap(r=>r.qState?.economicActions??[]),receiptQActionIds=receiptQActions.map(a=>a.actionId),uniqueReceiptQActionIds=new Set(receiptQActionIds);
  if(uniqueReceiptQActionIds.size!==receiptQActionIds.length)fail('duplicate receipt-funded Q action in one scenario replay');
  return freeze({schemaVersion:'F8_Q1B_SCENARIO_EVIDENCE_V1',status:'REPLAYED',scenario:s,planId:ctx.planProjection.planId,planIdentityHash:ctx.planProjection.identityHash,optimizerCalls:0,frozenDecision:ctx.frozenDecision,planProjection:ctx.planProjection,scenarioProjection,qExecuted:qBranch?.qExecuted??false,qExecutionStatus:qBranch?.status??'Q_NOT_SELECTED',qRightsCreated:qBranch?.rightsCreated??[],qBranch,memberReceipts:{executed:executedMemberReceipts,skipped:skippedMemberReceipts},contractCashflows,receiptPipeline:qResult?.receiptPipeline??null,qReplay:qResult,directQReplay:directQ?.row??null,combinedCapacity:cap,laneValues:{rotation:ctx.config.alloc.R,qualifying:directQValue,optionalAnnuitization:qValue,residual:ctx.config.alloc.Residual},plannedValue:planned,baselineValue:baseline,antiDoubleCount:qResult?.antiDoubleCount??{sourceCapitalAndRight:false,receiptPvAndEstate:false},receiptEvidence:{maxWaterfallGap,valuationRecognition:qResult?.receiptPipeline?.valuationRecognition??null,futureCapacityCreditedAsAsset:qBranch?.receiptPipelineScenario?.futureCapacityCreditedAsAsset??false,receiptQActionIds},frozenReceiptSchedule:ctx.frozenReceiptSchedule});
}

export function q1bOrdinaryScenarios(){return freeze({
  deathBeforeCommencement:{id:'death-before-commencement',memberDeathDate:'2029-12-31',spouseDeathDate:'2031-06-15'},
  afterCommencementBeforeFirstReceipt:{id:'after-commencement-before-first-receipt',memberDeathDate:'2030-01-15',spouseDeathDate:'2031-06-15'},
  afterOneReceipt:{id:'after-one-receipt',memberDeathDate:'2030-02-15',spouseDeathDate:'2031-06-15'},
  afterMultipleReceipts:{id:'after-multiple-receipts',memberDeathDate:'2030-04-15',spouseDeathDate:'2031-06-15'},
  afterAllMemberReceipts:{id:'after-all-member-receipts',memberDeathDate:'2032-01-15',spouseDeathDate:'2033-06-15'},
  spousePredeceases:{id:'spouse-predeceases',memberDeathDate:'2030-03-15',spouseDeathDate:'2029-12-15'},
  shortSpouseSurvival:{id:'short-spouse-survival',memberDeathDate:'2030-03-15',spouseDeathDate:'2030-04-15'},
  spouseThroughGuarantee:{id:'spouse-through-guarantee',memberDeathDate:'2030-03-15',spouseDeathDate:'2030-06-15'},
  spouseBeyondGuarantee:{id:'spouse-beyond-guarantee',memberDeathDate:'2030-03-15',spouseDeathDate:'2030-11-15'},
  spouseTerminal:{id:'spouse-terminal',memberDeathDate:'2030-03-15',spouseKind:'SURVIVE_TO_TERMINAL_HORIZON',spouseTerminalDate:'2030-07-15'},
  memberTerminal:{id:'member-terminal',memberKind:'SURVIVE_TO_TERMINAL_HORIZON',memberTerminalDate:'2030-07-15',spouseKind:'SURVIVE_TO_TERMINAL_HORIZON',spouseTerminalDate:'2031-07-15'}
});}

export function q1bEqualityScenarios(ctx){const c=ctx.config,receipt=c.paymentDates[0]??'2030-02-01';return freeze({
  memberAtCommencement:{id:'eq-member-commencement',memberDeathDate:c.commencementDate??'2030-01-01',spouseDeathDate:'2031-06-15'},
  memberAtReceipt:{id:'eq-member-receipt',memberDeathDate:receipt,spouseDeathDate:'2031-06-15'},
  terminalAtReceipt:{id:'eq-terminal-receipt',memberKind:'SURVIVE_TO_TERMINAL_HORIZON',memberTerminalDate:receipt,spouseKind:'SURVIVE_TO_TERMINAL_HORIZON',spouseTerminalDate:'2031-06-15'},
  spouseAtPayment:{id:'eq-spouse-payment',memberDeathDate:'2030-01-15',spouseDeathDate:receipt},
  jointDeath:{id:'eq-joint-death',memberDeathDate:'2030-04-15',spouseDeathDate:'2030-04-15'}
});}
