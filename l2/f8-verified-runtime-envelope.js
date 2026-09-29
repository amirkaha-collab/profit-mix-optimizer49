import crypto from 'node:crypto';
import {requireVerifiedExpertField,expertSourceReferences} from './f8-verified-expert-inputs.js';
import {verifiedAdapterProvenance} from './f8-verified-rule-adapters.js';

const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){for(const v of Object.values(x))freeze(v);Object.freeze(x)}return x};
const stable=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const hash=v=>crypto.createHash('sha256').update(stable(v)).digest('hex');
const fail=m=>{throw new Error(m)};
const iso=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const bad=/WORKING_QA|SYNTHETIC_TEST_ONLY|LEGACY_COMPATIBILITY/;
export const VERIFIED_RUNTIME_VERSION='F8_L1_VERIFIED_RUNTIME_V1';

function noForbidden(v,path='root'){
  if(typeof v==='string'&&bad.test(v))fail(`forbidden QA/legacy evidence at ${path}`);
  if(v&&typeof v==='object')for(const [k,x] of Object.entries(v))noForbidden(x,`${path}.${k}`);
}
function canonicalIdentity(c){
  if(c?.schemaVersion!=='F8_CANONICAL_SCENARIO_V1')fail('canonical F8 scenario inputs required');
  return freeze({schemaVersion:c.schemaVersion,person:c.person,spouse:c.spouse,capital:c.capital,economics:c.economics,taxContext:c.taxContext,mortalityProfile:c.mortalityProfile,optimizerInputs:c.optimizerInputs});
}
function buildNetService(required,tax,ni,context){
  return required.map((r,i)=>{if(!iso(r.date)||typeof r.gross!=='number'||!Number.isFinite(r.gross)||r.gross<0)fail('required service schedule row invalid');const tq=tax.quote({date:r.date,gross:r.gross,context:{...context,serviceRow:r}}),nq=ni.quote({date:r.date,gross:r.gross,tax:tq.tax,context:{...context,serviceRow:r}});const net=r.gross-tq.tax-nq.niHealth;if(net< -1e-8)fail('tax/NI exceed service gross');return freeze({id:r.id??`service:${i}`,date:r.date,gross:r.gross,tax:tq.tax,niHealth:nq.niHealth,net:Math.max(0,net),taxRuleId:tq.ruleId,niHealthRuleId:nq.ruleId,productionVerified:true})})
}

export function buildVerifiedRuntimeEnvelope({canonicalInputs,verifiedExpertInputs,verifiedRuleAdapters,eventExecution}){
  const canonical=canonicalIdentity(canonicalInputs),rules=verifiedRuleAdapters??{};
  const factor=requireVerifiedExpertField(verifiedExpertInputs,'officialContractualAnnuityFactor');
  const survivor=requireVerifiedExpertField(verifiedExpertInputs,'spouseSurvivorPercentage');
  const guarantee=requireVerifiedExpertField(verifiedExpertInputs,'guaranteeMonths');
  const commencement=requireVerifiedExpertField(verifiedExpertInputs,'commencementDate');
  const balances=requireVerifiedExpertField(verifiedExpertInputs,'existingProductBalances');
  const fees=requireVerifiedExpertField(verifiedExpertInputs,'fees');
  const ids=requireVerifiedExpertField(verifiedExpertInputs,'productContractIdentifiers');
  if(!rules.mortality||!rules.contractualPayments||!rules.tax||!rules.niHealth)fail('verified mortality, contractual payment, tax and NI/health adapters required for Rotation runtime');
  const adapterProv=verifiedAdapterProvenance(rules);
  const joint=rules.mortality.buildJointMortality({asOfDate:commencement.asOfDate,canonicalInputs:canonical});
  const schedules=rules.contractualPayments.buildRotationSchedules({commencementDate:commencement.value,annuityFactor:factor.value,spouseSurvivorPercentage:survivor.value,guaranteeMonths:guarantee.value,canonicalInputs:canonical,productContractIdentifiers:ids.value,balances:balances.value,fees:fees.value});
  const netService=buildNetService(schedules.requiredServiceSchedule,rules.tax,rules.niHealth,{canonicalInputs:canonical});
  let qualifying=null;
  const capacityField=requireVerifiedExpertField(verifiedExpertInputs,'verifiedQualifyingCapacityByYear',{allowMissing:true});
  const policyBasis=requireVerifiedExpertField(verifiedExpertInputs,'policyTaxBasis',{allowMissing:true});
  if(capacityField&&policyBasis&&rules.qualifyingCapacity){
    const capacityByDate=capacityField.value.map(r=>{const q=rules.qualifyingCapacity.capacityForYear({year:r.year,canonicalInputs:canonical,expertAmount:r.amount});if(Math.abs(q.amount-r.amount)>1e-8)fail('expert capacity and verified capacity adapter disagree');return {date:`${r.year}-01-01`,amount:q.amount,ruleId:q.ruleId,productionVerified:true}});
    qualifying=freeze({productionVerified:false,status:'BLOCKED_INCOMPLETE_RUNTIME_CONTRACT',capacityByDate,sourceStateQuotes:[],taxRules:[],missing:['EXACT_DATE_SOURCE_VALUE_AND_BASIS','VERIFIED_QUALIFYING_TAX_RULES']});
  }
  const sourceDocumentIds=[...new Set([...expertSourceReferences(verifiedExpertInputs),...adapterProv.map(x=>x.sourceReference)])].sort();
  if(!eventExecution||eventExecution.schemaVersion!=='F8_L2_EXACT_DATE_EXECUTION_CAPABILITY_V1'||eventExecution.productionVerified!==true||eventExecution.atomicCommit!==true||eventExecution.exactDateLedger!==true)fail('verified exact-date event execution capability required');
  const envelope={schemaVersion:VERIFIED_RUNTIME_VERSION,status:'VERIFIED_CONTROLLED_LIVE',productionVerified:true,useScope:'CONTROLLED_LIVE',source:'VERIFIED_RUNTIME_CONTRACT',canonicalInputHash:hash(canonical),expertEvidence:verifiedExpertInputs.fields,provenance:{version:'F8_L2_VERIFIED_RUNTIME_V1',sourceDocumentIds,ruleAdapters:adapterProv},jointMortality:{...joint,productionVerified:true},eventExecution:{productionVerified:true,atomicCommit:true,exactDateLedger:true,executorVersion:eventExecution.executorVersion},rotation:{productionVerified:true,commencementDate:commencement.value,annuityFactor:factor.value,spouseSurvivorPercentage:survivor.value,guaranteeMonths:guarantee.value,memberPensionSchedule:schedules.memberPensionSchedule,t190PaymentSchedule:schedules.t190PaymentSchedule,survivorSchedule:schedules.survivorSchedule,guaranteeSchedule:schedules.guaranteeSchedule,familyPartitionSchedule:schedules.familyPartitionSchedule,requiredServiceSchedule:schedules.requiredServiceSchedule,netServiceSchedule:netService,contractIdentifiers:ids.value,balances:balances.value,fees:fees.value},qualifying,optionalAnnuitization:null};
  noForbidden(envelope);return freeze(envelope);
}

export function assertNoQaLegacyEvidence(value){noForbidden(value);return true}
