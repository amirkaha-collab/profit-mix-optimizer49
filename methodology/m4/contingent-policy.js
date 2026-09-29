import {MethodologyBlocked} from '../m1/valuation.js';

const fail=m=>{throw new MethodologyBlocked(m)};
const frozen=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(frozen);Object.freeze(x)}return x};
const date=s=>{if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s)||
  !Number.isFinite(Date.parse(`${s}T00:00:00Z`))||
  new Date(`${s}T00:00:00Z`).toISOString().slice(0,10)!==s)fail('dated policy required');return s};
const amount=n=>{if(typeof n!=='number'||!Number.isFinite(n)||n<0)fail('nonnegative finite amount required');return n};

/** The plan is fixed ex ante. Its dated action rules see only current observable state. */
export function normalizeContingentPolicy(raw) {
  const p=structuredClone(raw);
  if(p?.schemaVersion!=='F8_CONTINGENT_POLICY_V1'||!p.version||!p.personId||
     !Array.isArray(p.actions))fail('versioned dated policy required');
  for(const forbidden of ['memberDeathDate','spouseDeathDate','memberDeathAge',
    'spouseDeathAge','deathSlider','scenarioId'])if(Object.hasOwn(p,forbidden))
    fail('future outcome cannot enter policy input');
  const ids=new Set();
  for(const a of p.actions){
    if(!a.id||ids.has(a.id)||!a.sourceLotId||!a.contractId||
       !['QUALIFYING_DEPOSIT','ROTATION','OPTIONAL_ANNUITIZATION','HOLD'].includes(a.type))
      fail('unique supported action required');
    ids.add(a.id);date(a.date);amount(a.maxGross);
    if(a.type!=='HOLD' && a.maxGross===0)fail('omit zero policy action');
    for(const forbidden of ['memberDeathDate','spouseDeathDate','futureDeath','scenarioId'])
      if(Object.hasOwn(a,forbidden))fail('action cannot branch on future outcome');
  }
  return frozen(p);
}

/** Scenario replay evaluates the same rule on the state observed at each date.
 * Death dates are replay events, never inputs to normalizeContingentPolicy(). */
export function replayContingentPolicy(rawPolicy,rawScenario){
  const policy=normalizeContingentPolicy(rawPolicy),scenario=structuredClone(rawScenario);
  if(scenario?.schemaVersion!=='F8_SCENARIO_REPLAY_V1'||
     !Array.isArray(scenario.observableStates)||!scenario.id)fail('scenario replay required');
  if(scenario.kind==='MEMBER_DEATH')date(scenario.memberDeathDate);
  else if(scenario.kind==='SURVIVE_TO_TERMINAL_HORIZON'){
    date(scenario.terminalDate);
    if(scenario.memberDeathDate!==undefined&&scenario.memberDeathDate!==null)
      fail('terminal survival is not a member death');
  } else fail('explicit replay branch required');
  if(scenario.spouseDeathDate!==null&&scenario.spouseDeathDate!==undefined)
    date(scenario.spouseDeathDate);
  const states=new Map();
  for(const state of scenario.observableStates){
    date(state.date);
    if(states.has(state.date)||state.personId!==policy.personId||
       typeof state.contractActive!=='boolean'||
       typeof state.spouseAlive!=='boolean'||!state.sourceBalances||
       !state.capacityByTaxYear)fail('dated observable state required');
    states.set(state.date,state);
  }
  let executedCapacity=0;
  const actions=policy.actions.map(a=>{
    if(scenario.kind==='SURVIVE_TO_TERMINAL_HORIZON'&&a.date>scenario.terminalDate)
      fail('action outside terminal replay horizon');
    if(a.date===scenario.memberDeathDate||a.date===scenario.spouseDeathDate)
      fail('same-day death and action order needs explicit contract ordering');
    const alive=scenario.kind==='SURVIVE_TO_TERMINAL_HORIZON'||a.date<scenario.memberDeathDate;
    const spouseAlive=scenario.spouseDeathDate==null||a.date<scenario.spouseDeathDate;
    if(!alive)return {actionId:a.id,date:a.date,type:a.type,sourceLotId:a.sourceLotId,
      executedGross:0,observedMemberAlive:false,observedSpouseAlive:spouseAlive,
      capacityExecuted:0,reason:'MEMBER_DECEASED'};
    const state=states.get(a.date);
    if(!state)fail('observable state missing at planned action date');
    if(state.spouseAlive!==spouseAlive)fail('observable spouse state contradicts history');
    const source=amount(state.sourceBalances[a.sourceLotId]??0);
    const capacity=amount(state.capacityByTaxYear[a.date.slice(0,4)]??0);
    const legal=state.legalConditionSatisfied===true;
    const held=a.type==='HOLD';
    const eligible=alive&&state.contractActive&&legal&&source>0&&
      (a.type!=='QUALIFYING_DEPOSIT'||capacity>0);
    const used=held||!eligible?0:Math.min(a.maxGross,source,
      a.type==='QUALIFYING_DEPOSIT'?capacity:Infinity);
    if(a.type==='QUALIFYING_DEPOSIT')executedCapacity+=used;
    return {actionId:a.id,date:a.date,type:a.type,sourceLotId:a.sourceLotId,
      executedGross:used,observedMemberAlive:alive,observedSpouseAlive:spouseAlive,
      capacityExecuted:a.type==='QUALIFYING_DEPOSIT'?used:0,
      reason:held?'HOLD':!alive?'MEMBER_DECEASED':!state.contractActive?'CONTRACT_INACTIVE':
        !legal?'LEGAL_UNAVAILABLE':source<=0?'SOURCE_UNAVAILABLE':
        a.type==='QUALIFYING_DEPOSIT'&&capacity<=0?'CAPACITY_UNAVAILABLE':'OBSERVED_ELIGIBLE'};
  });
  return frozen({schemaVersion:'F8_CONTINGENT_REPLAY_V1',scenarioId:scenario.id,
    policyVersion:policy.version,actions,executedCapacity,
    futureUnusedCapacityNotAsset:true});
}
