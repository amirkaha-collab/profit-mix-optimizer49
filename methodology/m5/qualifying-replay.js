import {EconomicPathLedger,LotLedger} from '../../F8_CORE/src/ledgers.js';
import {evaluateClosedDistribution,MethodologyBlocked} from '../m1/valuation.js';
import {normalizeContingentPolicy} from '../m4/contingent-policy.js';
import {memberInitiatedActionOrdering} from '../shared/event-ordering-contract.js';
import {RECONCILIATION_EPS,isDecisionPositive} from '../shared/numerical-contract.js';
const fail=m=>{throw new MethodologyBlocked(m)};
const snapFloating=(actual,reference)=>Math.abs(actual-reference)<=Number.EPSILON*32*Math.max(1,Math.abs(actual),Math.abs(reference))?reference:actual;
const copyFreeze=x=>{const c=structuredClone(x);const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v)}return v};return freeze(c)};
const positive=(x,label)=>{if(typeof x!=='number'||!Number.isFinite(x)||x<0)fail(`${label} must be nonnegative finite`);return x};
const validateDate=s=>{if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s)||
  !Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)
  fail('exact ISO event date required');return s};
const key=(from,to)=>`${from}|${to}`;

function normalizeCommon(raw,allowedModes){
  const x=structuredClone(raw);
  if(x?.schemaVersion!=='F8_M5_QUALIFYING_REPLAY_V1'||
    !allowedModes.includes(x.mode)||!x.personId||
    !Array.isArray(x.sources)||!Array.isArray(x.capacity)||!Array.isArray(x.scenarios)||
    !x.exactQuotes||!x.deathRules||!x.terminalContinuationRules||
    !x.valuationConvention||!x.currency)fail('complete qualifying replay DTO required');
  validateDate(x.baseDate);
  if(x.policy?.personId!==x.personId)fail('policy and canonical person mismatch');
  x.policy=normalizeContingentPolicy(x.policy);
  if(x.policy.actions.some(a=>a.type!=='QUALIFYING_DEPOSIT'))
    fail('M5 executes qualifying actions only');
  const ids=new Set(),paths=new Set();
  for(const s of x.sources){
    if(!s.id||!s.economicPathId||ids.has(s.id)||paths.has(s.economicPathId)||
       s.ownerId!==x.personId||!['savings_policy','cash','t190'].includes(s.wrapper)||
       s.stateDate!==x.baseDate||!s.contributionDate||
       !s.sourceEventId||!s.currency||
       !['fresh_contribution','annuity_reinvestment','transfer','realization_proceeds'].includes(s.sourceType))
      fail('separate owned source lot required');
    ids.add(s.id);paths.add(s.economicPathId);
    validateDate(s.availabilityDate);validateDate(s.contributionDate);
    for(const field of ['amount','basisNominal','basisIndexed'])positive(s[field],field);
  }
  for(const a of x.policy.actions){
    if(!ids.has(a.sourceLotId)||a.date<x.baseDate)fail('action source/date invalid');
    const source=x.sources.find(s=>s.id===a.sourceLotId);
    if(a.date<source.availabilityDate)fail('source unavailable at planned action date');
    if(a.taxRule?.source!=='EXPLICIT_QUOTE'||!a.taxRule?.version||
       !['nominal','indexed','exempt'].includes(a.taxRule.basis)||
       positive(a.taxRule.rate,'dated tax rate')>1||
       !a.destinationBasis?.version)fail('dated tax and destination basis quote required');
    for(const f of ['nominalPerNet','indexedPerNet'])positive(a.destinationBasis[f],f);
  }
  const capYears=new Set();
  for(const c of x.capacity){
    const allowedCapacityStatus=x.mode==='PROFESSIONAL_SIMULATION_BETA'?
      c.legalRule?.status==='SIMULATION_ASSUMPTION':
      ['VERIFIED','VERIFIED_CONDITIONAL'].includes(c.legalRule?.status);
    if(c.personId!==x.personId||!Number.isInteger(c.taxYear)||capYears.has(c.taxYear)||
       !c.ruleId||!c.provenance?.version||c.legalRule?.ruleId!==c.ruleId||
       !allowedCapacityStatus||!c.legalRule.effectiveFrom||!c.legalRule.calculationVersion||
       !c.legalRule.jurisdiction||!c.legalRule.source)
      fail('individual annual capacity and explicit legal rule required');
    if(x.mode==='WORKING_QA'&&c.legalRule.source==='LEGACY_COMPATIBILITY'&&
       (c.legalRule.productionVerified!==false||c.legalRule.useScope!=='WORKING_QA'))
      fail('unverified legacy rule restricted to WORKING_QA');
    if(x.mode==='PROFESSIONAL_SIMULATION_BETA'&&(
       c.legalRule.source!=='F8_BETA_QUALIFYING_CAPACITY_ASSUMPTION_V1'||
       c.legalRule.productionVerified!==false||
       c.legalRule.simulationMode!=='PROFESSIONAL_SIMULATION_BETA'||
       !c.legalRule.assumptionPackHash))
      fail('explicit Beta qualifying capacity assumption required');
    capYears.add(c.taxYear);
    positive(c.available,'available capacity');positive(c.alreadyUsed,'prior capacity');
    if(c.alreadyUsed>c.available+RECONCILIATION_EPS)fail('capacity overspent before plan');
  }
  for(const a of x.policy.actions)
    if(!capYears.has(Number(a.date.slice(0,4))))fail('explicit annual legal capacity required');
  for(const a of x.policy.actions){
    const legal=x.capacity.find(c=>c.taxYear===Number(a.date.slice(0,4))).legalRule;
    validateDate(legal.effectiveFrom);
    if(a.date<legal.effectiveFrom||
       legal.effectiveTo!=null&&a.date>validateDate(legal.effectiveTo))
      fail('legal capacity rule not effective at action date');
  }
  if(x.mode==='WORKING_QA'&&(x.provenance?.source!=='LEGACY_COMPATIBILITY'||
     x.provenance.productionVerified!==false||x.provenance.useScope!=='WORKING_QA'))
    fail('provisional legal provenance required');
  for(const k of ['memberDeathAge','spouseDeathAge','deathSlider'])if(Object.hasOwn(x,k))
    fail('scenario slider forbidden from policy input');
  return copyFreeze(x);
}
function normalizeQa(raw){return normalizeCommon(raw,['SYNTHETIC_TEST_ONLY','WORKING_QA'])}
function normalizeBeta(raw,authority){
  const x=normalizeCommon(raw,['PROFESSIONAL_SIMULATION_BETA']);
  if(authority?.schemaVersion!=='F8_M5_BETA_AUTHORITY_V1'||authority.simulationAuthorized!==true||
     authority.productionVerified!==false||!/^[a-f0-9]{64}$/i.test(authority.assumptionPackHash??'')||
     !authority.caseId)fail('strict professional simulation Beta qualifying authority required');
  if(x.provenance?.simulationMode!=='PROFESSIONAL_SIMULATION_BETA'||
     x.provenance?.assumptionPackHash!==authority.assumptionPackHash||
     x.provenance?.productionVerified!==false)fail('Beta qualifying input not bound to assumption pack');
  for(const c of x.capacity)if(c.legalRule.assumptionPackHash!==authority.assumptionPackHash)
    fail('Beta qualifying capacity not bound to assumption pack');
  const forbidden=/LEGACY_COMPATIBILITY|WORKING_QA|SYNTHETIC_TEST_ONLY/;
  const scan=(v,path='input')=>{if(typeof v==='string'&&forbidden.test(v))fail(`forbidden Beta qualifying evidence at ${path}`);if(v&&typeof v==='object')for(const [k,z] of Object.entries(v))scan(z,`${path}.${k}`)};
  scan(x);scan(authority,'authority');
  return x;
}

