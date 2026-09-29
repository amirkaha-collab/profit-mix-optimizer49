export const Q1B_DATE_ONLY_CONTRACTUAL_EQUALITY_V1=Object.freeze({
  schemaVersion:'F8_Q1B_CONTRACTUAL_EQUALITY_V1',
  conventionId:'Q1B_DATE_ONLY_CONTRACTUAL_EQUALITY_V1',
  scope:'PROFESSIONAL_SIMULATION_BETA_CONTRACTUAL_DATE_EQUALITY',
  status:'ORDERING_UNRESOLVED',
  behavior:'FAIL_CLOSED',
  optimizerCalls:0,
  qualifyingQConventionApplied:false,
  provenance:Object.freeze({
    version:'Q1B_DATE_ONLY_CONTRACTUAL_EQUALITY_V1',
    authority:'Q1B_CANONICAL_ACCEPTANCE_AMENDMENT_2026-09-28',
    productionLegalRule:false
  })
});

export function contractualEqualityStatus(reasons){
  if(!Array.isArray(reasons)||reasons.length===0)return null;
  return Object.freeze({
    ...Q1B_DATE_ONLY_CONTRACTUAL_EQUALITY_V1,
    reasons:Object.freeze([...new Set(reasons)].sort())
  });
}
