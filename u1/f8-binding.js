import {stableHash} from './f8-stable-hash.js';
import {buildYearlyTableRows,buildActionPlan,actionDestinationBucket,reconcileU1DViewModel} from './f8-u1d-presentation.js';

const EPS=1e-9;
const fail=m=>{throw new Error(`U1_BINDING: ${m}`)};
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){for(const v of Object.values(x))freeze(v);Object.freeze(x)}return x};
const cloneFreeze=x=>freeze(structuredClone(x));
const stable=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const hash=stableHash;
const finite=(v,label)=>{if(typeof v!=='number'||!Number.isFinite(v))fail(`${label} must be finite`);return v};
const nonneg=(v,label)=>{finite(v,label);if(v<0)fail(`${label} must be nonnegative`);return v};

export const CAPABILITY_STATUS=freeze({
  SUPPORTED_VERIFIED:'SUPPORTED_VERIFIED',
  SUPPORTED_CONDITIONAL:'SUPPORTED_CONDITIONAL',
  AVAILABLE_NOT_SELECTED:'AVAILABLE_NOT_SELECTED',
  NOT_APPLICABLE:'NOT_APPLICABLE',
  UNAVAILABLE:'UNAVAILABLE',
  UNVERIFIED:'UNVERIFIED',
  BLOCKED:'BLOCKED'
});

export const VALUE_STATUS=freeze({
  AVAILABLE_POSITIVE:'AVAILABLE_POSITIVE',
  AVAILABLE_ZERO:'AVAILABLE_ZERO',
  AVAILABLE_NOT_SELECTED:'AVAILABLE_NOT_SELECTED',
  MISSING:'MISSING',
  UNKNOWN:'UNKNOWN',
  NOT_APPLICABLE:'NOT_APPLICABLE',
  UNVERIFIED:'UNVERIFIED',
  BLOCKED:'BLOCKED'
});

function valueStatus(v,explicit=null){
  if(explicit){if(!Object.values(VALUE_STATUS).includes(explicit))fail('invalid explicit value status');return explicit}
  if(v==null)return VALUE_STATUS.MISSING;
  finite(v,'value');
  return Math.abs(v)<=EPS?VALUE_STATUS.AVAILABLE_ZERO:VALUE_STATUS.AVAILABLE_POSITIVE;
}
function valueCell(v,explicit=null,meta={}){
  const status=valueStatus(v,explicit);
  const amount=[VALUE_STATUS.AVAILABLE_POSITIVE,VALUE_STATUS.AVAILABLE_ZERO].includes(status)?v:null;
  return freeze({status,amount,...meta});
}

function actionSemantic(a){
  if(!a?.actionId||!a.date||!a.actionType)fail('economic action requires actionId/date/actionType');
  const sourceId=a.sourceId??a.source?.lotId??a.source?.sourceId??null;
  const destinationId=a.destinationId??a.destination?.accountId??a.destination?.destinationId??null;
  const amount=a.amount??a.grossAmount??a.netAmount??0;
  nonneg(Number(amount),'action amount');
  return {
    actionId:a.actionId,date:a.date,taxYear:a.taxYear??Number(String(a.date).slice(0,4)),memberAge:a.memberAge??null,actionType:a.actionType,
    sourceId,destinationId,sourceType:a.sourceType??a.source?.productType??null,destinationType:a.destinationType??a.destination?.productType??null,entryRoute:a.entryRoute??null,
    grossAmount:a.grossAmount??a.amount??null,tax:a.tax??null,fees:a.fees??null,netAmount:a.netAmount??a.amount??null,
    basisBefore:a.basisBefore??null,basisAfter:a.basisAfter??null,
    capacityBefore:a.capacityBefore??null,capacityUsed:a.capacityUsed??null,capacityAfter:a.capacityAfter??null,
    balanceBefore:a.balanceBefore??null,balanceAfter:a.balanceAfter??null,
    reasonCode:a.reasonCode??null,reasonText:a.reasonText??null,explanationKey:a.explanationKey??null,stopCondition:a.stopCondition??null,ruleId:a.ruleId??null,contractId:a.contractId??null,
    legalStatus:a.legalStatus??null,executionStatus:a.executionStatus??null,immediate:a.immediate??null,timing:a.timing??null,valuationDate:a.valuationDate??null,
    policyLaneCapital:a.policyLaneCapital??null,provenance:a.provenance??null
  };
}
function actionSignature(s){return stable(s)};

