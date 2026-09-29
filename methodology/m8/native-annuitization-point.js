import {DECISION_EPS} from '../shared/numerical-contract.js';
import {EconomicPathLedger,RightsLedger} from '../../F8_CORE/src/ledgers.js';
import {validateContinuationValueResult} from '../../F8_CORE/src/continuation.js';
import {evaluateClosedDistribution,MethodologyBlocked} from '../m1/valuation.js';
import {evaluateQualifyingPolicyProfessionalSimulationBeta} from '../m5/qualifying-replay.js';
import {enumerateContractMenu} from '../m7/contract-options.js';
import {createJointMortality} from '../m9/joint-mortality.js';
import {replayAnnuitizationReceiptPipelineProfessionalSimulationBeta} from './receipt-pipeline.js';

const MODE='PROFESSIONAL_SIMULATION_BETA',EPS=1e-8;
const fail=m=>{throw new MethodologyBlocked(m)};
const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v)}return v};
const copyFreeze=v=>freeze(structuredClone(v));
const num=(v,label)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<0)fail(`${label} must be nonnegative finite`);return v};
const pos=(v,label)=>{num(v,label);if(v<=0)fail(`${label} must be positive`);return v};
const iso=s=>{if(typeof s!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)||
  !Number.isFinite(Date.parse(`${s}T00:00:00Z`))||new Date(`${s}T00:00:00Z`).toISOString().slice(0,10)!==s)
  fail('exact ISO date required');return s};
const forbiddenSlider=x=>{for(const k of ['memberDeathAge','spouseDeathAge','deathSlider','disabilityAge'])if(Object.hasOwn(x,k))fail('scenario slider cannot select/resize q or contract')};
const key=(a,b)=>`${a}|${b}`;
const memberEnd=b=>b.member.kind==='DEATH'?b.member.deathDate:b.member.terminalDate;
const spouseEnd=b=>b.spouse.kind==='DEATH'?b.spouse.deathDate:b.spouse.terminalDate;
const memberScenario=m=>m.kind==='DEATH'?{id:m.id,kind:'MEMBER_DEATH',memberDeathDate:m.deathDate,probability:m.probability}:{id:m.id,kind:'SURVIVE_TO_TERMINAL_HORIZON',terminalDate:m.terminalDate,probability:m.probability};
const provenanceOk=(p,hash)=>p?.verificationStatus==='SIMULATION_ASSUMPTION'&&p.productionVerified===false&&p.assumptionPackHash===hash&&!!p.version&&!!p.sourceReference;

function betaAuthority(input){return {schemaVersion:'F8_M5_BETA_AUTHORITY_V1',simulationAuthorized:true,productionVerified:false,assumptionPackHash:input.assumptionPackHash,caseId:input.caseId}}
function betaProvenance(input,version){return {version,simulationMode:MODE,assumptionPackHash:input.assumptionPackHash,productionVerified:false}}

function validateAdapter(adapter,schema,input,label,method=null){
  if(!adapter||adapter.schemaVersion!==schema||adapter.mode!==MODE||adapter.simulationAuthorized!==true||adapter.productionVerified!==false||
    adapter.assumptionPackHash!==input.assumptionPackHash||!adapter.version||!provenanceOk(adapter.provenance,input.assumptionPackHash)||
    method&&typeof adapter[method]!=='function')fail(`authorized ${label} adapter required`);
  return adapter;
}

function validateSourceState(s,input){
  if(!s?.id||!s.economicPathId||!s.sourceEventId||s.ownerId!==input.ownerId||s.currency!==input.currency||
    !['cash','savings_policy','t190'].includes(s.wrapper)||!s.stateDate||!s.contributionDate||!s.availabilityDate||
    !['fresh_contribution','annuity_reinvestment','transfer','realization_proceeds'].includes(s.sourceType)||
    !s.deathRule?.version||!s.terminalContinuationRule?.version||!s.exactQuotes||typeof s.exactQuotes!=='object')
    fail('complete canonical q source state required');
  iso(s.stateDate);iso(s.contributionDate);iso(s.availabilityDate);num(s.amount,'source amount');num(s.basisNominal,'source nominal basis');num(s.basisIndexed,'source indexed basis');
  for(const r of [s.deathRule,s.terminalContinuationRule]){if(!['nominal','indexed','exempt'].includes(r.basis)||num(r.rate,'source settlement rate')>1)fail('explicit source death/terminal treatment required')}
  return s;
}

function exactSourceQuote(s,from,to){
  const q=s.exactQuotes[key(from,to)];if(!q||q.fromDate!==from||q.toDate!==to||!q.provenance?.version)fail(`exact q source state quote missing: ${from} ${to}`);
  pos(q.grossReturnFactor,'source gross return factor');const f=num(q.feeRetentionFactor,'source fee retention factor');if(f>1)fail('source fee retention factor exceeds one');pos(q.basisIndexFactor,'source basis index factor');return q;
}

function sourceReplayInput(input,scenario){
  const s=input.sourceState,end=scenario.kind==='MEMBER_DEATH'?scenario.memberDeathDate:scenario.terminalDate;
  const rows=[{...scenario,probability:1}];
  if(scenario.kind==='MEMBER_DEATH'){
    const support=input.memberScenarios.find(x=>x.kind==='SURVIVE_TO_TERMINAL_HORIZON'&&x.terminalDate>end);
    if(!support)fail('terminal support branch required for source replay');rows.push({...support,id:`${support.id}:support:${scenario.id}`,probability:0});
  }
  const exact={[s.id]:{}};for(const row of rows){const e=row.kind==='MEMBER_DEATH'?row.memberDeathDate:row.terminalDate;exact[s.id][key(s.stateDate,e)]=structuredClone(exactSourceQuote(s,s.stateDate,e))}
  return {schemaVersion:'F8_M5_QUALIFYING_REPLAY_V1',mode:MODE,personId:input.ownerId,currency:input.currency,baseDate:s.stateDate,
    sources:[{id:s.id,economicPathId:s.economicPathId,ownerId:input.ownerId,wrapper:s.wrapper,stateDate:s.stateDate,contributionDate:s.contributionDate,
      availabilityDate:s.availabilityDate,sourceEventId:s.sourceEventId,currency:input.currency,sourceType:s.sourceType,amount:s.amount,basisNominal:s.basisNominal,basisIndexed:s.basisIndexed}],
    capacity:[],scenarios:rows,exactQuotes:exact,deathRules:{[s.wrapper]:structuredClone(s.deathRule)},terminalContinuationRules:{[s.wrapper]:structuredClone(s.terminalContinuationRule)},
    valuationConvention:structuredClone(input.valuationConvention),policy:{schemaVersion:'F8_CONTINGENT_POLICY_V1',version:`QR2_SOURCE:${input.caseId}`,personId:input.ownerId,actions:[]},
    provenance:betaProvenance(input,`QR2_SOURCE_REPLAY:${input.provenance.version}`)};
}

