import {EconomicPathLedger,LotLedger} from '../../F8_CORE/src/ledgers.js';
import {allocateUnifiedResidual} from '../m3/residual-allocator.js';
import {evaluateQualifyingPolicyProfessionalSimulationBeta} from '../m5/qualifying-replay.js';
import {MethodologyBlocked} from '../m1/valuation.js';

const EPS=1e-8;
const MODE='PROFESSIONAL_SIMULATION_BETA';
const fail=m=>{throw new MethodologyBlocked(m)};
const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v)}return v};
const copyFreeze=v=>freeze(structuredClone(v));
const num=(v,label)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<0)fail(`${label} must be nonnegative finite`);return v};
const iso=s=>{if(typeof s!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)||
  !Number.isFinite(Date.parse(`${s}T00:00:00Z`))||new Date(`${s}T00:00:00Z`).toISOString().slice(0,10)!==s)
  fail('exact ISO date required');return s};
const scenarioEnd=s=>iso(s.kind==='MEMBER_DEATH'?s.memberDeathDate:s.kind==='SURVIVE_TO_TERMINAL_HORIZON'?s.terminalDate:fail('explicit member-death or terminal branch required'));
const forbiddenSlider=x=>{for(const k of ['memberDeathAge','spouseDeathAge','deathSlider','disabilityAge'])if(Object.hasOwn(x,k))fail('scenario slider forbidden from M8 receipt policy')};

function validateNiAuthority(raw,input){
  const a=structuredClone(raw);
  if(a?.schemaVersion!=='F8_M8_BETA_NI_HEALTH_AUTHORITY_V1'||a.mode!==MODE||
    a.simulationAuthorized!==true||a.productionVerified!==false||
    a.assumptionPackHash!==input.assumptionPackHash||!a.version||!Array.isArray(a.quotes)||
    a.provenance?.verificationStatus!=='SIMULATION_ASSUMPTION'||
    a.provenance?.productionVerified!==false||!a.provenance?.sourceReference)
    fail('explicit Professional Simulation NI/health authority required');
  const map=new Map();
  for(const q of a.quotes){
    if(!q.quoteId||!q.receiptId||!q.classification||!q.provenance?.version||
      q.provenance?.verificationStatus!=='SIMULATION_ASSUMPTION'||
      q.provenance?.productionVerified!==false)fail('NI/health quote provenance required');
    iso(q.date);num(q.amount,'NI/health amount');
    if(map.has(q.receiptId))fail('duplicate NI/health quote for receipt');
    map.set(q.receiptId,q);
  }
  return {authority:a,byReceipt:map};
}

function validateStateModel(model,label){
  if(!model?.wrapper||!['cash','savings_policy','t190'].includes(model.wrapper)||
    !model.provenance?.version||!model.deathRule?.version||!model.terminalContinuationRule?.version||
    !['nominal','indexed','exempt'].includes(model.deathRule.basis)||
    !['nominal','indexed','exempt'].includes(model.terminalContinuationRule.basis)||
    num(model.deathRule.rate,`${label} death rate`)>1||
    num(model.terminalContinuationRule.rate,`${label} terminal rate`)>1||
    num(model.basisNominalPerUnit,`${label} nominal basis per unit`)<0||
    num(model.basisIndexedPerUnit,`${label} indexed basis per unit`)<0||
    !model.intervalsByReceiptScenario||typeof model.intervalsByReceiptScenario!=='object')
    fail(`complete dated state model required: ${label}`);
  return model;
}

function exactInterval(model,receiptId,scenarioId,fromDate,toDate){
  const rows=model.intervalsByReceiptScenario?.[receiptId]?.[scenarioId];
  if(!Array.isArray(rows))fail(`dated state intervals missing: ${receiptId}/${scenarioId}`);
  const row=rows.find(q=>q?.fromDate===fromDate&&q?.toDate===toDate);
  if(!row||!row.provenance?.version)fail(`exact dated state quote missing: ${receiptId}/${scenarioId} ${fromDate} ${toDate}`);
  return structuredClone(row);
}

function betaAuthority(input){
  return {schemaVersion:'F8_M5_BETA_AUTHORITY_V1',simulationAuthorized:true,
    productionVerified:false,assumptionPackHash:input.assumptionPackHash,caseId:input.caseId};
}