/** Scenario-specific materializations become one ex-ante policy action plus applicability evidence.
 * No economics are recalculated here. Divergent economics for the same actionId are rejected. */
export function canonicalizeEconomicActions(rawActions=[]){
  if(!Array.isArray(rawActions))fail('economicActions array required');
  const byId=new Map();
  for(const raw of rawActions){
    const sem=actionSemantic(raw),sig=actionSignature(sem),scenarioId=raw.scenarioId??null;
    if(!byId.has(sem.actionId))byId.set(sem.actionId,{sem,sig,scenarios:new Set(),unconditional:false});
    const row=byId.get(sem.actionId);
    if(row.sig!==sig)fail(`same actionId diverges across scenarios: ${sem.actionId}`);
    if(scenarioId==null)row.unconditional=true;else row.scenarios.add(scenarioId);
  }
  return freeze([...byId.values()].sort((a,b)=>a.sem.date.localeCompare(b.sem.date)||a.sem.actionId.localeCompare(b.sem.actionId)).map(({sem,scenarios,unconditional})=>({
    ...sem,
    executionApplicability:unconditional?{kind:'UNCONDITIONAL'}:{kind:'CONTINGENT_SCENARIOS',scenarioIds:[...scenarios].sort()}
  })));
}

function allocationByType(actions){
  const map=new Map();
  for(const a of actions){const amount=a.amount??a.grossAmount??a.netAmount??0;map.set(a.actionType,(map.get(a.actionType)??0)+Number(amount||0))}
  return Object.fromEntries([...map.entries()].sort(([a],[b])=>a.localeCompare(b)));
}

/** Build a frozen, presentation-safe ex-ante plan projection from a committed integrated plan.
 * This layer may summarize meaning but never calls an optimizer or invents missing economics. */
export function buildF8PlanProjection({committedPlan,identity,constraints={},capabilities={},assumptions={},provenance={},sourceSummary=null}={}){
  if(committedPlan?.schemaVersion!=='F8_INTEGRATED_PLAN_DRAFT_V1'||committedPlan.status!=='COMMITTED_PLAN_SNAPSHOT')fail('committed integrated plan snapshot required');
  if(!identity?.generation||!identity?.inputHash||!identity?.rulesVersion||!identity?.modelVersion)fail('complete projection identity required');
  if(!committedPlan.planId)fail('planId required');
  const economicActions=canonicalizeEconomicActions(committedPlan.economicActions??[]);
  const optimizerActions=committedPlan.optimizerActions??[];
  const alloc=allocationByType(optimizerActions);
  const projection={
    schemaVersion:'F8_PLAN_PROJECTION_V2',
    planId:committedPlan.planId,
    generation:identity.generation,
    inputHash:identity.inputHash,
    rulesVersion:identity.rulesVersion,
    modelVersion:identity.modelVersion,
    openingStateHash:committedPlan.openingStateHash,
    status:committedPlan.productionReady===true?'READY_PRODUCTION':'WORKING_QA',
    productionReady:committedPlan.productionReady===true,
    blockedReasons:[...(committedPlan.blockedReasons??[])],
    selectedStrategy:{
      winnerCandidateId:committedPlan.winnerCandidateId,
      baselineCandidateId:committedPlan.baselineCandidateId,
      allocationByType:alloc,
      contractOptionId:committedPlan.contractOptionId,
      serviceChoiceId:committedPlan.serviceChoiceId,
      mortalityDependenceFragile:committedPlan.mortalityDependenceFragile===true,
      globalCertificate:committedPlan.globalCertificate??null
    },
    expectedFamilyValue:committedPlan.expectedNetFamilyValue,
    baselineExpectedFamilyValue:committedPlan.baselineExpectedNetFamilyValue,
    expectedDelta:committedPlan.expectedDeltaVsBaseline,
    protectionConstraints:constraints.protection??null,
    serviceConstraints:constraints.service??null,
    economicActions,
    contractSelections:{contractOptionId:committedPlan.contractOptionId,serviceChoiceId:committedPlan.serviceChoiceId},
    residualAllocation:optimizerActions.filter(a=>a.actionType==='RESIDUAL').map(a=>cloneFreeze(a)),
    capabilities:cloneFreeze(capabilities),
    assumptions:cloneFreeze(assumptions),
    provenance:cloneFreeze({...provenance,moduleEvidence:committedPlan.moduleEvidence??[]}),
    sourceSummary:sourceSummary==null?null:cloneFreeze(sourceSummary),
    rightsClaims:cloneFreeze(committedPlan.rightsClaims??[]),
    capacityClaimsByScenario:cloneFreeze(committedPlan.capacityClaimsByScenario??[]),
    identityHash:hash({planId:committedPlan.planId,generation:identity.generation,inputHash:identity.inputHash,rulesVersion:identity.rulesVersion,modelVersion:identity.modelVersion})
  };
  for(const k of ['expectedFamilyValue','baselineExpectedFamilyValue','expectedDelta'])finite(projection[k],k);
  return freeze(projection);
}