function replaySource(input,scenario){return evaluateQualifyingPolicyProfessionalSimulationBeta(sourceReplayInput(input,scenario),betaAuthority(input)).planned[0]}

function sourceStateAtCommencement(input,commencement){
  const row=replaySource(input,{id:'qr2:commencement-state',kind:'SURVIVE_TO_TERMINAL_HORIZON',terminalDate:commencement,probability:1});
  const value=row.liveLots.reduce((n,l)=>n+l.currentValue,0),basisNominal=row.liveLots.reduce((n,l)=>n+l.taxBasisNominal,0),basisIndexed=row.liveLots.reduce((n,l)=>n+l.taxBasisReal,0);
  if(value<=DECISION_EPS)fail('q source has no economic value at commencement');
  return copyFreeze({date:commencement,value,basisNominal,basisIndexed,liveLots:row.liveLots,sinks:row.sinks,reconciliation:row.reconciliation});
}

function validateM7Option(input){
  const menu=structuredClone(input.m7ContractMenu);forbiddenSlider(menu);
  const e=enumerateContractMenu(menu),option=e.candidates.find(x=>x.id===input.contractOptionId);
  if(!option)fail('explicit contract option is not M7-feasible');return option;
}

function validatePaymentSemantics(p,input,option){
  if(p?.schemaVersion!=='F8_M8_BETA_Q_PAYMENT_SEMANTICS_V1'||p.mode!==MODE||p.simulationAuthorized!==true||p.productionVerified!==false||
    p.assumptionPackHash!==input.assumptionPackHash||p.contractOptionId!==option.id||p.annuityFactorId!==option.annuityFactorId||
    !provenanceOk(p.provenance,input.assumptionPackHash)||!Array.isArray(p.paymentDates)||!p.paymentDates.length||
    !Array.isArray(p.guaranteePaymentDates)||!['OPTION_SURVIVOR_PERCENT_OF_MEMBER_PAYMENT'].includes(p.survivorMode)||
    !['FULL_MEMBER_PAYMENT'].includes(p.guaranteeMode)||!['heirs','NONE'].includes(p.guaranteeRecipientIfSpousePredeceased)||
    !['heirs','NONE'].includes(p.guaranteeRecipientAfterSpouseDeath))fail('complete Beta q contractual payment semantics required');
  pos(p.annuityFactor,'annuity factor');
  const seen=new Set();for(const d of p.paymentDates){iso(d);if(d<option.commencementDate||seen.has(d))fail('q payment dates invalid or duplicated');seen.add(d)}
  p.paymentDates.sort();const g=new Set();for(const d of p.guaranteePaymentDates){iso(d);if(!seen.has(d)||g.has(d))fail('guarantee payment date must be a unique contract payment date');g.add(d)}
  if(g.size!==option.guaranteeMonths)fail('guarantee payment dates must exactly match M7 guarantee count');
  return p;
}

function validateReceiptTreatment(t,input,paymentDates){
  if(t?.schemaVersion!=='F8_M8_BETA_Q_RECEIPT_TREATMENT_V1'||t.mode!==MODE||t.simulationAuthorized!==true||t.productionVerified!==false||
    t.assumptionPackHash!==input.assumptionPackHash||!provenanceOk(t.provenance,input.assumptionPackHash)||!Array.isArray(t.rows))
    fail('explicit Beta q receipt treatment required');
  const map=new Map();for(const r of t.rows){iso(r.date);if(map.has(r.date)||!paymentDates.includes(r.date)||!provenanceOk(r.provenance,input.assumptionPackHash))fail('dated receipt treatment provenance required');
    for(const f of ['taxFractionOfGross','niHealthFractionOfGross']){num(r[f],f);if(r[f]>1)fail(`${f} exceeds one`)}num(r.requiredConsumption,'required receipt service');if(r.taxFractionOfGross+r.niHealthFractionOfGross>1+EPS)fail('receipt deductions exceed gross before service');map.set(r.date,r)}
  for(const d of paymentDates)if(!map.has(d))fail(`receipt treatment missing for ${d}`);return map;
}

function validateReceiptStateTemplate(m,label,input){
  if(!m?.wrapper||!['cash','savings_policy','t190'].includes(m.wrapper)||!m.provenance?.version||!m.deathRule?.version||!m.terminalContinuationRule?.version||
    !m.intervalQuotes||typeof m.intervalQuotes!=='object')fail(`complete ${label} receipt state template required`);
  for(const f of ['basisNominalPerUnit','basisIndexedPerUnit'])num(m[f],`${label} ${f}`);
  for(const r of [m.deathRule,m.terminalContinuationRule]){if(!['nominal','indexed','exempt'].includes(r.basis)||num(r.rate,`${label} settlement rate`)>1)fail(`${label} settlement rule invalid`)}
  return m;
}
function receiptInterval(t,from,to){const q=t.intervalQuotes[key(from,to)];if(!q||q.fromDate!==from||q.toDate!==to||!q.provenance?.version)fail(`receipt state interval missing: ${from} ${to}`);return structuredClone(q)}
function buildQr1StateModel(template,receipts,memberScenarios){
  const intervals={};for(const r of receipts){intervals[r.id]={};for(const s of memberScenarios){const end=s.kind==='MEMBER_DEATH'?s.memberDeathDate:s.terminalDate;if(end>r.date)intervals[r.id][s.id]=[receiptInterval(template,r.date,end)]}}
  return {wrapper:template.wrapper,basisNominalPerUnit:template.basisNominalPerUnit,basisIndexedPerUnit:template.basisIndexedPerUnit,provenance:structuredClone(template.provenance),deathRule:structuredClone(template.deathRule),terminalContinuationRule:structuredClone(template.terminalContinuationRule),intervalsByReceiptScenario:intervals};
}

