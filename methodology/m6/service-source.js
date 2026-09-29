import {EconomicPathLedger,LotLedger} from '../../F8_CORE/src/ledgers.js';
import {MethodologyBlocked} from '../m1/valuation.js';

const EPS=1e-8;
const fail=m=>{throw new MethodologyBlocked(m)};
const copyFreeze=x=>{const v=structuredClone(x);const deep=o=>{if(o&&typeof o==='object'&&!Object.isFrozen(o)){Object.values(o).forEach(deep);Object.freeze(o)}return o};return deep(v)};
const money=(v,label)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<0)fail(`${label} must be finite nonnegative`);return v};
const date=s=>{if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s)||
  !Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)
  fail('exact service date required');return s};

export function normalizeServiceState(raw){
  const x=structuredClone(raw);
  if(x?.schemaVersion!=='F8_SERVICE_STATE_V1'||!['FLEXIBLE_SERVICE_MODE','FIXED_SERVICE_MODE'].includes(x.mode)||
    !x.personId||!Array.isArray(x.periods)||!Array.isArray(x.contractOptions)||
    !x.periods.length)fail('dated service state required');
  for(const k of ['memberDeathAge','spouseDeathAge','deathSlider'])if(Object.hasOwn(x,k))
    fail('scenario slider forbidden in service policy');
  const dates=new Set();
  for(const p of x.periods){date(p.date);if(dates.has(p.date))fail('duplicate service period');
    dates.add(p.date);money(p.requiredNet,'required member service');
    money(p.requiredSpouseNet,'required spouse service')}
  const optionIds=new Set(),receiptPaths=new Set();
  for(const option of x.contractOptions){
    if(!option.id||optionIds.has(option.id)||!option.contractId||
      !Array.isArray(option.receipts)||!option.provenance?.version||
      !['pension_fund','t190_annuity','capital_withdrawal','other_eligible_income'].includes(option.sourceType))
      fail('normalized contract option required');
    optionIds.add(option.id);money(option.maxUnits,'max service units');
    if(option.maxUnits<=0)fail('omit unavailable service option');
    if(typeof option.continuous!=='boolean')fail('contract divisibility required');
    const seen=new Set();
    for(const r of option.receipts){date(r.date);
      if(seen.has(r.date)||!dates.has(r.date)||!r.economicPathId||
        receiptPaths.has(r.economicPathId)||!r.sourceEventId)
        fail('dated unique receipt provenance required');
      seen.add(r.date);receiptPaths.add(r.economicPathId);
      for(const k of ['grossPerUnit','taxPerUnit','niHealthPerUnit','netPerUnit','spouseNetPerUnit'])
        money(r[k],k);
      if(Math.abs(r.grossPerUnit-r.taxPerUnit-r.niHealthPerUnit-r.netPerUnit)>EPS)
        fail('receipt gross-to-net reconciliation');
      if(r.spouseNetPerUnit>r.netPerUnit+EPS)
        fail('spouse-covered service cannot exceed the same net receipt');
    }
  }
  if(x.mode==='FIXED_SERVICE_MODE'){
    if(x.lockEvent?.type!=='SERVICE_SOURCE_LOCKED'||!x.lockEvent.date||
      !optionIds.has(x.lockEvent.contractOptionId))fail('irreversible lock event required');
    date(x.lockEvent.date);
    money(x.lockEvent.units,'locked service units');
    const locked=x.contractOptions.find(o=>o.id===x.lockEvent.contractOptionId);
    if(x.lockEvent.units<=0||x.lockEvent.units>locked.maxUnits+EPS||
       !locked.continuous&&Math.abs(x.lockEvent.units-locked.maxUnits)>EPS)
      fail('locked service quantity must be a valid executed contract');
  }else if(x.lockEvent)fail('flexible state cannot carry an irreversible lock');
  return copyFreeze(x);
}

/** This is feasibility evaluation, not a standalone winner or a service reward.
 * Every receipt is path-backed; required service is a sink and excess is a live cash lot. */