const forbiddenScenarioKeys=new Set(['winnerCandidateId','selectedStrategy','optimizerActions','contractOptionId','serviceChoiceId','economicActions']);

/** Scenario replay is supplied by the economic replay layer. U1 validates and projects it only. */
export function buildF8ScenarioProjection(planProjection,replay){
  if(planProjection?.schemaVersion!=='F8_PLAN_PROJECTION_V2'||!Object.isFrozen(planProjection))fail('frozen PlanProjection required');
  if(replay?.schemaVersion!=='F8_SCENARIO_REPLAY_V1'||replay.planId!==planProjection.planId)fail('scenario replay must reference selected plan');
  for(const k of forbiddenScenarioKeys)if(Object.hasOwn(replay,k))fail(`scenario replay may not alter plan field: ${k}`);
  const planned=finite(replay.familyValueAtMemberDeath,'scenario planned family value');
  const baseline=finite(replay.baselineValueAtMemberDeath,'scenario baseline family value');
  const out={
    schemaVersion:'F8_SCENARIO_PROJECTION_V2',
    scenarioId:replay.scenarioId,
    planId:planProjection.planId,
    planIdentityHash:planProjection.identityHash,
    memberDeathAge:replay.memberDeathAge??null,
    spouseDeathAge:replay.spouseDeathAge??null,
    valuationDate:replay.valuationDate??null,
    moneyBasis:replay.moneyBasis??null,
    familyValueAtMemberDeath:planned,
    baselineValueAtMemberDeath:baseline,
    scenarioDelta:planned-baseline,
    immediateCapital:replay.immediateCapital??null,
    survivorValue:replay.survivorValue??null,
    guaranteeValue:replay.guaranteeValue??null,
    spouseContinuationValue:replay.spouseContinuationValue??null,
    eventualEstateValue:replay.eventualEstateValue??null,
    productBalancesAtDeath:cloneFreeze(replay.productBalancesAtDeath??[]),
    scenarioCashflows:cloneFreeze(replay.scenarioCashflows??[]),
    yearlyRows:cloneFreeze(replay.yearlyRows??[]),
    warnings:cloneFreeze(replay.warnings??[]),
    unavailableComponents:cloneFreeze(replay.unavailableComponents??[]),
    replayProvenance:cloneFreeze(replay.provenance??{})
  };
  return freeze(out);
}

/** Pure presentation model. It exposes explicit status cells and shares the same canonical
 * action array across Journey/Table/Action Plan consumers. */