function betaProvenance(input,version){
  return {version,simulationMode:MODE,assumptionPackHash:input.assumptionPackHash,
    productionVerified:false};
}

function m5ReplayInput({input,receipt,scenario,sourceAmount,sourceId,sourcePathId,
  sourceModel,policyAction=null,qualifyingModel=null,capacityRows=[]}){
  const action=policyAction?{...structuredClone(policyAction),sourceLotId:sourceId}:null;
  const scenarioRows=[{...structuredClone(scenario),probability:1}];
  if(scenario.kind==='MEMBER_DEATH'){
    const terminal=input.scenarios.find(s=>s.kind==='SURVIVE_TO_TERMINAL_HORIZON');
    if(!terminal||scenarioEnd(terminal)<scenarioEnd(scenario))fail('terminal support branch required after death scenario');
    scenarioRows.push({...structuredClone(terminal),id:`${terminal.id}:support:${scenario.id}`,probability:0});
  }
  const exactQuotes={[sourceId]:{}};
  for(const row of scenarioRows){
    const sid=row.id.includes(':support:')?row.id.split(':support:')[0]:row.id,end=scenarioEnd(row);
    exactQuotes[sourceId][`${receipt.date}|${end}`]=exactInterval(sourceModel,receipt.id,sid,receipt.date,end);
  }
  if(action){
    const qid=`q:${action.id}`;
    exactQuotes[qid]={};
    for(const row of scenarioRows){
      const sid=row.id.includes(':support:')?row.id.split(':support:')[0]:row.id,end=scenarioEnd(row);
      exactQuotes[qid][`${receipt.date}|${end}`]=exactInterval(qualifyingModel,receipt.id,sid,receipt.date,end);
    }
  }
  const deathRules={[sourceModel.wrapper]:structuredClone(sourceModel.deathRule)};
  const terminalContinuationRules={[sourceModel.wrapper]:structuredClone(sourceModel.terminalContinuationRule)};
  if(action){
    deathRules[qualifyingModel.wrapper]=structuredClone(qualifyingModel.deathRule);
    terminalContinuationRules[qualifyingModel.wrapper]=structuredClone(qualifyingModel.terminalContinuationRule);
  }
  return {schemaVersion:'F8_M5_QUALIFYING_REPLAY_V1',mode:MODE,personId:input.ownerId,
    currency:input.currency,baseDate:receipt.date,
    sources:[{id:sourceId,economicPathId:sourcePathId,ownerId:input.ownerId,
      wrapper:sourceModel.wrapper,stateDate:receipt.date,contributionDate:receipt.date,
      availabilityDate:receipt.date,sourceEventId:`${receipt.sourceEventId}:state:${sourceId}`,
      currency:input.currency,sourceType:'annuity_reinvestment',amount:sourceAmount,
      basisNominal:sourceAmount*sourceModel.basisNominalPerUnit,
      basisIndexed:sourceAmount*sourceModel.basisIndexedPerUnit}],
    capacity:structuredClone(capacityRows),
    scenarios:scenarioRows,
    exactQuotes,deathRules,terminalContinuationRules,
    valuationConvention:structuredClone(input.valuationConvention),
    policy:{schemaVersion:'F8_CONTINGENT_POLICY_V1',version:`M8_RECEIPT_POLICY:${receipt.id}`,
      personId:input.ownerId,actions:action?[action]:[]},
    provenance:betaProvenance(input,`M8_RECEIPT_STATE:${input.provenance.version}:${receipt.id}`)};
}

function distilledState(run){
  const r=run.planned[0];
  return copyFreeze({scenarioId:r.scenarioId,kind:r.kind,endDate:r.endDate,
    actions:r.actions,economicActions:r.economicActions,executedCapacity:r.executedCapacity,
    finalUses:r.finalUses,sinks:r.sinks,liveLots:r.liveLots,reconciliation:r.reconciliation,
    valuationRecognition:'STATE_ONLY_NO_RECEIPT_PV'});
}

function currentCapacity(input,executedByYear){
  return input.capacity.map(c=>({...structuredClone(c),alreadyUsed:c.alreadyUsed+(executedByYear.get(c.taxYear)||0)}));
}