function qReceiptPolicy(input,receipt){
  const p=input.receiptQualifyingPolicyByDate?.[receipt.date];if(!p||p.selected!==true)return null;
  if(!p.actionId||!p.contractId||!p.taxRule||!p.destinationBasis)fail('complete frozen receipt-funded Q policy required');
  num(p.maxGross,'receipt-funded Q maxGross');return {...structuredClone(p),actionId:`${p.actionId}:${receipt.id}`};
}

function m5ReceiptPreflightInput({input,receipt,scenario,surplus,policy,capacityRows,cashModel,qualifyingModel}){
  const sourceId=`qr2:receipt-preflight:${receipt.id}:${scenario.id}`,sourcePath=`qr2:receipt-preflight:path:${receipt.id}:${scenario.id}`,
    action=policy?{id:policy.actionId,type:'QUALIFYING_DEPOSIT',date:receipt.date,sourceLotId:sourceId,contractId:policy.contractId,maxGross:policy.maxGross,taxRule:structuredClone(policy.taxRule),destinationBasis:structuredClone(policy.destinationBasis)}:null;
  const rows=[{...scenario,probability:1}];if(scenario.kind==='MEMBER_DEATH'){
    const support=input.memberScenarios.find(x=>x.kind==='SURVIVE_TO_TERMINAL_HORIZON'&&x.terminalDate>scenario.memberDeathDate);if(!support)fail('terminal support required for receipt Q preflight');rows.push({...support,id:`${support.id}:support:${scenario.id}`,probability:0});
  }
  const exact={[sourceId]:{}};for(const row of rows){const sid=row.id.includes(':support:')?row.id.split(':support:')[0]:row.id,end=row.kind==='MEMBER_DEATH'?row.memberDeathDate:row.terminalDate;exact[sourceId][key(receipt.date,end)]=receiptInterval(cashModel,receipt.date,end)}
  if(action){const qid=`q:${action.id}`;exact[qid]={};for(const row of rows){const sid=row.id.includes(':support:')?row.id.split(':support:')[0]:row.id,end=row.kind==='MEMBER_DEATH'?row.memberDeathDate:row.terminalDate;exact[qid][key(receipt.date,end)]=receiptInterval(qualifyingModel,receipt.date,end)}}
  const deathRules={[cashModel.wrapper]:structuredClone(cashModel.deathRule)},terminalContinuationRules={[cashModel.wrapper]:structuredClone(cashModel.terminalContinuationRule)};
  if(action){deathRules[qualifyingModel.wrapper]=structuredClone(qualifyingModel.deathRule);terminalContinuationRules[qualifyingModel.wrapper]=structuredClone(qualifyingModel.terminalContinuationRule)}
  return {schemaVersion:'F8_M5_QUALIFYING_REPLAY_V1',mode:MODE,personId:input.ownerId,currency:input.currency,baseDate:receipt.date,sources:[{id:sourceId,economicPathId:sourcePath,ownerId:input.ownerId,wrapper:cashModel.wrapper,stateDate:receipt.date,contributionDate:receipt.date,availabilityDate:receipt.date,sourceEventId:`${receipt.sourceEventId}:preflight`,currency:input.currency,sourceType:'annuity_reinvestment',amount:surplus,basisNominal:surplus*cashModel.basisNominalPerUnit,basisIndexed:surplus*cashModel.basisIndexedPerUnit}],capacity:structuredClone(capacityRows),scenarios:rows,exactQuotes:exact,deathRules,terminalContinuationRules,valuationConvention:structuredClone(input.valuationConvention),policy:{schemaVersion:'F8_CONTINGENT_POLICY_V1',version:`QR2_RECEIPT_PREFLIGHT:${receipt.id}`,personId:input.ownerId,actions:action?[action]:[]},provenance:betaProvenance(input,`QR2_RECEIPT_PREFLIGHT:${input.provenance.version}:${receipt.id}`)};
}

function planReceiptQ({input,receipt,surplus,capacityRows,cashModel,qualifyingModel}){
  const policy=qReceiptPolicy(input,receipt);if(!policy||surplus<=EPS)return {gross:0,net:0,tax:0,capacityUsed:0};
  const alive=input.memberScenarios.filter(s=>(s.kind==='MEMBER_DEATH'?s.memberDeathDate:s.terminalDate)>receipt.date);if(!alive.length)return {gross:0,net:0,tax:0,capacityUsed:0};
  const out=[];for(const s of alive){const run=evaluateQualifyingPolicyProfessionalSimulationBeta(m5ReceiptPreflightInput({input,receipt,scenario:s,surplus,policy,capacityRows,cashModel,qualifyingModel}),betaAuthority(input)),a=run.planned[0].actions.find(x=>x.actionId===policy.actionId);if(!a)fail('M5 receipt Q preflight action missing');out.push(a)}
  const first=out[0];for(const r of out.slice(1))for(const f of ['grossAmount','netAmount','tax','capacityUsed'])if(Math.abs(r[f]-first[f])>EPS)fail('future mortality changed receipt Q preflight');
  return {gross:first.grossAmount,net:first.netAmount,tax:first.tax,capacityUsed:first.capacityUsed};
}

function buildResidualQuote(input,receipt,amount){
  if(amount<=EPS)return null;const r=input.residualDestination;
  if(!r?.entryRoute||r.entryRoute!=='STAY'||!r.provenance?.version)fail('receipt residual stay-destination assumption required');num(r.netFamilyValuePerCapital,'residual quote per capital');
  const sourceId=`qr2:residual:${receipt.id}`,destinationId=`stay:${sourceId}`;return {schemaVersion:'F8_UNIFIED_RESIDUAL_V1',asOfDate:receipt.date,ownerId:input.ownerId,currency:input.currency,sources:[{id:sourceId,economicPathId:`${receipt.economicPathId}:residual`,ownerId:input.ownerId,asOfDate:receipt.date,currency:input.currency,amount}],destinationCaps:[{destinationId,maximum:amount}],offers:[{sourceId,destinationId,entryRoute:'STAY',provenance:structuredClone(r.provenance),quotes:[{capital:0,netFamilyValue:0},{capital:amount,netFamilyValue:amount*r.netFamilyValuePerCapital}]}]};
}