function valueCellFromRaw(raw,explicitStatus=null,meta={}){
  if(raw&&typeof raw==='object'&&Object.hasOwn(raw,'status')){
    const status=raw.status;
    if(!Object.values(VALUE_STATUS).includes(status))fail('invalid value cell status');
    const amount=[VALUE_STATUS.AVAILABLE_POSITIVE,VALUE_STATUS.AVAILABLE_ZERO].includes(status)?raw.amount:null;
    return freeze({...raw,status,amount,...meta});
  }
  return valueCell(raw,explicitStatus,meta);
}
function sourceValue(summary,key,statusIfMissing=VALUE_STATUS.UNKNOWN){
  const raw=summary?.[key];
  if(raw==null)return valueCell(null,statusIfMissing);
  return valueCellFromRaw(raw);
}
function sourceStage(summary,key){return summary?.[key]&&typeof summary[key]==='object'?summary[key]:{}}
function capabilityStatus(plan,key){
  const raw=plan.capabilities?.[key];
  if(typeof raw==='string')return raw;
  return raw?.status??null;
}
function notSelectedOrMissing(plan,key){
  const status=capabilityStatus(plan,key);
  if(status===CAPABILITY_STATUS.AVAILABLE_NOT_SELECTED)return VALUE_STATUS.AVAILABLE_NOT_SELECTED;
  if(status===CAPABILITY_STATUS.NOT_APPLICABLE)return VALUE_STATUS.NOT_APPLICABLE;
  if(status===CAPABILITY_STATUS.UNVERIFIED)return VALUE_STATUS.UNVERIFIED;
  if(status===CAPABILITY_STATUS.BLOCKED)return VALUE_STATUS.BLOCKED;
  return VALUE_STATUS.UNKNOWN;
}
function buildJourney(planProjection,scenarioProjection,component,actions){
  const src=planProjection.sourceSummary??{};
  const opening=sourceStage(src,'openingState');
  const transfer=sourceStage(src,'stage2');
  const annuity=sourceStage(src,'stage3');
  const stage2ActionRefs=actions.filter(a=>actionDestinationBucket(a)!=null).map(a=>a.actionId);
  const buckets=['SAVINGS_POLICY','T190_RECOGNIZED','T190_QUALIFYING'].map(bucketId=>{
    const b=transfer?.buckets?.[bucketId]??{};
    return freeze({bucketId,
      openingBalance:valueCellFromRaw(b.openingBalance??null,b.openingBalance==null?VALUE_STATUS.UNKNOWN:null),
      closingBalance:valueCellFromRaw(b.closingBalance??null,b.closingBalance==null?VALUE_STATUS.UNKNOWN:null),
      taxPaid:valueCellFromRaw(b.taxPaid??null,b.taxPaid==null?VALUE_STATUS.UNKNOWN:null),
      feesPaid:valueCellFromRaw(b.feesPaid??null,b.feesPaid==null?VALUE_STATUS.UNKNOWN:null),
      firstActionAge:b.firstActionAge??null,lastActionAge:b.lastActionAge??null,
      actionRefs:actions.filter(a=>actionDestinationBucket(a)===bucketId).map(a=>a.actionId)
    });
  });
  const hasAnnuity=annuity.status==='NOT_APPLICABLE'?false:[annuity.t190AnnuityMonthly,annuity.pensionFundMonthly,annuity.totalMonthly,annuity.commencementAge].some(v=>v!=null);
  const stage3Missing=hasAnnuity?VALUE_STATUS.UNKNOWN:notSelectedOrMissing(planProjection,'rotation');
  const stages=[
    freeze({type:'OPENING_STATE',age:opening.age??src.currentAge??null,capitalForPlanning:sourceValue(opening,'capitalForPlanning'),products:cloneFreeze(opening.products??src.originLots??[]),pensionContext:cloneFreeze(opening.pensionContext??null)}),
    freeze({type:'TRANSFER_JOURNEY',destinationColumns:['SAVINGS_POLICY','T190_RECOGNIZED','T190_QUALIFYING'],buckets,actionRefs:stage2ActionRefs}),
    freeze({type:'ANNUITY_ROTATION',status:annuity.status??(hasAnnuity?'AVAILABLE':'NOT_APPLICABLE'),commencementAge:annuity.commencementAge??null,
      t190AnnuityMonthly:valueCellFromRaw(annuity.t190AnnuityMonthly??null,annuity.t190AnnuityMonthly==null?stage3Missing:null),
      pensionFundMonthly:valueCellFromRaw(annuity.pensionFundMonthly??null,annuity.pensionFundMonthly==null?stage3Missing:null),
      totalMonthly:valueCellFromRaw(annuity.totalMonthly??null,annuity.totalMonthly==null?stage3Missing:null),
      requiredService:valueCellFromRaw(annuity.requiredService??null,annuity.requiredService==null?stage3Missing:null),
      survivorPct:valueCellFromRaw(annuity.survivorPct??null,annuity.survivorPct==null?stage3Missing:null),
      guaranteeMonths:valueCellFromRaw(annuity.guaranteeMonths??null,annuity.guaranteeMonths==null?stage3Missing:null),
      preservedFamilyValue:valueCellFromRaw(annuity.preservedFamilyValue??null,annuity.preservedFamilyValue==null?stage3Missing:null),
      actionRefs:actions.filter(a=>/ROTATION|ANNUIT/i.test(String(a.actionType))).map(a=>a.actionId)}),
    freeze({type:'FAMILY_OUTCOME',memberDeathAge:scenarioProjection.memberDeathAge,spouseDeathAge:scenarioProjection.spouseDeathAge,valuationDate:scenarioProjection.valuationDate,
      totalFamilyValue:component('familyValueAtMemberDeath',scenarioProjection.familyValueAtMemberDeath),
      immediateCapital:component('immediateCapital',scenarioProjection.immediateCapital),
      survivorValue:component('survivorValue',scenarioProjection.survivorValue),guaranteeValue:component('guaranteeValue',scenarioProjection.guaranteeValue),
      spouseContinuationValue:component('spouseContinuationValue',scenarioProjection.spouseContinuationValue),eventualEstateValue:component('eventualEstateValue',scenarioProjection.eventualEstateValue)})
  ];
  return freeze({actionRefs:actions.map(a=>a.actionId),stages,sourceSummary:planProjection.sourceSummary,scenarioComponents:stages[3]});
}

