import {EconomicPathLedger,LotLedger} from '../../F8_CORE/src/ledgers.js';
import {allocateUnifiedResidual} from '../m3/residual-allocator.js';
import {MethodologyBlocked} from '../m1/valuation.js';
const fail=m=>{throw new MethodologyBlocked(m)};
const freeze=x=>{const y=structuredClone(x);const f=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(f);Object.freeze(v)}return v};return f(y)};
const num=(n,s)=>{if(typeof n!=='number'||!Number.isFinite(n)||n<0)fail(`${s} must be nonnegative`);return n};
const date=s=>{if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s)||
  !Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)
  fail('exact date required');return s};

/** An entitlement replay, not an optional-annuitization winner. If a receipt is
 * observed alive, its surplus uses the exact same M3 residual allocator. */
export function replayContingentReceipt(raw){
  const x=structuredClone(raw);
  if(x?.schemaVersion!=='F8_CONTINGENT_RECEIPT_V1'||!x.ownerId||!x.currency||
    !x.receipt||!Array.isArray(x.scenarios)||!x.scenarios.length||
    !x.residualQuote)fail('dated entitlement and residual quotes required');
  for(const k of ['memberDeathAge','spouseDeathAge','deathSlider'])
    if(Object.hasOwn(x,k))fail('slider excluded from optimizer receipt state');
  const r=x.receipt;date(r.date);if(!r.rightId||!r.contractId||!r.ruleId||
    !r.provenance?.version||!r.sourceEventId||!r.economicPathId)
    fail('contractual right provenance required');
  for(const k of ['gross','tax','niHealth','requiredConsumption'])num(r[k],k);
  if(r.tax+r.niHealth+r.requiredConsumption>r.gross+1e-8)
    fail('receipt cannot fund required consumption');
  const surplus=r.gross-r.tax-r.niHealth-r.requiredConsumption;
  const quote=x.residualQuote;
  if(quote.schemaVersion!=='F8_UNIFIED_RESIDUAL_V1'||quote.asOfDate!==r.date||
    quote.ownerId!==x.ownerId||quote.currency!==x.currency||
    quote.sources?.length!==1||quote.sources[0].amount!==surplus||
    quote.sources[0].economicPathId!==`${r.economicPathId}:surplus`)
    fail('receipt surplus must use same dated residual source');
  const ids=new Set();
  return freeze({schemaVersion:'F8_CONTINGENT_RECEIPT_REPLAY_V1',rightId:r.rightId,
    scenarios:x.scenarios.map(s=>{
      if(!s.id||ids.has(s.id)||!['MEMBER_DEATH','SURVIVE_TO_TERMINAL_HORIZON'].includes(s.kind))
        fail('unique explicit mortality branch required');ids.add(s.id);
      const end=date(s.kind==='MEMBER_DEATH'?s.memberDeathDate:s.terminalDate);
      if(end===r.date)fail('same-day receipt/death ordering requires contract evidence');
      if(end<r.date)return {scenarioId:s.id,status:'NO_FUTURE_RECEIPT',
        residualPlan:null,economicActions:[],reconciliation:null};
      const paths=new EconomicPathLedger(),lots=new LotLedger(paths);
      const root=paths.open(r.economicPathId,r.gross,
        {currentOwner:'member',sourceEventId:r.sourceEventId});
      let serial=0;const next=tag=>`${r.economicPathId}:m8:${serial++}:${tag}`;
      for(const [category,amount] of [['tax',r.tax],['ni_health',r.niHealth],
        ['required_consumption',r.requiredConsumption]])if(amount>0){
          const part=paths.open(next(category),amount,{parentPathId:root.id,currentOwner:'member',
            sourceEventId:`${r.rightId}:${category}:${r.date}`});
          paths.sink(part.id,next(`${category}:sink`),category,r.date,amount);
        }
      let plan=null,actions=[];
      if(surplus>1e-9){
        const p=paths.open(quote.sources[0].economicPathId,surplus,
          {parentPathId:root.id,currentOwner:'member',sourceEventId:`${r.rightId}:surplus:${r.date}`});
        plan=allocateUnifiedResidual(quote);
        actions=plan.allocations.map(a=>{
          const path=paths.open(next('allocated'),a.amount,{parentPathId:p.id,currentOwner:'member',
            sourceEventId:`${r.rightId}:residual:${r.date}`});
          lots.add({id:next('lot'),owner:'member',wrapper:'cash',providerId:'M8_METHOD',
            sourceType:'annuity_reinvestment',contributionDate:r.date,originalPrincipal:a.amount,
            currentValue:a.amount,taxBasisNominal:a.amount,taxBasisReal:a.amount,
            taxClass:'recognized',classificationStatus:'M8_PROVISIONAL',
            deathRuleId:'M8_PROVISIONAL',withdrawalRuleId:'M8_PROVISIONAL',
            feeScheduleId:'M8_QUOTE',liquidityClass:'M8_METHOD',economicPathId:path.id});
          return {date:r.date,rightId:r.rightId,sourcePathId:p.id,destinationPathId:path.id,
            destinationId:a.destinationId,amount:a.amount,netFamilyValueQuote:a.netFamilyValue};
        });
      }
      const reconciliation=paths.reconcile(lots);
      if(Math.abs(reconciliation.gap)>1e-8||Math.abs(reconciliation.liveTotal-surplus)>1e-8)
        fail('receipt economic path reconciliation');
      return {scenarioId:s.id,status:'RECEIPT_EXECUTED',residualPlan:plan,
        economicActions:actions,reconciliation};
    }),globalOptimal:false,annuitizationDecisionCertified:false});
}