function qActionForReceipt(input,receipt){
  const p=input.receiptQualifyingPolicy?.[receipt.id];
  if(!p||p.selected!==true)return null;
  if(!p.actionId||!p.contractId||!p.taxRule||!p.destinationBasis||num(p.maxGross,'receipt-funded Q maxGross')<=0)
    fail('complete frozen receipt-funded Qualifying action required');
  return {id:p.actionId,type:'QUALIFYING_DEPOSIT',date:receipt.date,sourceLotId:'BOUND_BY_M8',
    contractId:p.contractId,maxGross:p.maxGross,taxRule:structuredClone(p.taxRule),
    destinationBasis:structuredClone(p.destinationBasis)};
}

function aliveAtReceipt(s,receiptDate){
  const end=scenarioEnd(s);
  if(end===receiptDate)fail('same-day receipt/death or terminal ordering requires explicit evidence');
  return end>receiptDate;
}

function qualifyingPlanAtReceipt({input,receipt,surplus,capacityBefore,action}){
  if(!action||surplus<=EPS)return {gross:0,net:0,tax:0,capacityUsed:0,action:null};
  const year=Number(receipt.date.slice(0,4));
  const cap=capacityBefore.find(c=>c.taxYear===year);
  if(!cap||cap.available-cap.alreadyUsed<=EPS)return {gross:0,net:0,tax:0,capacityUsed:0,action:null};
  const alive=input.scenarios.filter(s=>aliveAtReceipt(s,receipt.date));
  if(!alive.length)return {gross:0,net:0,tax:0,capacityUsed:0,action:null};
  const qResults=[];
  for(const s of alive){
    const srcId=`m8:qquote:${receipt.id}:${s.id}`,srcPath=`m8:qquote:path:${receipt.id}:${s.id}`;
    const dto=m5ReplayInput({input,receipt,scenario:s,sourceAmount:surplus,sourceId:srcId,
      sourcePathId:srcPath,sourceModel:input.cashStateModel,policyAction:action,
      qualifyingModel:input.qualifyingStateModel,capacityRows:capacityBefore});
    const run=evaluateQualifyingPolicyProfessionalSimulationBeta(dto,betaAuthority(input));
    const row=run.planned[0].actions.find(x=>x.actionId===action.id);
    if(!row)fail('M5 did not return receipt-funded Qualifying action');
    qResults.push(row);
  }
  const first=qResults[0];
  for(const r of qResults.slice(1))for(const k of ['grossAmount','netAmount','tax','capacityUsed'])
    if(Math.abs(r[k]-first[k])>EPS)fail('future scenario changed receipt-funded Qualifying action');
  return {gross:first.grossAmount,net:first.netAmount,tax:first.tax,
    capacityUsed:first.capacityUsed,action:first};
}

function validateReceipt(receipt,input,niByReceipt){
  if(!receipt?.id||!receipt.rightId||!receipt.contractId||!receipt.ruleId||
    !receipt.sourceEventId||!receipt.economicPathId||!receipt.provenance?.version)
    fail('contractual receipt provenance required');
  iso(receipt.date);num(receipt.gross,'receipt gross');num(receipt.requiredConsumption,'required service');
  const t=receipt.taxTreatment;
  if(!t?.version||t.status!=='SIMULATION_ASSUMPTION'||t.productionVerified!==false||
    !t.sourceReference)fail('authorized receipt tax treatment required');
  num(t.amount,'receipt tax');
  const nq=niByReceipt.get(receipt.id);
  if(!nq||nq.date!==receipt.date)fail('missing NI/health classification is not zero');
  if(t.amount+nq.amount+receipt.requiredConsumption>receipt.gross+EPS)
    fail('receipt cannot fund tax, NI/health and required service');
  return nq;
}

function residualQuoteFor(receipt,residualAmount,input){
  if(residualAmount<=EPS)return null;
  const q=structuredClone(receipt.residualQuote);
  if(q?.schemaVersion!=='F8_UNIFIED_RESIDUAL_V1'||q.asOfDate!==receipt.date||
    q.ownerId!==input.ownerId||q.currency!==input.currency||q.sources?.length!==1||
    Math.abs(q.sources[0].amount-residualAmount)>EPS)
    fail('receipt residual quote must match post-Q dated remainder');
  return q;
}