/** Pure presentation model. It exposes explicit status cells and shares the same canonical
 * action array across Journey/Table/Action Plan consumers. U1D adds only semantic mapping;
 * it does not compute balances, taxes, annuities, survivor values or the headline total. */
export function buildInheritanceViewModel(planProjection,scenarioProjection,{displayBasis='REAL',route='INHERITANCE',goal='INHERITANCE'}={}){
  if(planProjection?.schemaVersion!=='F8_PLAN_PROJECTION_V2'||scenarioProjection?.schemaVersion!=='F8_SCENARIO_PROJECTION_V2')fail('plan and scenario projections required');
  if(scenarioProjection.planId!==planProjection.planId||scenarioProjection.planIdentityHash!==planProjection.identityHash)fail('plan/scenario identity mismatch');
  if(route!=='INHERITANCE'||goal!=='INHERITANCE')fail('inheritance ViewModel is route-scoped');
  const actions=planProjection.economicActions;
  const component=(name,value)=>valueCell(value,scenarioProjection.unavailableComponents.includes(name)?VALUE_STATUS.UNKNOWN:null);
  const planned=component('familyValueAtMemberDeath',scenarioProjection.familyValueAtMemberDeath);
  const baseline=component('baselineValueAtMemberDeath',scenarioProjection.baselineValueAtMemberDeath);
  const expectedPlanned=valueCell(planProjection.expectedFamilyValue),expectedBaseline=valueCell(planProjection.baselineExpectedFamilyValue),expectedDelta=valueCell(planProjection.expectedDelta);
  const journey=buildJourney(planProjection,scenarioProjection,component,actions);
  const stage3=journey.stages.find(s=>s.type==='ANNUITY_ROTATION');
  const yearlyRows=buildYearlyTableRows(scenarioProjection.yearlyRows,actions);
  const actionPlan=buildActionPlan(actions,stage3);
  const scenarioUnderperforms=planned.amount!=null&&baseline.amount!=null&&planned.amount<baseline.amount;
  const vm={
    schemaVersion:'F8_INHERITANCE_VIEW_MODEL_V2',
    identity:{schemaVersion:'F8_VIEW_IDENTITY_V1',planId:planProjection.planId,scenarioId:scenarioProjection.scenarioId,generation:planProjection.generation,inputHash:planProjection.inputHash,rulesVersion:planProjection.rulesVersion,modelVersion:planProjection.modelVersion,identityHash:planProjection.identityHash},
    route:'INHERITANCE',goal:'INHERITANCE',displayBasis,
    headline:{baseline:{...baseline,total:baseline,label:'ללא תכנון'},planned:{...planned,total:planned,label:'עם התכנון'},delta:component('scenarioDelta',scenarioProjection.scenarioDelta),expectedPlanned,expectedBaseline,expectedDelta,
      expectedPlanExplanation:scenarioUnderperforms?'התוכנית נבחרה לפי הערך המשפחתי הצפוי. בתרחיש הפטירה שמוצג כעת התוצאה נמוכה מהחלופה ללא תכנון.':'התוכנית נבחרה לפי הערך המשפחתי הצפוי, בנפרד מתרחיש הפטירה שמוצג כעת.'},
    journey,
    yearlyTable:{rows:yearlyRows,actionRefs:actionPlan.actionRefs},
    actionPlan,
    scenarioControls:{memberDeathAge:scenarioProjection.memberDeathAge,spouseDeathAge:scenarioProjection.spouseDeathAge,planId:planProjection.planId,reoptimizationAllowed:false},
    professionalDetails:{blockedReasons:planProjection.blockedReasons,selectedStrategy:planProjection.selectedStrategy,rightsClaims:planProjection.rightsClaims,capacityClaimsByScenario:planProjection.capacityClaimsByScenario,provenance:planProjection.provenance},
    capabilityStatus:planProjection.capabilities,
    warnings:[...scenarioProjection.warnings,...(planProjection.productionReady?[]:['התוכנית מוצגת בסביבת WORKING_QA ואינה תוצאת Production.'])]
  };
  vm.reconciliation=reconcileU1DViewModel(vm);
  return freeze(vm);
}
