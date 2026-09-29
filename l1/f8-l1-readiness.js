const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){for(const v of Object.values(x))freeze(v);Object.freeze(x)}return x};
const clone=x=>structuredClone(x);
const isVerifiedTag=x=>x&&x.productionVerified===true&&x.source!=='LEGACY_COMPATIBILITY'&&x.useScope!=='WORKING_QA';
const nonemptyArray=x=>Array.isArray(x)&&x.length>0;
const iso=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const finite=n=>typeof n==='number'&&Number.isFinite(n);

export const L1_READINESS_VERSION='F8_L1_READINESS_V1';
export const L1_CAPABILITY=Object.freeze({ROTATION:'ROTATION',QUALIFYING:'QUALIFYING',OPTIONAL_ANNUITIZATION:'OPTIONAL_ANNUITIZATION',COMBINED:'COMBINED'});

function blocked(reason,details={}){return freeze({status:'BLOCKED',reason,...details})}
function ready(details={}){return freeze({status:'READY_FOR_CONTROLLED_LIVE_BINDING',...details})}

/**
 * Strict future-facing runtime envelope.  Passing this preflight does not itself
 * authorize Live economics: M10/M11 must also expose a non-QA Live integration
 * surface and event-time execution must be bound.
 */
export function validateVerifiedRuntimeEnvelope(raw){
  const x=clone(raw??{});
  if(x.schemaVersion!=='F8_L1_VERIFIED_RUNTIME_V1')return blocked('VERIFIED_RUNTIME_ENVELOPE_REQUIRED');
  if(x.status!=='VERIFIED_CONTROLLED_LIVE'||x.productionVerified!==true)return blocked('RUNTIME_NOT_VERIFIED_FOR_CONTROLLED_LIVE');
  if(['WORKING_QA','SYNTHETIC_TEST_ONLY'].includes(x.useScope)||['WORKING_QA','SYNTHETIC_TEST_ONLY','LEGACY_COMPATIBILITY'].includes(x.source))return blocked('QA_OR_LEGACY_SOURCE_CANNOT_AUTHORIZE_LIVE');
  if(!x.provenance?.version||!x.provenance?.sourceDocumentIds?.length)return blocked('VERIFIED_PROVENANCE_REQUIRED');
  if(!nonemptyArray(x.jointMortality?.branches)||x.jointMortality?.productionVerified!==true)return blocked('VERIFIED_JOINT_MORTALITY_REQUIRED');
  if(!x.eventExecution||x.eventExecution.productionVerified!==true||x.eventExecution.atomicCommit!==true||x.eventExecution.exactDateLedger!==true)return blocked('VERIFIED_EVENT_TIME_EXECUTION_REQUIRED');
  return ready({runtime:x});
}

function auditRotationRuntime(runtime){
  const c=runtime?.rotation;
  if(!c||c.productionVerified!==true)return blocked('VERIFIED_ROTATION_CONTRACT_REQUIRED');
  if(!iso(c.commencementDate)||!finite(c.annuityFactor)||c.annuityFactor<=0)return blocked('DATED_VERIFIED_ANNUITY_FACTOR_REQUIRED');
  if(!nonemptyArray(c.memberPensionSchedule)||!nonemptyArray(c.t190PaymentSchedule))return blocked('DATED_MEMBER_AND_T190_PAYMENT_SCHEDULES_REQUIRED');
  if(!nonemptyArray(c.survivorSchedule)||!nonemptyArray(c.guaranteeSchedule)||!nonemptyArray(c.familyPartitionSchedule))return blocked('DATED_SURVIVOR_GUARANTEE_FAMILY_SCHEDULE_REQUIRED');
  if(!nonemptyArray(c.requiredServiceSchedule)||!nonemptyArray(c.netServiceSchedule))return blocked('DATED_SERVICE_TAX_NI_HEALTH_SCHEDULE_REQUIRED');
  return ready();
}
function auditQualifyingRuntime(runtime){
  const c=runtime?.qualifying;
  if(!c||c.productionVerified!==true)return blocked('VERIFIED_QUALIFYING_CONTRACT_REQUIRED');
  if(!nonemptyArray(c.capacityByDate)||!c.capacityByDate.every(r=>iso(r.date)&&finite(r.amount)&&r.amount>=0&&r.ruleId&&r.productionVerified===true))return blocked('DATED_VERIFIED_PERSONAL_CAPACITY_REQUIRED');
  if(!nonemptyArray(c.sourceStateQuotes)||!c.sourceStateQuotes.every(r=>iso(r.date)&&finite(r.gross)&&finite(r.basisNominal)&&finite(r.basisIndexed)))return blocked('EXACT_DATE_SOURCE_VALUE_AND_BASIS_REQUIRED');
  if(!nonemptyArray(c.taxRules)||!c.taxRules.every(r=>r.ruleId&&r.productionVerified===true))return blocked('VERIFIED_QUALIFYING_TAX_RULES_REQUIRED');
  return ready();
}
function auditOptionalAnnuityRuntime(runtime){
  const c=runtime?.optionalAnnuitization;
  if(!c||c.productionVerified!==true)return blocked('VERIFIED_OPTIONAL_ANNUITY_CONTRACT_REQUIRED');
  if(!nonemptyArray(c.contractOptions)||!c.contractOptions.every(o=>o.contractId&&o.productionVerified===true&&iso(o.commencementDate)&&finite(o.annuityFactor)&&o.annuityFactor>0))return blocked('VERIFIED_DISCRETE_CONTRACT_OPTIONS_REQUIRED');
  if(!nonemptyArray(c.receiptSchedule)||!c.receiptSchedule.every(r=>iso(r.date)&&finite(r.gross)&&finite(r.tax)&&finite(r.niHealth)&&finite(r.net)&&Math.abs(r.gross-r.tax-r.niHealth-r.net)<1e-7))return blocked('DATED_RECONCILED_RECEIPT_SCHEDULE_REQUIRED');
  if(!c.reinvestment||c.reinvestment.productionVerified!==true||c.reinvestment.pathBacked!==true)return blocked('VERIFIED_PATH_BACKED_REINVESTMENT_REQUIRED');
  return ready();
}