function coreLot(s){return {id:s.id,owner:'member',wrapper:s.wrapper,
  providerId:'METHOD_QA_CONTRACT',sourceType:s.sourceType,
  contributionDate:s.contributionDate,originalPrincipal:s.amount,currentValue:s.amount,
  taxBasisNominal:s.basisNominal,taxBasisReal:s.basisIndexed,
  taxClass:s.wrapper==='t190'?'recognized':'other',
  classificationStatus:'M5_PROVISIONAL',deathRuleId:'M5_PROVISIONAL',
  withdrawalRuleId:'M5_PROVISIONAL',feeScheduleId:'M5_EXACT_QUOTE',
  liquidityClass:'M5_TEST',economicPathId:s.economicPathId}}

function replay(x,scenario,selectedActions){
  if(!['MEMBER_DEATH','SURVIVE_TO_TERMINAL_HORIZON'].includes(scenario.kind))
    fail('explicit death or terminal branch required');
  const end=validateDate(scenario.kind==='MEMBER_DEATH'?scenario.memberDeathDate:scenario.terminalDate);
  if(end<x.baseDate)fail('outcome before baseline');
  const paths=new EconomicPathLedger(),lots=new LotLedger(paths),accounts=new Map();
  const used=new Set(x.sources.flatMap(s=>[s.id,s.economicPathId,s.sourceEventId]));
  let seq=0;
  const newid=tag=>{let id;do{id=`m5_internal:${seq++}:${tag}`}while(used.has(id));used.add(id);return id};
  const open=(parent,amount,tag,date)=>paths.open(newid(`${tag}:path`),amount,
    {parentPathId:parent,currentOwner:'member',sourceEventId:`${tag}:${date}`});
  const addLot=(template,path,amount,overrides={})=>{
    const l={...template,...overrides,id:newid('lot'),economicPathId:path,
      currentValue:amount};lots.add(l);return l.id};
  for(const s of x.sources){
    paths.open(s.economicPathId,s.amount,{currentOwner:'member',sourceEventId:s.sourceEventId});
    lots.add(coreLot(s));accounts.set(s.id,{date:x.baseDate,components:[s.id],wrapper:s.wrapper});
  }
  const sinks=[];
  const splitWithSink=(id,amount,category,eventDate)=>{
    const old=lots.get(id);
    if(!old)fail('unknown lot for partial sink');
    if(!isDecisionPositive(amount))return id;
    const left=old.currentValue-amount;
    if(!isDecisionPositive(left))fail('invalid partial sink');
    const release=lots.release(id,newid('released'),`${category}:${eventDate}`);
    const keep=open(release.id,left,category,eventDate),expense=open(release.id,amount,category,eventDate);
    paths.sink(expense.id,newid('sink'),category,eventDate,amount);
    sinks.push({category,date:eventDate,amount,sourcePathId:old.economicPathId});
    return addLot(old,keep.id,left,{originalPrincipal:old.originalPrincipal,
      taxBasisNominal:old.taxBasisNominal,taxBasisReal:old.taxBasisReal,
      contributionDate:old.contributionDate});
  };
  function advance(accountId,toDate){
    const acc=accounts.get(accountId);if(!acc)fail('unknown economic account');
    if(acc.date===toDate)return;
    const q=x.exactQuotes[accountId]?.[key(acc.date,toDate)];
    if(!q||q.provenance?.version==null||q.fromDate!==acc.date||q.toDate!==toDate)
      fail(`exact dated accrual quote missing: ${accountId} ${acc.date} ${toDate}`);
    const gross=positive(q.grossReturnFactor,'gross return factor'),
      keep=positive(q.feeRetentionFactor,'fee retention factor'),
      index=positive(q.basisIndexFactor,'basis index factor');
    if(gross===0||keep>1||index===0)fail('unsupported growth/fee/index quote');
    const opening=acc.components.reduce((n,id)=>n+lots.get(id).currentValue,0);
    const growth=opening*(gross-1);
    if(isDecisionPositive(growth)){
      const root=newid('natural_return_root');
      paths.open(root,growth,{currentOwner:'member',sourceEventId:newid(`return:${q.provenance.version}:${toDate}`)});
      const source=lots.get(acc.components[0]);
      acc.components.push(addLot(source,root,growth,{originalPrincipal:0,
        taxBasisNominal:0,taxBasisReal:0,contributionDate:toDate,sourceType:'realization_proceeds'}));
    }else if(isDecisionPositive(-growth)){
      acc.components=acc.components.map(id=>{
        const l=lots.get(id),loss=l.currentValue*(1-gross);
        return splitWithSink(id,loss,'investment_loss',toDate);
      });
    }
    if(keep<1){acc.components=acc.components.map(id=>{
      const l=lots.get(id),fee=l.currentValue*(1-keep);
      return splitWithSink(id,fee,'explicit_fee',toDate);
    })}
    if(index!==1){acc.components=acc.components.map(id=>{
      const l=lots.get(id),r=lots.release(id,newid('indexed'),`basis_index:${toDate}`);
      return addLot(l,r.id,l.currentValue,{originalPrincipal:l.originalPrincipal,
        taxBasisNominal:l.taxBasisNominal,taxBasisReal:l.taxBasisReal*index,
        contributionDate:l.contributionDate});
    })}
    acc.date=toDate;
  }
  const capacity=new Map(x.capacity.map(c=>[c.taxYear,{...c,executed:0}]));
  const actions=[];
  for(const a of [...selectedActions].sort((u,v)=>u.date.localeCompare(v.date))){
    if(scenario.kind==='MEMBER_DEATH'){
      const ordering=memberInitiatedActionOrdering({memberDeathDate:end,actionDate:a.date});
      if(!ordering.executed){actions.push({actionId:a.id,date:a.date,status:'NOT_EXECUTED_DEATH_OR_HORIZON',
        grossAmount:0,tax:0,netAmount:0,capacityUsed:0,
        eventOrdering:{relation:ordering.relation,conventionId:ordering.convention.id,
          timeResolution:ordering.convention.timeResolution,actionClass:ordering.convention.actionClass,
          productionLegalOrContractualRule:ordering.convention.productionLegalOrContractualRule}});continue}
    }else{
      if(a.date===end)fail('same-day horizon/action ordering unspecified');
      if(a.date>end){actions.push({actionId:a.id,date:a.date,status:'NOT_EXECUTED_DEATH_OR_HORIZON',
        grossAmount:0,tax:0,netAmount:0,capacityUsed:0});continue}
    }
    const acc=accounts.get(a.sourceLotId);advance(a.sourceLotId,a.date);
    const row=capacity.get(Number(a.date.slice(0,4))),remaining=row.available-row.alreadyUsed-row.executed;
    const total=acc.components.reduce((n,id)=>n+lots.get(id).currentValue,0),
      currentSourceAvailable=isDecisionPositive(total),
      basis=acc.components.reduce((n,id)=>n+(a.taxRule.basis==='indexed'?
        lots.get(id).taxBasisReal:lots.get(id).taxBasisNominal),0),
      rate=a.taxRule.rate,netFraction=currentSourceAvailable?
        1-rate*Math.max(0,1-basis/total):1;
    if(netFraction<=0)fail('tax consumes entire qualifying source');
    const gross=Math.min(a.maxGross,total,remaining/netFraction);
    if(!isDecisionPositive(gross)){actions.push({actionId:a.id,date:a.date,status:'ZERO_CAPACITY_OR_SOURCE',
      grossAmount:0,tax:0,netAmount:0,capacityUsed:0});continue}
    const share=gross/total;
    const qId=`q:${a.id}`,qComponents=[];
    let materializedGross=0,materializedTax=0,materializedNet=0;
    if(accounts.has(qId))fail('duplicate qualifying account');
    for(const oldId of [...acc.components]){
      const old=lots.get(oldId),sold=old.currentValue*share;
      if(!isDecisionPositive(sold))continue;
      const soldShare=sold/old.currentValue,leftover=old.currentValue-sold;
      const released=lots.release(oldId,newid('qualifying_release'),`qualifying:${a.id}`);
      if(isDecisionPositive(leftover)){const p=open(released.id,leftover,'source_remainder',a.date);
        const lid=addLot(old,p.id,leftover,{originalPrincipal:old.originalPrincipal*(1-soldShare),
          taxBasisNominal:old.taxBasisNominal*(1-soldShare),
          taxBasisReal:old.taxBasisReal*(1-soldShare),contributionDate:old.contributionDate});
        acc.components[acc.components.indexOf(oldId)]=lid;
      }else acc.components.splice(acc.components.indexOf(oldId),1);
      const transfer=open(released.id,sold,'qualifying_gross',a.date),rawTaxPart=sold*(1-netFraction),
        taxPart=isDecisionPositive(rawTaxPart)?rawTaxPart:0,netPart=sold-taxPart;
      if(isDecisionPositive(taxPart)){const t=open(transfer.id,taxPart,'realization_tax',a.date);
        paths.sink(t.id,newid('realization_tax_sink'),'realization_tax',a.date,taxPart);
        sinks.push({category:'realization_tax',date:a.date,amount:taxPart,sourcePathId:old.economicPathId})}
      const netPath=isDecisionPositive(taxPart)?open(transfer.id,netPart,'qualifying_net',a.date):transfer;
      const id=addLot(old,netPath.id,netPart,{wrapper:'t190',sourceType:'realization_proceeds',
        originalPrincipal:netPart,taxClass:'qualifying',contributionDate:a.date,
        taxBasisNominal:netPart*a.destinationBasis.nominalPerNet,
        taxBasisReal:netPart*a.destinationBasis.indexedPerNet});
      qComponents.push(id);materializedGross+=sold;materializedTax+=taxPart;materializedNet+=netPart;
    }
    const rawTax=gross*(1-netFraction);
    materializedGross=snapFloating(materializedGross,gross);
    materializedTax=snapFloating(materializedTax,rawTax);
    materializedNet=snapFloating(materializedNet,materializedGross-materializedTax);
    if(!isDecisionPositive(materializedGross)||!isDecisionPositive(materializedNet)||qComponents.length===0)
      fail('positive qualifying action failed to materialize');
    if(materializedNet>remaining+RECONCILIATION_EPS)fail('qualifying capacity overspent during materialization');
    const balanceAfter=acc.components.reduce((n,id)=>n+lots.get(id).currentValue,0),
      basisAfter=acc.components.reduce((n,id)=>n+(a.taxRule.basis==='indexed'?lots.get(id).taxBasisReal:lots.get(id).taxBasisNominal),0);
    row.executed+=materializedNet;
    accounts.set(qId,{date:a.date,components:qComponents,wrapper:'t190'});
    actions.push({actionId:a.id,date:a.date,status:'EXECUTED',sourceId:a.sourceLotId,
      destinationId:qId,grossAmount:materializedGross,tax:materializedTax,netAmount:materializedNet,capacityUsed:materializedNet,
      sourceBasisAtDate:basis,sourceValueAtDate:total,ruleId:row.ruleId,
      capacityBefore:remaining,capacityAfter:remaining-materializedNet,
      economicAction:{actionId:a.id,date:a.date,taxYear:Number(a.date.slice(0,4)),
        stateNodeId:`${a.id}:${a.date}:${total}:${basis}`,source:{lotId:a.sourceLotId,
          economicPathId:x.sources.find(s=>s.id===a.sourceLotId).economicPathId},
        destination:{accountId:qId,wrapper:'t190',economicPathIds:qComponents.map(id=>lots.get(id).economicPathId)},
        entryRoute:'QUALIFYING_FUNDING',grossAmount:materializedGross,tax:materializedTax,fees:0,netAmount:materializedNet,
        basisBefore:basis,basisAfter,capacityBefore:remaining,
        capacityUsed:materializedNet,capacityAfter:remaining-materializedNet,balanceBefore:total,
        balanceAfter,reasonCode:'CONTINGENT_POLICY_ELIGIBLE',
        stopCondition:'ALIVE_AND_CAPACITY_AND_CONTRACT',ruleId:row.ruleId,
        contractId:a.contractId,provenance:{taxRule:a.taxRule.version,
          capacityRule:row.legalRule.calculationVersion,destinationBasis:a.destinationBasis.version}}});
    if(Math.abs(paths.reconcile(lots).gap)>RECONCILIATION_EPS)fail('action root-to-leaf gap');
  }
  for(const id of accounts.keys())advance(id,end);
  let family=0;
  if(scenario.kind==='MEMBER_DEATH')for(const [id,acc] of accounts){
    const rule=x.deathRules[acc.wrapper];
    if(!rule?.version||!['nominal','indexed','exempt'].includes(rule.basis)||
      positive(rule.rate,'death tax rate')>1)fail('explicit death settlement rule required');
    const gross=acc.components.reduce((n,c)=>n+lots.get(c).currentValue,0);
    const basis=acc.components.reduce((n,c)=>n+(rule.basis==='indexed'?lots.get(c).taxBasisReal:
      lots.get(c).taxBasisNominal),0);
    const tax=rule.basis==='exempt'?0:rule.rate*Math.max(0,gross-basis);
    for(const c of acc.components){const l=lots.get(c),released=lots.release(c,newid('death_release'),`member_death:${end}`);
      const partTax=gross?tax*l.currentValue/gross:0,partNet=l.currentValue-partTax;
      if(isDecisionPositive(partTax)){const t=open(released.id,partTax,'death_tax',end);
        paths.sink(t.id,newid('death_tax_sink'),'death_tax',end,partTax)}
      const netPath=isDecisionPositive(partTax)?open(released.id,partNet,'heirs_net',end):released;
      paths.finalize(netPath.id,newid('final_use'),'heirs',end,partNet,
        id.startsWith('q:')?'qualifying_inheritance':'residual_inheritance',end);
    }
    family+=gross-tax;
  }else{
    // Terminal survival continues every path: this is not a fictitious death.
    for(const acc of accounts.values()){
      const rule=x.terminalContinuationRules[acc.wrapper];
      if(!rule?.version||!['nominal','indexed','exempt'].includes(rule.basis)||
        positive(rule.rate,'terminal continuation quote')>1)
        fail('explicit net terminal continuation quote required');
      const gross=acc.components.reduce((n,c)=>n+lots.get(c).currentValue,0),
        basis=acc.components.reduce((n,c)=>n+(rule.basis==='indexed'?lots.get(c).taxBasisReal:
          lots.get(c).taxBasisNominal),0);
      family+=gross-(rule.basis==='exempt'?0:rule.rate*Math.max(0,gross-basis));
    }
  }
  const reconciliation=paths.reconcile(lots);
  if(Math.abs(reconciliation.gap)>RECONCILIATION_EPS)fail('scenario root-to-leaf gap');
  if(scenario.kind==='MEMBER_DEATH'&&isDecisionPositive(reconciliation.liveTotal))fail('unsettled member path');
  const executedCapacity=[...capacity.values()].map(c=>({taxYear:c.taxYear,
    available:c.available,alreadyUsed:c.alreadyUsed,executed:c.executed,
    futureUnusedIsAsset:false}));
  return copyFreeze({scenarioId:scenario.id,kind:scenario.kind,endDate:end,
    familyValueAtEnd:family,actions,economicActions:actions.filter(a=>a.status==='EXECUTED')
      .map(a=>a.economicAction),executedCapacity,
    finalUses:paths.finalUses(),sinks:paths.sinks(),liveLots:lots.lots(),reconciliation});
}