export function evaluateServiceAllocation(rawState,rawChoices){
  const state=normalizeServiceState(rawState),choices=structuredClone(rawChoices);
  if(!Array.isArray(choices))fail('explicit service choices required');
  const chosen=new Map();
  for(const choice of choices){
    const o=state.contractOptions.find(x=>x.id===choice.optionId);
    if(!o||chosen.has(o.id)||money(choice.units,'service units')>o.maxUnits+EPS||
      !o.continuous&&choice.units!==0&&Math.abs(choice.units-o.maxUnits)>EPS)
      fail('illegal service contract selection');
    chosen.set(o.id,choice.units);
  }
  if(state.mode==='FIXED_SERVICE_MODE'){
    if(Math.abs((chosen.get(state.lockEvent.contractOptionId)||0)-state.lockEvent.units)>EPS)
      fail('fixed service must retain locked source and quantity');
    for(const [id,units] of chosen)
      if(units>EPS&&id!==state.lockEvent.contractOptionId)
        fail('fixed service cannot reverse source after lock');
  }
  const paths=new EconomicPathLedger(),lots=new LotLedger(paths),used=new Set();
  const receiptIds=[],cashSurplusLots=[],consumptionUses=[],periods=[];
  let serial=0;
  const internal=tag=>{let id;do{id=`m6_internal:${serial++}:${tag}`}while(used.has(id));used.add(id);return id};
  for(const o of state.contractOptions)for(const r of o.receipts){
    if(used.has(r.economicPathId)||used.has(r.sourceEventId))fail('receipt origin collides');
    used.add(r.economicPathId);used.add(r.sourceEventId)}
  for(const p of state.periods){
    let memberNet=0,spouseNet=0;
    const receipts=[];
    for(const option of state.contractOptions){
      const units=chosen.get(option.id)||0;
      if(units<=EPS)continue;
      const r=option.receipts.find(row=>row.date===p.date);
      if(!r)continue;
      const amount=r.netPerUnit*units,gross=r.grossPerUnit*units,
        tax=r.taxPerUnit*units,niHealth=r.niHealthPerUnit*units;
      if(gross<=EPS)continue;
      const receiptPath=paths.open(r.economicPathId,gross,{currentOwner:'member',
        sourceEventId:r.sourceEventId});
      receiptIds.push(receiptPath.id);
      for(const [category,cost] of [['receipt_tax',tax],['receipt_ni_health',niHealth]])
        if(cost>EPS){const path=paths.open(internal(category),cost,
          {parentPathId:receiptPath.id,currentOwner:'member',sourceEventId:`${category}:${p.date}`});
          paths.sink(path.id,internal(`${category}:sink`),category,p.date,cost)}
      const servicePath=tax>EPS||niHealth>EPS?paths.open(internal('net_receipt'),amount,
        {parentPathId:receiptPath.id,currentOwner:'member',sourceEventId:`net_receipt:${p.date}`}):receiptPath;
      memberNet+=amount;spouseNet+=r.spouseNetPerUnit*units;
      receipts.push({optionId:option.id,receiptPathId:receiptPath.id,
        servicePathId:servicePath.id,gross,tax,niHealth,net:amount,units});
    }
    const requiredHousehold=p.requiredNet+p.requiredSpouseNet;
    if(memberNet+EPS<requiredHousehold||spouseNet+EPS<p.requiredSpouseNet)
      fail('required net service/protection is a hard constraint');
    const fraction=memberNet?Math.min(1,requiredHousehold/memberNet):0;
    for(const r of receipts){
      const consumed=r.net*fraction,excess=r.net-consumed;
      if(consumed>EPS){const path=excess>EPS?paths.open(internal('consumed'),consumed,
        {parentPathId:r.servicePathId,currentOwner:'member',sourceEventId:`service:${p.date}`}):
        paths.get(r.servicePathId);
        paths.sink(path.id,internal('required_service_sink'),'required_consumption',p.date,consumed);
        consumptionUses.push({date:p.date,pathId:path.id,amount:consumed})}
      if(excess>EPS){const path=consumed>EPS?paths.open(internal('surplus'),excess,
        {parentPathId:r.servicePathId,currentOwner:'member',sourceEventId:`surplus:${p.date}`}):
        paths.get(r.servicePathId);
        const id=internal('cash_lot');
        lots.add({id,owner:'member',wrapper:'cash',providerId:'M6_RECEIPT',
          sourceType:'annuity_reinvestment',contributionDate:p.date,
          originalPrincipal:excess,currentValue:excess,
          taxBasisNominal:excess,taxBasisReal:excess,taxClass:'recognized',
          classificationStatus:'M6_METHOD_ONLY',deathRuleId:'M6_UNVERIFIED',
          withdrawalRuleId:'M6_UNVERIFIED',feeScheduleId:'M6_EXPLICIT',
          liquidityClass:'M6_SURPLUS',economicPathId:path.id});
        cashSurplusLots.push({lotId:id,economicPathId:path.id,
          amount:excess,availabilityDate:p.date,ownerId:state.personId})}
    }
    periods.push({date:p.date,requiredNet:p.requiredNet,serviceProvidedNet:memberNet,
      spouseRequiredNet:p.requiredSpouseNet,spouseProvidedNet:spouseNet,
      consumed:requiredHousehold,surplusCash:memberNet-requiredHousehold,
      receipts});
  }
  const reconciliation=paths.reconcile(lots);
  if(Math.abs(reconciliation.gap)>EPS||
    Math.abs(reconciliation.liveTotal-cashSurplusLots.reduce((n,x)=>n+x.amount,0))>EPS)
    fail('service receipt root-to-leaf reconciliation');
  return copyFreeze({schemaVersion:'F8_SERVICE_FEASIBILITY_V1',mode:state.mode,
    selectedServiceSources:choices,periods,receiptPathIds:receiptIds,
    consumptionUses,cashSurplusLots,reconciliation,
    globalOptimal:false,serviceSatisfied:true});
}

/** A lock is an explicit event; fixed service cannot be silently unlocked. */
export function lockServiceSource(rawState,contractOptionId,lockDate,units){
  const s=normalizeServiceState(rawState);
  if(s.mode!=='FLEXIBLE_SERVICE_MODE'||
    !s.contractOptions.some(o=>o.id===contractOptionId))fail('service already fixed or option missing');
  date(lockDate);money(units,'locked service units');
  return normalizeServiceState({...s,mode:'FIXED_SERVICE_MODE',
    lockEvent:{type:'SERVICE_SOURCE_LOCKED',date:lockDate,contractOptionId,units}});
}