function immediateReceiptLedger({input,receipt,niQuote,qGross,residualPlan}){
  const paths=new EconomicPathLedger(),lots=new LotLedger(paths);
  const root=paths.open(receipt.economicPathId,receipt.gross,{currentOwner:'member',sourceEventId:receipt.sourceEventId});
  let seq=0;const id=tag=>`${receipt.economicPathId}:qr1:${seq++}:${tag}`;
  const sink=(category,amount)=>{if(amount<=EPS)return;const p=paths.open(id(`${category}:path`),amount,
    {parentPathId:root.id,currentOwner:'member',sourceEventId:`${receipt.id}:${category}:${receipt.date}`});
    paths.sink(p.id,id(`${category}:sink`),category,receipt.date,amount)};
  sink('receipt_tax',receipt.taxTreatment.amount);sink('ni_health',niQuote.amount);sink('required_consumption',receipt.requiredConsumption);
  const qNetOfReceiptTax=receipt.gross-receipt.taxTreatment.amount-niQuote.amount-receipt.requiredConsumption;
  if(qGross>EPS){const p=paths.open(id('receipt_funded_q'),qGross,{parentPathId:root.id,currentOwner:'member',sourceEventId:`${receipt.id}:q:${receipt.date}`});
    lots.add({id:id('q_opening_lot'),owner:'member',wrapper:'cash',providerId:'M8_METHOD',sourceType:'annuity_reinvestment',
      contributionDate:receipt.date,originalPrincipal:qGross,currentValue:qGross,taxBasisNominal:qGross,taxBasisReal:qGross,
      taxClass:'other',classificationStatus:'M8_QR1_SIMULATION',deathRuleId:'M8_QR1_SIMULATION',withdrawalRuleId:'M8_QR1_SIMULATION',
      feeScheduleId:'M8_QR1_EXACT_QUOTE',liquidityClass:'M8_QR1',economicPathId:p.id});}
  let residualAllocated=0;
  for(const a of residualPlan?.allocations??[]){
    residualAllocated+=a.amount;
    const model=input.residualStateModels[a.destinationId];
    if(!model)fail(`residual state model missing: ${a.destinationId}`);
    const p=paths.open(id(`residual:${a.destinationId}`),a.amount,{parentPathId:root.id,currentOwner:'member',sourceEventId:`${receipt.id}:residual:${receipt.date}`});
    lots.add({id:id(`residual_lot:${a.destinationId}`),owner:'member',wrapper:model.wrapper,providerId:'M8_METHOD',sourceType:'annuity_reinvestment',
      contributionDate:receipt.date,originalPrincipal:a.amount,currentValue:a.amount,
      taxBasisNominal:a.amount*model.basisNominalPerUnit,taxBasisReal:a.amount*model.basisIndexedPerUnit,
      taxClass:model.wrapper==='t190'?'recognized':'other',classificationStatus:'M8_QR1_SIMULATION',
      deathRuleId:model.deathRule.version,withdrawalRuleId:'M8_QR1_SIMULATION',feeScheduleId:'M8_QR1_EXACT_QUOTE',
      liquidityClass:'M8_QR1',economicPathId:p.id});
  }
  const expectedResidual=qNetOfReceiptTax-qGross;
  if(Math.abs(residualAllocated-expectedResidual)>EPS)fail('M3 residual allocation did not conserve post-Q receipt remainder');
  const reconciliation=paths.reconcile(lots);
  if(Math.abs(reconciliation.gap)>EPS||Math.abs(reconciliation.liveTotal-qNetOfReceiptTax)>EPS)
    fail('receipt-root accounting closure failed');
  return copyFreeze({reconciliation,sinks:paths.sinks(),liveLots:lots.lots(),
    waterfall:{gross:receipt.gross,receiptTax:receipt.taxTreatment.amount,niHealth:niQuote.amount,
      requiredService:receipt.requiredConsumption,receiptFundedQ:qGross,residualReinvested:expectedResidual,
      gap:receipt.gross-(receipt.taxTreatment.amount+niQuote.amount+receipt.requiredConsumption+qGross+expectedResidual)}});
}