/** Pure planned policy replay core; no shared Core ledger or annual capacity is mutated.
 * Mode authorization is handled only by the explicit wrappers below. */
function evaluateQualifyingPolicyCore(input){
  const planned=input.scenarios.map(s=>replay(input,s,input.policy.actions));
  const baseline=input.scenarios.map(s=>replay(input,s,[]));
  const scenarioMoney=(scenarios)=>scenarios.map((r,i)=>({id:r.scenarioId,
    kind:r.kind,probability:input.scenarios[i].probability,
    ...(r.kind==='MEMBER_DEATH'?{memberDeathDate:r.endDate}:{terminalDate:r.endDate}),
    familyValue:{amount:r.familyValueAtEnd,valuationDate:r.endDate,
      moneyBasis:input.valuationConvention.moneyBasis,taxStatus:'NET',ownerId:'family',
      productId:'FAMILY_AGGREGATE',sourceRootPathIds:r.reconciliation.roots.map(root=>root.rootPathId),
      currency:input.currency}}));
  const expected=evaluateClosedDistribution(scenarioMoney(planned),input.valuationConvention),
    expectedBaseline=evaluateClosedDistribution(scenarioMoney(baseline),input.valuationConvention);
  return copyFreeze({schemaVersion:'F8_M5_POLICY_REPLAY_V1',mode:input.mode,
    policyVersion:input.policy.version,planned,baseline,
    expectedNetFamilyValue:expected.expectedNetFamilyValue,
    baselineExpectedNetFamilyValue:expectedBaseline.expectedNetFamilyValue,
    delta:expected.expectedNetFamilyValue-expectedBaseline.expectedNetFamilyValue,
    capacityPlanningClaims:input.policy.actions.map(a=>({actionId:a.id,
      taxYear:Number(a.date.slice(0,4)),maxGross:a.maxGross,contingent:true})),
    status:input.mode==='PROFESSIONAL_SIMULATION_BETA'?'PROFESSIONAL_SIMULATION_BETA':'METHOD_FIXTURE_ONLY',productionReady:false});
}