function buildMemberReceipts(input,option,payment,treatment,netConsideration){
  const gross=netConsideration/payment.annuityFactor,rows=[];num(gross,'member annuity receipt');
  for(const d of payment.paymentDates){const t=treatment.get(d),id=`qr2:${input.caseId}:receipt:${d}`;rows.push({id,date:d,rightId:`qr2:${input.caseId}:annuity-right`,contractId:option.contractId,ruleId:`${payment.provenance.version}:${option.id}`,sourceEventId:`qr2:${input.caseId}:annuity-payment:${d}`,economicPathId:`qr2:${input.caseId}:receipt-path:${d}`,provenance:{version:`QR2_RECEIPT:${payment.version}:${d}`},gross,requiredConsumption:t.requiredConsumption,taxTreatment:{amount:gross*t.taxFractionOfGross,version:`${t.provenance.version}:TAX`,status:'SIMULATION_ASSUMPTION',productionVerified:false,sourceReference:t.provenance.sourceReference}})}
  return rows;
}

function niAuthority(input,receipts,treatment){return {schemaVersion:'F8_M8_BETA_NI_HEALTH_AUTHORITY_V1',mode:MODE,simulationAuthorized:true,productionVerified:false,assumptionPackHash:input.assumptionPackHash,version:`QR2_NI:${input.receiptTreatment.version}`,provenance:{verificationStatus:'SIMULATION_ASSUMPTION',productionVerified:false,sourceReference:input.receiptTreatment.provenance.sourceReference,version:`${input.receiptTreatment.version}:NI`,assumptionPackHash:input.assumptionPackHash},quotes:receipts.map(r=>{const t=treatment.get(r.date);return {quoteId:`qr2:ni:${r.id}`,receiptId:r.id,date:r.date,amount:r.gross*t.niHealthFractionOfGross,classification:'PROFESSIONAL_SIMULATION_Q_RECEIPT',provenance:{version:`${t.provenance.version}:NI`,verificationStatus:'SIMULATION_ASSUMPTION',productionVerified:false}}})}}

function buildQr1Input(input,receipts,treatment){
  const cash=validateReceiptStateTemplate(input.receiptStateModels.cash,'cash',input),qual=validateReceiptStateTemplate(input.receiptStateModels.qualifying,'qualifying',input),residualTemplate=validateReceiptStateTemplate(input.receiptStateModels.residual,'residual',input);
  const cashModel=buildQr1StateModel(cash,receipts,input.memberScenarios),qualModel=buildQr1StateModel(qual,receipts,input.memberScenarios),resModel=buildQr1StateModel(residualTemplate,receipts,input.memberScenarios);
  const usedByYear=new Map(),receiptQualifyingPolicy={};
  for(const receipt of receipts){const surplus=receipt.gross-receipt.taxTreatment.amount-(receipt.gross*treatment.get(receipt.date).niHealthFractionOfGross)-receipt.requiredConsumption;
    if(surplus<-EPS)fail('generated receipt cannot fund authorized deductions/service');const capacity=input.capacity.map(c=>({...structuredClone(c),alreadyUsed:c.alreadyUsed+(usedByYear.get(c.taxYear)||0)})),policy=qReceiptPolicy(input,receipt),q=planReceiptQ({input,receipt,surplus:Math.max(0,surplus),capacityRows:capacity,cashModel:cash,qualifyingModel:qual});if(q.capacityUsed>EPS){const y=Number(receipt.date.slice(0,4));usedByYear.set(y,(usedByYear.get(y)||0)+q.capacityUsed)}if(policy)receiptQualifyingPolicy[receipt.id]={...policy,selected:true};const residual=surplus-q.gross;receipt.residualQuote=buildResidualQuote(input,receipt,residual)}
  const residualStateModels={};for(const receipt of receipts)for(const offer of receipt.residualQuote?.offers??[])residualStateModels[offer.destinationId]=resModel;
  return {schemaVersion:'F8_M8_RECEIPT_PIPELINE_V1',mode:MODE,caseId:input.caseId,ownerId:input.ownerId,currency:input.currency,assumptionPackHash:input.assumptionPackHash,provenance:betaProvenance(input,`QR2_TO_QR1:${input.provenance.version}`),receipts,scenarios:input.memberScenarios,capacity:structuredClone(input.capacity),receiptQualifyingPolicy,niHealthAuthority:niAuthority(input,receipts,treatment),cashStateModel:cashModel,qualifyingStateModel:qualModel,residualStateModels,valuationConvention:structuredClone(input.valuationConvention)};
}