function qStateForScenario({input,receipt,scenario,qPlan,capacityBefore}){
  if(qPlan.gross<=EPS)return null;
  const sourceId=`m8:qstate:${receipt.id}:${scenario.id}`,sourcePath=`m8:qstate:path:${receipt.id}:${scenario.id}`;
  const action=qActionForReceipt(input,receipt);
  action.maxGross=qPlan.gross;
  const dto=m5ReplayInput({input,receipt,scenario,sourceAmount:qPlan.gross,sourceId,
    sourcePathId:sourcePath,sourceModel:input.cashStateModel,policyAction:action,
    qualifyingModel:input.qualifyingStateModel,capacityRows:capacityBefore});
  const run=evaluateQualifyingPolicyProfessionalSimulationBeta(dto,betaAuthority(input));
  const state=distilledState(run),actual=state.actions.find(x=>x.actionId===action.id);
  if(!actual||Math.abs(actual.grossAmount-qPlan.gross)>EPS||Math.abs(actual.netAmount-qPlan.net)>EPS||
    Math.abs(actual.capacityUsed-qPlan.capacityUsed)>EPS)fail('frozen receipt-funded Qualifying action changed during scenario replay');
  return state;
}

function residualStatesForScenario({input,receipt,scenario,residualPlan}){
  const grouped=new Map();
  for(const a of residualPlan?.allocations??[])grouped.set(a.destinationId,(grouped.get(a.destinationId)||0)+a.amount);
  const states=[];
  for(const [destinationId,amount] of grouped){
    if(amount<=EPS)continue;
    const model=validateStateModel(input.residualStateModels[destinationId],`residual ${destinationId}`);
    const sourceId=`m8:rstate:${receipt.id}:${scenario.id}:${destinationId}`,
      sourcePath=`m8:rstate:path:${receipt.id}:${scenario.id}:${destinationId}`;
    const dto=m5ReplayInput({input,receipt,scenario,sourceAmount:amount,sourceId,sourcePathId:sourcePath,
      sourceModel:model,capacityRows:[]});
    const run=evaluateQualifyingPolicyProfessionalSimulationBeta(dto,betaAuthority(input));
    states.push({destinationId,openingAmount:amount,state:distilledState(run)});
  }
  return copyFreeze(states);
}

function normalize(raw){
  const x=structuredClone(raw);forbiddenSlider(x);
  if(x?.schemaVersion!=='F8_M8_RECEIPT_PIPELINE_V1'||x.mode!==MODE||!x.caseId||!x.ownerId||!x.currency||
    !/^[a-f0-9]{64}$/i.test(x.assumptionPackHash??'')||!x.provenance?.version||
    x.provenance.simulationMode!==MODE||x.provenance.productionVerified!==false||
    !Array.isArray(x.receipts)||!x.receipts.length||!Array.isArray(x.scenarios)||!x.scenarios.length||
    !Array.isArray(x.capacity)||!x.valuationConvention||!x.cashStateModel||!x.qualifyingStateModel||
    !x.residualStateModels)fail('complete qR1 Professional Simulation receipt pipeline input required');
  validateStateModel(x.cashStateModel,'cash');validateStateModel(x.qualifyingStateModel,'qualifying');
  for(const [k,v] of Object.entries(x.residualStateModels))validateStateModel(v,`residual ${k}`);
  const seenScenarios=new Set();for(const s of x.scenarios){if(!s.id||seenScenarios.has(s.id))fail('unique scenario required');seenScenarios.add(s.id);scenarioEnd(s)}
  const seenReceipts=new Set();x.receipts.sort((a,b)=>a.date.localeCompare(b.date));
  for(const r of x.receipts){if(!r.id||seenReceipts.has(r.id))fail('unique receipt required');seenReceipts.add(r.id);iso(r.date)}
  const ni=validateNiAuthority(x.niHealthAuthority,x);
  for(const r of x.receipts)validateReceipt(r,x,ni.byReceipt);
  return {input:copyFreeze(x),ni};
}

/**
 * qR1 only: replay an already-created annuity receipt schedule through tax/NI/service,
 * receipt-funded Qualifying (when the frozen policy selects it and same-date capacity exists),
 * Unified Residual, and exact dated state evolution. This function does not choose q capital,
 * create an annuitization frontier, or certify an annuitization decision.
 */