/** Existing QA/synthetic entrypoint. Behavior and restrictions remain unchanged. */
export function evaluateQualifyingPolicy(raw){return evaluateQualifyingPolicyCore(normalizeQa(raw))}

/** Professional Simulation Beta authorization wrapper over the exact same M5 replay core. */
export function evaluateQualifyingPolicyProfessionalSimulationBeta(raw,authority){
  return evaluateQualifyingPolicyCore(normalizeBeta(raw,authority));
}

/**
 * Authorization-only bridge for the frozen Strategy Compiler compatibility channel.
 * It first validates the PROFESSIONAL_SIMULATION_BETA DTO/authority, then emits an
 * economically identical WORKING_QA-shaped DTO so the existing frontier builders
 * and M10 entrypoint can remain byte-for-byte unchanged. No economic datum is changed.
 */
export function buildQualifyingFrozenWorkingQaCompatibilityInput(raw,authority){
  const x=structuredClone(normalizeBeta(raw,authority));
  x.mode='WORKING_QA';
  x.provenance={...x.provenance,
    source:'LEGACY_COMPATIBILITY',
    useScope:'WORKING_QA',
    solverCompatibilityChannel:'FROZEN_WORKING_QA_ENTRYPOINT',
    originatingMode:'PROFESSIONAL_SIMULATION_BETA',
    productionVerified:false
  };
  for(const c of x.capacity){
    c.legalRule={...c.legalRule,
      status:'VERIFIED_CONDITIONAL',
      useScope:'WORKING_QA',
      originatingVerificationStatus:'SIMULATION_ASSUMPTION'
    };
  }
  return copyFreeze(x);
}