function sourceConversion(input,option,commencementState,sourceAdapter){
  const quote=sourceAdapter.quote({qCapital:input.qCapital,sourceState:copyFreeze(commencementState),contractOption:copyFreeze(option),valuationDate:option.commencementDate});
  if(!quote||quote.valuationDate!==option.commencementDate||!provenanceOk(quote.provenance,input.assumptionPackHash))fail('explicit source annuitization quote required');
  for(const f of ['grossSourceValue','basisNominal','basisIndexed','taxAmount','fees','netConsideration'])num(quote[f],`annuitization ${f}`);
  if(Math.abs(quote.grossSourceValue-commencementState.value)>EPS||Math.abs(quote.basisNominal-commencementState.basisNominal)>EPS||Math.abs(quote.basisIndexed-commencementState.basisIndexed)>EPS)fail('annuitization quote not bound to exact commencement source state');
  if(Math.abs(quote.grossSourceValue-quote.taxAmount-quote.fees-quote.netConsideration)>EPS||quote.netConsideration<=DECISION_EPS)fail('source annuitization quote does not reconcile');
  const paths=new EconomicPathLedger(),root=paths.open(`qr2:${input.caseId}:source-at-commencement`,quote.grossSourceValue,{currentOwner:'member',sourceEventId:`qr2:${input.caseId}:source-handoff:${option.commencementDate}`});let seq=0;const id=t=>`qr2:${input.caseId}:convert:${seq++}:${t}`;
  const sink=(category,amount)=>{if(amount<=DECISION_EPS)return null;const p=paths.open(id(`${category}:path`),amount,{parentPathId:root.id,currentOwner:'member',sourceEventId:`qr2:${category}:${option.commencementDate}`});paths.sink(p.id,id(`${category}:sink`),category,option.commencementDate,amount);return p.id};
  sink('annuitization_source_tax',quote.taxAmount);sink('annuitization_fee',quote.fees);const consideration=paths.open(id('annuity_consideration'),quote.netConsideration,{parentPathId:root.id,currentOwner:'member',sourceEventId:`qr2:annuity-consideration:${option.commencementDate}`});paths.sink(consideration.id,id('annuity_consideration_sink'),'annuity_consideration',option.commencementDate,quote.netConsideration);
  const reconciliation=paths.reconcile();if(Math.abs(reconciliation.gap)>EPS||reconciliation.liveTotal>EPS)fail('source annuitization conversion reconciliation failed');
  const rightId=`qr2:${input.caseId}:annuity-right`;if((input.preExistingRightIds??[]).includes(rightId))fail('q-created right collides with pre-existing right');
  const rights=new RightsLedger(),right=rights.add({id:rightId,owner:'member',contractId:option.contractId,rightType:'optional_annuity',sourceAssetId:consideration.id,commencementDate:option.commencementDate,monthlyAmountRule:input.paymentSemantics.version,survivorPct:option.survivorPercent,guaranteeMonths:option.guaranteeMonths,recipientRules:input.paymentSemantics.provenance.version,terminationRules:'M7_OPTION_AND_QR2_PAYMENT_SEMANTICS',ruleIds:[option.provenance.version,input.paymentSemantics.version,sourceAdapter.version]});
  return {quote:copyFreeze(quote),reconciliation:copyFreeze(reconciliation),sinks:paths.sinks(),right:copyFreeze(right),rightsCreated:rights.rights(),considerationPathId:consideration.id};
}

function branchContractCashflows({input,branch,option,payment,memberGross}){
  const end=memberEnd(branch),spEnd=spouseEnd(branch),guaranteed=new Set(payment.guaranteePaymentDates),scheduled=[],continuation=[];
  const add=(bucket,date,recipient,category,gross)=>{if(gross<=EPS)return;bucket.push({id:`qr2:${input.caseId}:${branch.id}:${category}:${date}`,date,recipient,category,gross,ruleId:payment.version,rightId:`qr2:${input.caseId}:annuity-right`})};
  if(branch.member.kind==='SURVIVE_TO_TERMINAL_HORIZON'){
    for(const d of payment.paymentDates)if(d>end)add(continuation,d,'member','member_annuity_continuation',memberGross);
    return {scheduled,continuation,endpoint:end,terminalKind:'MEMBER_TERMINAL'};
  }
  const death=branch.member.deathDate;
  for(const d of payment.paymentDates){if(d<=death)continue;const isGuaranteed=guaranteed.has(d),spouseAliveAtDeath=branch.spouseAliveAtMemberDeath,spouseAliveAtDate=branch.spouse.kind==='SURVIVE_TO_TERMINAL_HORIZON'||branch.spouse.deathDate>d,
      beyondSpouseTerminal=branch.spouse.kind==='SURVIVE_TO_TERMINAL_HORIZON'&&d>branch.spouse.terminalDate,bucket=beyondSpouseTerminal?continuation:scheduled;
    if(spouseAliveAtDeath&&spouseAliveAtDate){const surv=memberGross*option.survivorPercent;add(bucket,d,'spouse','survivor',surv);if(isGuaranteed&&payment.guaranteeMode==='FULL_MEMBER_PAYMENT')add(bucket,d,'spouse','guarantee_top_up',Math.max(0,memberGross-surv));continue}
    if(isGuaranteed){const recipient=branch.spousePredeceasedMember?payment.guaranteeRecipientIfSpousePredeceased:payment.guaranteeRecipientAfterSpouseDeath;if(recipient!=='NONE')add(bucket,d,recipient,'guarantee',memberGross)}
  }
  return {scheduled,continuation,endpoint:spEnd,terminalKind:branch.spouse.kind==='SURVIVE_TO_TERMINAL_HORIZON'?'SPOUSE_TERMINAL':'SPOUSE_DEATH'};
}

function continuationValue({input,adapter,valuationDate,right=null,liveLots=[],contractState=null,label}){
  const livePaths=liveLots.map(l=>({id:l.economicPathId,amount:l.currentValue,category:'receipt_derived_state'}));if(right)livePaths.push({id:`qr2:${input.caseId}:${label}:right-backing`,amount:0,category:'contract_right',rightId:right.id});
  if(!livePaths.length)return {value:0,result:null};const raw=adapter.valueContinuation({valuationDate,state:{caseId:input.caseId,label,livePaths,rights:right?[right]:[],lots:liveLots,contractState}}),validated=validateContinuationValueResult(raw,{valuationDate,mode:MODE,livePaths,rightIds:right?[right.id]:[]});return {value:validated.continuationValue,result:validated};
}

function receiptStateValue({input,adapter,qr1Scenario,valuationDate,isTerminal}){
  let death=0;const liveLots=[];for(const r of qr1Scenario.receipts){if(r.status!=='RECEIPT_EXECUTED')continue;for(const st of [r.qState,...r.residualStates.map(x=>x.state)].filter(Boolean)){if(isTerminal)liveLots.push(...st.liveLots);else death+=st.finalUses.reduce((n,u)=>n+u.amountNet,0)}}
  if(!isTerminal)return {value:death,continuation:null,liveLots:[]};const c=continuationValue({input,adapter,valuationDate,liveLots,label:`receipt-state:${qr1Scenario.scenarioId}`});return {value:c.value,continuation:c.result,liveLots};
}

function familyMoney(input,branch,amount){const d=memberEnd(branch);return {amount,valuationDate:d,moneyBasis:input.valuationConvention.moneyBasis,taxStatus:'NET',ownerId:'family',productId:'QR2_Q_POINT',currency:input.currency}}

