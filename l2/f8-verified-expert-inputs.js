const ALLOWED_SOURCE_TYPES=new Set(['USER_DOCUMENT','PROFESSIONAL_VERIFIED','PROVIDER_DOCUMENT','OFFICIAL_RULE_ADAPTER']);
const STATUSES=new Set(['VERIFIED','UNVERIFIED','MISSING','REJECTED']);
const FIELD_NAMES=Object.freeze([
  'officialContractualAnnuityFactor','spouseSurvivorPercentage','guaranteeMonths','commencementDate',
  'policyTaxBasis','t190TaxBasis','verifiedQualifyingCapacityByYear','existingProductBalances','fees','productContractIdentifiers'
]);
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){for(const v of Object.values(x))freeze(v);Object.freeze(x)}return x};
const clone=x=>structuredClone(x);
const iso=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(`${s}T00:00:00Z`))&&new Date(`${s}T00:00:00Z`).toISOString().slice(0,10)===s;
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const fail=m=>{throw new Error(m)};

export const VERIFIED_EXPERT_INPUTS_VERSION='F8_VERIFIED_EXPERT_INPUTS_V1';
export const VERIFIED_EXPERT_SOURCE_TYPES=Object.freeze([...ALLOWED_SOURCE_TYPES]);
export const VERIFIED_EXPERT_FIELD_NAMES=FIELD_NAMES;

function validateValue(name,value,status){
  if(status==='MISSING')return value===null||value===undefined?null:fail(`${name}: MISSING field must have null value`);
  if(status!=='VERIFIED')return value;
  if(name==='officialContractualAnnuityFactor'&&(!finite(value)||value<=0))fail(`${name}: positive factor required`);
  if(name==='spouseSurvivorPercentage'&&(!finite(value)||value<0||value>1))fail(`${name}: fraction 0..1 required`);
  if(name==='guaranteeMonths'&&(!Number.isInteger(value)||value<0))fail(`${name}: nonnegative integer required`);
  if(name==='commencementDate'&&!iso(value))fail(`${name}: exact ISO date required`);
  if(['policyTaxBasis','t190TaxBasis'].includes(name)&&value!==null&&value!==undefined&&(!finite(value)||value<0))fail(`${name}: nonnegative amount required`);
  if(name==='verifiedQualifyingCapacityByYear'){
    if(!Array.isArray(value))fail(`${name}: array required`);
    const years=new Set();for(const r of value){if(!Number.isInteger(r?.year)||r.year<1900||r.year>9999||!finite(r.amount)||r.amount<0||years.has(r.year))fail(`${name}: unique {year,amount} rows required`);years.add(r.year)}
  }
  if(name==='existingProductBalances'){
    if(!Array.isArray(value)||!value.length)fail(`${name}: nonempty product array required`);
    const ids=new Set();for(const r of value){if(!r?.productId||ids.has(r.productId)||!['savings_policy','t190','pension','taxable','cash'].includes(r.wrapper)||!finite(r.balance)||r.balance<0)fail(`${name}: valid unique product rows required`);ids.add(r.productId)}
  }
  if(name==='fees'){
    if(!value||typeof value!=='object'||Array.isArray(value))fail(`${name}: object required`);
    for(const [k,v] of Object.entries(value))if(!finite(v)||v<0)fail(`${name}.${k}: nonnegative finite fee required`);
  }
  if(name==='productContractIdentifiers'){
    if(!Array.isArray(value)||!value.length)fail(`${name}: nonempty array required`);
    for(const r of value)if(!r?.productId||!r?.contractId||!r?.providerId)fail(`${name}: productId/contractId/providerId required`);
  }
  return value;
}

function normalizeEvidenceField(name,raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))fail(`${name}: evidence record required`);
  for(const k of ['value','asOfDate','sourceType','sourceReference','verifiedBy','verificationStatus'])if(!Object.hasOwn(raw,k))fail(`${name}: missing ${k}`);
  if(!STATUSES.has(raw.verificationStatus))fail(`${name}: invalid verificationStatus`);
  if(raw.sourceType!==null&&!ALLOWED_SOURCE_TYPES.has(raw.sourceType))fail(`${name}: sourceType not allowed`);
  if(raw.verificationStatus==='VERIFIED'){
    if(!iso(raw.asOfDate))fail(`${name}: verified exact asOfDate required`);
    if(!ALLOWED_SOURCE_TYPES.has(raw.sourceType))fail(`${name}: verified sourceType required`);
    if(typeof raw.sourceReference!=='string'||!raw.sourceReference.trim())fail(`${name}: sourceReference required`);
    if(typeof raw.verifiedBy!=='string'||!raw.verifiedBy.trim())fail(`${name}: verifiedBy required`);
  }
  const value=validateValue(name,clone(raw.value),raw.verificationStatus);
  return freeze({value,asOfDate:raw.asOfDate??null,sourceType:raw.sourceType??null,sourceReference:raw.sourceReference??null,verifiedBy:raw.verifiedBy??null,verificationStatus:raw.verificationStatus,productionVerified:raw.verificationStatus==='VERIFIED'&&ALLOWED_SOURCE_TYPES.has(raw.sourceType)});
}

export function buildVerifiedExpertInputs(raw){
  if(raw?.schemaVersion!==VERIFIED_EXPERT_INPUTS_VERSION)fail('verified expert input schema required');
  const fields={};for(const name of FIELD_NAMES){if(!Object.hasOwn(raw.fields??{},name))fail(`missing expert field ${name}`);fields[name]=normalizeEvidenceField(name,raw.fields[name])}
  const unexpected=Object.keys(raw.fields??{}).filter(k=>!FIELD_NAMES.includes(k));if(unexpected.length)fail(`unexpected expert field: ${unexpected.join(',')}`);
  return freeze({schemaVersion:VERIFIED_EXPERT_INPUTS_VERSION,subjectId:raw.subjectId??null,fields,productionVerified:Object.values(fields).filter(x=>x.verificationStatus!=='MISSING').every(x=>x.productionVerified===true)});
}

export function requireVerifiedExpertField(expert,name,{allowMissing=false}={}){
  if(expert?.schemaVersion!==VERIFIED_EXPERT_INPUTS_VERSION||!FIELD_NAMES.includes(name))fail('verified expert inputs/field required');
  const field=expert.fields[name];
  if(field.verificationStatus==='MISSING'&&allowMissing)return null;
  if(field.verificationStatus!=='VERIFIED'||field.productionVerified!==true)fail(`${name}: VERIFIED expert evidence required`);
  return field;
}

export function expertSourceReferences(expert){
  if(expert?.schemaVersion!==VERIFIED_EXPERT_INPUTS_VERSION)fail('verified expert inputs required');
  return freeze([...new Set(Object.values(expert.fields).filter(f=>f.productionVerified).map(f=>f.sourceReference))].sort());
}