export function auditL1Capabilities(rawEnvelope,{compilerLiveSurface=false}={}){
  const envelope=validateVerifiedRuntimeEnvelope(rawEnvelope);
  if(envelope.status!=='READY_FOR_CONTROLLED_LIVE_BINDING')return freeze({schemaVersion:L1_READINESS_VERSION,overall:'HOLD',envelope,capabilities:{rotation:blocked(envelope.reason),qualifying:blocked(envelope.reason),optionalAnnuitization:blocked(envelope.reason),combined:blocked(envelope.reason)}});
  const runtime=envelope.runtime;
  const rotation=auditRotationRuntime(runtime),qualifying=auditQualifyingRuntime(runtime),optionalAnnuitization=auditOptionalAnnuityRuntime(runtime);
  const all=[rotation,qualifying,optionalAnnuitization].every(x=>x.status==='READY_FOR_CONTROLLED_LIVE_BINDING');
  const combined=!all?blocked('ONE_OR_MORE_POSITIVE_CAPABILITIES_NOT_READY'):
    !compilerLiveSurface?blocked('M10_M11_LIVE_COMPILER_SURFACE_NOT_AUTHORIZED'):
    ready({eventExecution:'VERIFIED'});
  return freeze({schemaVersion:L1_READINESS_VERSION,overall:combined.status==='READY_FOR_CONTROLLED_LIVE_BINDING'?'READY_FOR_CONTROLLED_LIVE_BINDING':'HOLD',envelope:{status:envelope.status},capabilities:{rotation,qualifying,optionalAnnuitization,combined}});
}

/** Current product inventory is explicitly provisional.  This adapter converts
 * that fact into an L1 gate result; it never promotes legacy fields to verified. */
export function auditLegacyCompatibilityInventory(compat){
  if(compat?.status!=='READ_ONLY_INVENTORY')return freeze({schemaVersion:L1_READINESS_VERSION,overall:'HOLD',reason:'LEGACY_COMPATIBILITY_INVENTORY_REQUIRED'});
  const actual=compat.actual??{};
  const provisional=Object.entries(actual).filter(([,v])=>v&&typeof v==='object'&&Object.hasOwn(v,'productionVerified')&&!isVerifiedTag(v)).map(([k])=>k);
  const missing=Array.isArray(compat.missing)?[...compat.missing]:[];
  return freeze({schemaVersion:L1_READINESS_VERSION,overall:'HOLD',reason:'ACTUAL_RUNTIME_CONTRACTS_NOT_VERIFIED',productionReady:false,provisionalPrimitives:provisional,missing,capabilities:{rotation:blocked('DATED_VERIFIED_PENSION_SURVIVOR_GUARANTEE_SERVICE_CONTRACT_NOT_EXPOSED'),qualifying:blocked('VERIFIED_DATED_PERSONAL_CAPACITY_AND_EVENT_TAX_CONTRACT_NOT_EXPOSED'),optionalAnnuitization:blocked('VERIFIED_CONTRACT_OPTIONS_RECEIPTS_AND_REINVESTMENT_NOT_EXPOSED'),combined:blocked('POSITIVE_COMPONENTS_AND_LIVE_COMPILER_EVENT_EXECUTION_NOT_READY')}});
}