function normalize(raw,adapters){
  const input=structuredClone(raw);forbiddenSlider(input);for(const k of ['scenarioValues','points','frontier','receiptSchedule','receipts'])if(Object.hasOwn(input,k))fail('external q scenario/frontier/receipt economics are forbidden');if(input?.schemaVersion!=='F8_M8_NATIVE_Q_POINT_V1'||input.mode!==MODE||!input.caseId||!input.ownerId||!input.currency||
    !/^[a-f0-9]{64}$/i.test(input.assumptionPackHash??'')||!input.provenance?.version||input.provenance.simulationMode!==MODE||input.provenance.productionVerified!==false||
    !input.valuationConvention||!input.jointMortality||!input.m7ContractMenu||!input.contractOptionId||!input.sourceState||!input.paymentSemantics||!input.receiptTreatment||
    !input.receiptStateModels||!Array.isArray(input.capacity)||!input.residualDestination)fail('complete qR2 Professional Simulation point input required');
  num(input.qCapital,'q capital');if(input.preExistingRightIds!=null&&(!Array.isArray(input.preExistingRightIds)||new Set(input.preExistingRightIds).size!==input.preExistingRightIds.length))fail('distinct pre-existing right IDs required');validateSourceState(input.sourceState,input);if(input.sourceState.amount!==input.qCapital&&input.qCapital>DECISION_EPS)fail('qR2 source state must be the dedicated q capital slice');
  const joint=createJointMortality(input.jointMortality);input.memberScenarios=input.jointMortality.member.map(memberScenario);const option=validateM7Option(input),payment=validatePaymentSemantics(input.paymentSemantics,input,option),treatment=validateReceiptTreatment(input.receiptTreatment,input,payment.paymentDates);
  const sourceAdapter=validateAdapter(adapters?.sourceAnnuitizationAdapter,'F8_M8_BETA_Q_SOURCE_ANNUITIZATION_ADAPTER_V1',input,'source annuitization','quote'),continuationAdapter=validateAdapter(adapters?.continuationAdapter,'F8_M8_BETA_Q_CONTINUATION_ADAPTER_V1',input,'q continuation','valueContinuation');
  validateReceiptStateTemplate(input.receiptStateModels.cash,'cash',input);validateReceiptStateTemplate(input.receiptStateModels.qualifying,'qualifying',input);validateReceiptStateTemplate(input.receiptStateModels.residual,'residual',input);
  return {input:copyFreeze(input),joint,option:copyFreeze(option),payment:copyFreeze(payment),treatment,sourceAdapter,continuationAdapter};
}

function zeroPoint({input,joint,option}){
  const branchResults=joint.branches.map(b=>({branchId:b.id,member:b.member,spouse:b.spouse,qExecuted:false,familyValue:0,finalEconomicUses:[],rightsCreated:[],receiptStateValue:0,rightContinuationValue:0,annuitizationDecisionCertified:false}));
  const scenarios=joint.branches.map(b=>({id:b.id,kind:b.member.kind==='DEATH'?'MEMBER_DEATH':'SURVIVE_TO_TERMINAL_HORIZON',probability:b.probability,...(b.member.kind==='DEATH'?{memberDeathDate:b.member.deathDate}:{terminalDate:b.member.terminalDate}),familyValue:familyMoney(input,b,0)})),expected=evaluateClosedDistribution(scenarios,input.valuationConvention);
  return copyFreeze({schemaVersion:'F8_M8_NATIVE_Q_POINT_RESULT_V1',mode:MODE,caseId:input.caseId,qCapital:0,contractOptionId:option.id,commencementDate:option.commencementDate,sourceEconomicUses:[],annuityRight:null,receiptSchedule:[],branchResults,scenarioValues:branchResults.map(b=>({branchId:b.branchId,familyValue:b.familyValue})),expectedNetFamilyValue:expected.expectedNetFamilyValue,valuationBasis:{baseDate:expected.baseDate,moneyBasis:expected.moneyBasis,conventionVersion:expected.conventionVersion},economicActions:[],rightsCreated:[],finalEconomicUsesByBranch:branchResults.map(b=>({branchId:b.branchId,uses:[]})),reconciliation:{qSourceRoot:0,gap:0},provenance:{version:`QR2_ZERO:${input.provenance.version}`,simulationMode:MODE,productionVerified:false},annuitizationDecisionCertified:false,globalOptimal:false,productionReady:false});
}