export function replayAnnuitizationReceiptPipelineProfessionalSimulationBeta(raw){
  const {input,ni}=normalize(raw),plannedCapacity=new Map();
  const planned=[];
  for(const receipt of input.receipts){
    const niQuote=ni.byReceipt.get(receipt.id),surplus=receipt.gross-receipt.taxTreatment.amount-niQuote.amount-receipt.requiredConsumption,
      capBefore=currentCapacity(input,plannedCapacity),action=qActionForReceipt(input,receipt),
      qPlan=qualifyingPlanAtReceipt({input,receipt,surplus,capacityBefore:capBefore,action});
    if(qPlan.capacityUsed>EPS){const y=Number(receipt.date.slice(0,4));plannedCapacity.set(y,(plannedCapacity.get(y)||0)+qPlan.capacityUsed)}
    const residualAmount=surplus-qPlan.gross,quote=residualQuoteFor(receipt,residualAmount,input),
      residualPlan=quote?allocateUnifiedResidual(quote):null;
    planned.push({receiptId:receipt.id,date:receipt.date,surplus,qPlan,residualAmount,residualPlan,
      capacityBefore:capBefore});
  }
  const scenarios=input.scenarios.map(s=>{
    const end=scenarioEnd(s),receipts=[];
    for(let i=0;i<input.receipts.length;i++){
      const receipt=input.receipts[i],plan=planned[i],niQuote=ni.byReceipt.get(receipt.id);
      if(end===receipt.date)fail('same-day receipt/death or terminal ordering requires explicit evidence');
      if(end<receipt.date){receipts.push({receiptId:receipt.id,date:receipt.date,status:'NO_FUTURE_RECEIPT',
        qState:null,residualStates:[],immediateReconciliation:null,waterfall:null});continue}
      const immediate=immediateReceiptLedger({input,receipt,niQuote,qGross:plan.qPlan.gross,residualPlan:plan.residualPlan}),
        qState=qStateForScenario({input,receipt,scenario:s,qPlan:plan.qPlan,capacityBefore:plan.capacityBefore}),
        residualStates=residualStatesForScenario({input,receipt,scenario:s,residualPlan:plan.residualPlan});
      const childOpening=(qState?plan.qPlan.gross:0)+residualStates.reduce((n,x)=>n+x.openingAmount,0);
      if(Math.abs(childOpening-plan.surplus)>EPS)fail('receipt-derived state opening mismatch');
      for(const st of [qState,...residualStates.map(x=>x.state)].filter(Boolean))if(Math.abs(st.reconciliation.gap)>EPS)
        fail('receipt-derived state reconciliation failed');
      receipts.push({receiptId:receipt.id,date:receipt.date,status:'RECEIPT_EXECUTED',
        waterfall:immediate.waterfall,immediateReconciliation:immediate.reconciliation,
        qState,residualStates,stateReconciliation:{openingReceiptDerived:childOpening,
          expectedOpening:plan.surplus,gap:childOpening-plan.surplus,
          childReconciliationGaps:[qState,...residualStates.map(x=>x.state)].filter(Boolean).map(x=>x.reconciliation.gap)},
        antiDoubleCount:{receiptPvRecognized:false,stateOnlyRecognition:true,
          rule:'STATE_ONLY_NO_RECEIPT_PV'}});
    }
    const capacityExecutedByYear=new Map();
    for(const r of receipts)if(r.qState)for(const c of r.qState.executedCapacity)
      capacityExecutedByYear.set(c.taxYear,(capacityExecutedByYear.get(c.taxYear)||0)+c.executed);
    for(const c of input.capacity){const executed=capacityExecutedByYear.get(c.taxYear)||0;
      if(c.alreadyUsed+executed>c.available+EPS)fail('dated Qualifying capacity consumed more than once')}
    return {scenarioId:s.id,kind:s.kind,endDate:end,receipts,
      capacityExecution:[...capacityExecutedByYear].map(([taxYear,executed])=>({taxYear,executed})),
      futureCapacityCreditedAsAsset:false,annuitizationDecisionCertified:false};
  });
  return copyFreeze({schemaVersion:'F8_M8_RECEIPT_PIPELINE_REPLAY_V1',mode:MODE,caseId:input.caseId,
    plannedReceipts:planned.map(p=>({receiptId:p.receiptId,date:p.date,surplus:p.surplus,
      receiptFundedQGross:p.qPlan.gross,receiptFundedQNet:p.qPlan.net,
      qTransferTax:p.qPlan.tax,capacityUsed:p.qPlan.capacityUsed,residualAmount:p.residualAmount,
      residualAllocations:p.residualPlan?.allocations??[]})),
    scenarios,niHealthAuthority:{version:ni.authority.version,provenance:ni.authority.provenance},
    valuationRecognition:'STATE_ONLY_NO_RECEIPT_PV',globalOptimal:false,
    annuitizationDecisionCertified:false,productionReady:false});
}
