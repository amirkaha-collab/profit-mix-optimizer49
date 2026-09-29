import {CoreBlocked,iso,nonnegative,frozen} from './schema.js';

const EPS=1e-8;
const blocked=m=>{throw new CoreBlocked(m)};
const requiredStatus=mode=>mode==='CONTROLLED_LIVE'?'VERIFIED':mode==='PROFESSIONAL_SIMULATION_BETA'?'PROFESSIONAL_SIMULATION_BETA':mode==='WORKING_QA'?'WORKING_QA':'SYNTHETIC_TEST_ONLY';

export class ContinuationValueAdapter{
  valueContinuation(){throw new CoreBlocked('continuation value adapter required')}
}

/** Validate a terminal-living-state valuation without turning it into a death settlement.
 * Every live backing path must be represented exactly once across components. Rights may
 * be referenced at most once. The economic ledger remains live; this object is valuation
 * evidence only and never closes/duplicates those paths. */
export function validateContinuationValueResult(raw,{valuationDate,mode,livePaths=[],rightIds=[]}={}){
  iso(valuationDate);
  if(!raw||typeof raw!=='object')blocked('continuation value result required');
  if(raw.valuationDate!==valuationDate)blocked('continuation valuation date mismatch');
  nonnegative(raw.continuationValue,'continuation value');
  if(raw.verificationStatus!==requiredStatus(mode))blocked('continuation verification status mismatch');
  if(!Array.isArray(raw.components))blocked('continuation components required');
  const expectedPaths=new Set(livePaths.map(p=>p.id)),usedPaths=new Set(),expectedRights=new Set(rightIds),usedRights=new Set(),ids=new Set();
  let total=0;
  const components=raw.components.map(c=>{
    if(!c?.id||ids.has(c.id)||!c.category)blocked('unique continuation component required');ids.add(c.id);
    nonnegative(c.value,'continuation component value');total+=c.value;
    if(!Array.isArray(c.backingPathIds)||!c.backingPathIds.length)blocked('continuation component backing path required');
    for(const id of c.backingPathIds){if(!expectedPaths.has(id))blocked('continuation component references unknown live path');if(usedPaths.has(id))blocked('duplicate continuation backing path');usedPaths.add(id)}
    for(const id of c.rightIds??[]){if(!expectedRights.has(id))blocked('continuation component references unknown right');if(usedRights.has(id))blocked('duplicate continuation right');usedRights.add(id)}
    return frozen({...c,backingPathIds:frozen([...c.backingPathIds]),rightIds:frozen([...(c.rightIds??[])])});
  });
  if(expectedPaths.size!==usedPaths.size)blocked('terminal live path missing continuation valuation');
  if(Math.abs(total-raw.continuationValue)>Math.max(EPS,Math.abs(raw.continuationValue)*1e-10))blocked('continuation components do not reconcile to total');
  if(mode==='CONTROLLED_LIVE'){
    const p=raw.provenance;
    if(raw.productionVerified!==true||!p?.version||!p?.sourceReference||p.productionVerified!==true)blocked('verified continuation provenance required');
    const bad=/WORKING_QA|SYNTHETIC_TEST_ONLY|LEGACY_COMPATIBILITY/;
    const walk=(v)=>{if(typeof v==='string'&&bad.test(v))blocked('controlled-live continuation contains forbidden provenance');if(v&&typeof v==='object')for(const x of Object.values(v))walk(x)};walk(raw);
  }
  return frozen({valuationDate,continuationValue:raw.continuationValue,components:frozen(components),verificationStatus:raw.verificationStatus,productionVerified:raw.productionVerified===true,provenance:frozen({...raw.provenance})});
}

/** QA-only identity model used only when explicit test semantics select it. */
export function createIdentityContinuationValueAdapter({mode='WORKING_QA',provenance=null}={}){
  if(!['WORKING_QA','SYNTHETIC_TEST_ONLY'].includes(mode))blocked('identity continuation adapter is QA-only');
  return frozen({status:mode,valueContinuation({valuationDate,state}){
    const paths=state?.livePaths??[];const rights=state?.rights??[];
    const components=paths.map((p,i)=>({id:`continuation:${i}:${p.id}`,category:p.category??'terminal_continuation',value:p.amount,backingPathIds:[p.id],rightIds:p.rightId?[p.rightId]:[]}));
    return {valuationDate,continuationValue:components.reduce((n,c)=>n+c.value,0),components,verificationStatus:requiredStatus(mode),productionVerified:false,provenance:provenance??{version:'F8_QA_IDENTITY_CONTINUATION_V1',sourceReference:'QA_ONLY'}};
  }});
}