function useValue(u){return Number.isFinite(u?.amountNet)?u.amountNet:Number.isFinite(u?.value)?u.value:0}
function continuationUses(result,prefix){return (result?.components??[]).map((c,i)=>({id:c.id||`${prefix}:${i}`,category:c.category||'continuation_value',recognitionType:'CONTINUATION_VALUE_NOT_CASH_RECEIPT',amountNet:c.value,backingPathIds:[...(c.backingPathIds??[])],rightIds:[...(c.rightIds??[])]}))}
function branchValueReconciliation(input,branchResult){
  const actual=[...(branchResult.finalEconomicUses??[])],continuation=[];
  if(branchResult.receiptStateContinuation)continuation.push(...continuationUses(branchResult.receiptStateContinuation,`qr2:${input.caseId}:${branchResult.branchId}:receipt-cont`));
  if(branchResult.rightContinuation)continuation.push(...continuationUses(branchResult.rightContinuation,`qr2:${input.caseId}:${branchResult.branchId}:right-cont`));
  if(!branchResult.qExecuted&&branchResult.sourceReplay?.kind==='SURVIVE_TO_TERMINAL_HORIZON'&&!actual.length&&branchResult.familyValue>EPS){
    continuation.push({id:`qr2:${input.caseId}:${branchResult.branchId}:source-precommencement-continuation`,category:'precommencement_source_continuation',recognitionType:'CONTINUATION_VALUE_NOT_CASH_RECEIPT',amountNet:branchResult.familyValue,backingPathIds:(branchResult.sourceReplay.liveLots??[]).map(l=>l.economicPathId),rightIds:[]});
  }
  const finalUseValue=actual.reduce((n,u)=>n+useValue(u),0),continuationValue=continuation.reduce((n,u)=>n+useValue(u),0),gap=branchResult.familyValue-finalUseValue-continuationValue;
  if(Math.abs(gap)>EPS)fail(`branch Family Value reconciliation failed: ${branchResult.branchId}`);
  return copyFreeze({branchId:branchResult.branchId,finalEconomicUses:actual,continuationEconomicUses:continuation,finalUseValue,continuationValue,familyValue:branchResult.familyValue,gap});
}
function buildLineage({input,conversion,memberReceipts,branchResults,branchReconciliations}){
  for(const r of memberReceipts)if(r.rightId!==conversion.right.id)fail('receipt lineage does not originate from q-created right');
  const receiptUseIdsByBranch={};
  for(const b of branchResults){
    const rows=[];
    for(const rec of b.receiptPipelineScenario?.receipts??[]){if(rec.status!=='RECEIPT_EXECUTED')continue;rows.push({receiptId:rec.receiptId||rec.id,date:rec.date,finalUseIds:[...(rec.qState?.finalUses??[]),...rec.residualStates.flatMap(x=>x.state.finalUses)].map(u=>u.id),livePathIds:[...(rec.qState?.liveLots??[]),...rec.residualStates.flatMap(x=>x.state.liveLots)].map(l=>l.economicPathId)});}
    receiptUseIdsByBranch[b.branchId]=rows;
  }
  const continuationIdsByBranch=Object.fromEntries(branchReconciliations.map(r=>[r.branchId,r.continuationEconomicUses.map(u=>u.id)]));
  return copyFreeze({sourceRootId:input.sourceState.economicPathId,sourceHandoffDate:conversion.quote.valuationDate,annuityConsiderationPathId:conversion.considerationPathId,annuityRightId:conversion.right.id,receiptIds:memberReceipts.map(r=>r.id),receiptUseIdsByBranch,continuationIdsByBranch,edges:[
    {from:input.sourceState.economicPathId,to:conversion.considerationPathId,type:'SOURCE_TO_ANNUITY_CONSIDERATION'},
    {from:conversion.considerationPathId,to:conversion.right.id,type:'CONSIDERATION_TO_CONTRACT_RIGHT'},
    ...memberReceipts.map(r=>({from:conversion.right.id,to:r.id,type:'RIGHT_TO_DATED_RECEIPT'}))
  ]});
}

/** qR2 only: evaluates one explicit qCapital point and one explicitly selected M7-feasible contract option.
 * It does not enumerate q amounts, build a frontier, rank points, or connect q to M10. */
export function evaluateNativeAnnuitizationPointProfessionalSimulationBeta(raw,adapters){
  const n=normalize(raw,adapters),{input,joint,option,payment,treatment,sourceAdapter,continuationAdapter}=n;if(input.qCapital<=DECISION_EPS)return zeroPoint(n);
  const commencement=option.commencementDate;if(commencement<input.sourceState.stateDate)fail('q commencement precedes source state');
  const commencementState=sourceStateAtCommencement(input,commencement),conversion=sourceConversion(input,option,commencementState,sourceAdapter),memberGross=conversion.quote.netConsideration/payment.annuityFactor,
    memberReceipts=buildMemberReceipts(input,option,payment,treatment,conversion.quote.netConsideration),qr1Input=buildQr1Input(input,memberReceipts,treatment),qr1=replayAnnuitizationReceiptPipelineProfessionalSimulationBeta(qr1Input);
  if(qr1.annuitizationDecisionCertified!==false||qr1.valuationRecognition!=='STATE_ONLY_NO_RECEIPT_PV')fail('qR1 recognition contract changed');
  const qr1ByMember=new Map(qr1.scenarios.map(s=>[s.scenarioId,s])),branchResults=[];
  for(const branch of joint.branches){const end=memberEnd(branch),beforeCommencement=end<commencement;if(end===commencement)fail('same-day member endpoint/commencement requires explicit ordering');
    if(beforeCommencement){const srcScenario=branch.member.kind==='DEATH'?{id:branch.member.id,kind:'MEMBER_DEATH',memberDeathDate:branch.member.deathDate,probability:1}:{id:branch.member.id,kind:'SURVIVE_TO_TERMINAL_HORIZON',terminalDate:branch.member.terminalDate,probability:1},src=replaySource(input,srcScenario);
      branchResults.push({branchId:branch.id,member:branch.member,spouse:branch.spouse,qExecuted:false,status:'DEATH_OR_TERMINAL_BEFORE_COMMENCEMENT',familyValue:src.familyValueAtEnd,receiptStateValue:0,rightContinuationValue:0,contractCashflows:{scheduled:[],continuation:[]},finalEconomicUses:src.finalUses,sourceReplay:src,rightsCreated:[],antiDoubleCount:{sourceCapitalCountedAfterCommencement:false,receiptPvRecognized:false,preExistingRightCredited:false},annuitizationDecisionCertified:false});continue}
    const qstate=qr1ByMember.get(branch.member.id);if(!qstate)fail('qR1 member branch missing');const isTerminal=branch.member.kind==='SURVIVE_TO_TERMINAL_HORIZON',receiptValue=receiptStateValue({input,adapter:continuationAdapter,qr1Scenario:qstate,valuationDate:end,isTerminal}),contractState=branchContractCashflows({input,branch,option,payment,memberGross}),rightValue=continuationValue({input,adapter:continuationAdapter,valuationDate:end,right:conversion.right,contractState,label:`contract-right:${branch.id}`}),family=receiptValue.value+rightValue.value,
      finalUses=qstate.receipts.flatMap(r=>r.status==='RECEIPT_EXECUTED'?[...(r.qState?.finalUses??[]),...r.residualStates.flatMap(x=>x.state.finalUses)]:[]);
    branchResults.push({branchId:branch.id,member:branch.member,spouse:branch.spouse,qExecuted:true,status:isTerminal?'MEMBER_TERMINAL_CONTINUATION':'MEMBER_DEATH_AFTER_COMMENCEMENT',familyValue:family,receiptStateValue:receiptValue.value,rightContinuationValue:rightValue.value,contractCashflows:contractState,finalEconomicUses:finalUses,receiptPipelineScenario:qstate,receiptStateContinuation:receiptValue.continuation,rightContinuation:rightValue.result,rightsCreated:[conversion.right],antiDoubleCount:{sourceCapitalCountedAfterCommencement:false,annuityRightAssetValueCounted:false,receiptPvRecognized:false,receiptStateOnlyRecognition:true,rightContinuationStartsAt:end,preExistingRightCredited:false},annuitizationDecisionCertified:false})
  }
  const branchReconciliations=branchResults.map(b=>branchValueReconciliation(input,b));
  const scenarioRows=joint.branches.map((b,i)=>({id:b.id,kind:b.member.kind==='DEATH'?'MEMBER_DEATH':'SURVIVE_TO_TERMINAL_HORIZON',probability:b.probability,...(b.member.kind==='DEATH'?{memberDeathDate:b.member.deathDate}:{terminalDate:b.member.terminalDate}),familyValue:familyMoney(input,b,branchResults[i].familyValue)})),expected=evaluateClosedDistribution(scenarioRows,input.valuationConvention),economicActions=[{actionId:`qr2:${input.caseId}:annuitize`,actionDate:commencement,type:'OPTIONAL_ANNUITIZATION_POINT',sourceId:input.sourceState.id,qCapital:input.qCapital,sourceValueAtDate:conversion.quote.grossSourceValue,sourceTax:conversion.quote.taxAmount,fees:conversion.quote.fees,netAnnuitizationConsideration:conversion.quote.netConsideration,contractOptionId:option.id,annuitizationDecisionCertified:false},...(()=>{const seen=new Map();const semantic=a=>({actionId:a.actionId,date:a.date,actionDate:a.actionDate,taxYear:a.taxYear,entryRoute:a.entryRoute,grossAmount:a.grossAmount,tax:a.tax,fees:a.fees,netAmount:a.netAmount,basisBefore:a.basisBefore,basisAfter:a.basisAfter,capacityBefore:a.capacityBefore,capacityUsed:a.capacityUsed,capacityAfter:a.capacityAfter,balanceBefore:a.balanceBefore,balanceAfter:a.balanceAfter,reasonCode:a.reasonCode,stopCondition:a.stopCondition,ruleId:a.ruleId,contractId:a.contractId,provenance:a.provenance});for(const s of qr1.scenarios)for(const r of s.receipts)for(const a of r.qState?.economicActions??[]){const prior=seen.get(a.actionId);if(prior&&JSON.stringify(semantic(prior))!==JSON.stringify(semantic(a)))fail('receipt-funded Q action diverged across mortality branches');if(!prior)seen.set(a.actionId,a)}return [...seen.values()]})()];
  const sourceUses=[{category:'annuitization_source_tax',amount:conversion.quote.taxAmount},{category:'annuitization_fee',amount:conversion.quote.fees},{category:'annuity_consideration',amount:conversion.quote.netConsideration}],sourceGap=conversion.quote.grossSourceValue-sourceUses.reduce((s,x)=>s+x.amount,0);if(Math.abs(sourceGap)>EPS)fail('source conversion gap');
  const lineage=buildLineage({input,conversion,memberReceipts,branchResults,branchReconciliations});
  const receiptRootGaps=qr1.scenarios.flatMap(s=>s.receipts.filter(r=>r.immediateReconciliation).map(r=>r.immediateReconciliation.gap)),receiptStateGaps=qr1.scenarios.flatMap(s=>s.receipts.filter(r=>r.stateReconciliation).map(r=>r.stateReconciliation.gap)),branchFamilyValueGaps=branchReconciliations.map(r=>r.gap);
  if(receiptRootGaps.some(x=>Math.abs(x)>EPS)||receiptStateGaps.some(x=>Math.abs(x)>EPS)||branchFamilyValueGaps.some(x=>Math.abs(x)>EPS))fail('qR2 end-to-end reconciliation failed');
  return copyFreeze({schemaVersion:'F8_M8_NATIVE_Q_POINT_RESULT_V1',mode:MODE,caseId:input.caseId,qCapital:input.qCapital,contractOptionId:option.id,commencementDate:commencement,sourceEconomicUses:sourceUses,sourceStateAtCommencement:commencementState,sourceAnnuitizationQuote:conversion.quote,annuityRight:conversion.right,receiptSchedule:memberReceipts.map(r=>({id:r.id,date:r.date,gross:r.gross,rightId:r.rightId,contractId:r.contractId,ruleId:r.ruleId,sourceEventId:r.sourceEventId,economicPathId:r.economicPathId,provenance:r.provenance})),receiptPipeline:qr1,branchResults,scenarioValues:branchResults.map(b=>({branchId:b.branchId,familyValue:b.familyValue})),expectedNetFamilyValue:expected.expectedNetFamilyValue,valuationBasis:{baseDate:expected.baseDate,moneyBasis:expected.moneyBasis,conventionVersion:expected.conventionVersion},economicActions,rightsCreated:conversion.rightsCreated,finalEconomicUsesByBranch:branchReconciliations.map(r=>({branchId:r.branchId,uses:r.finalEconomicUses})),continuationEconomicUsesByBranch:branchReconciliations.map(r=>({branchId:r.branchId,uses:r.continuationEconomicUses})),reconciliation:{qSourceRoot:input.qCapital,sourceStateAtCommencement:conversion.quote.grossSourceValue,sourceStateReconciliation:commencementState.reconciliation,sourceConversionReconciliation:conversion.reconciliation,sourceConversionGap:sourceGap,receiptRootGaps,receiptStateGaps,branchFamilyValueGaps,branchValueReconciliations:branchReconciliations,lineage},antiDoubleCount:{sourceCapitalAndRight:false,receiptPvAndEstate:false,preExistingRightsCredited:false,stateRecognition:'STATE_ONLY_NO_RECEIPT_PV'},provenance:{version:`QR2_NATIVE_POINT:${input.provenance.version}`,simulationMode:MODE,productionVerified:false,sourceAnnuitizationAdapterVersion:sourceAdapter.version,continuationAdapterVersion:continuationAdapter.version,paymentSemanticsVersion:payment.version,mortalityVersion:joint.version,valuationConventionVersion:expected.conventionVersion},annuitizationDecisionCertified:false,globalOptimal:false,productionReady:false});
}
