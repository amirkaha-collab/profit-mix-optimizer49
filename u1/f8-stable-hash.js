const stableValue=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,stableValue(x)])):Array.isArray(v)?v.map(stableValue):v;
export const stableStringify=v=>JSON.stringify(stableValue(v));
// Deterministic identity hash for projection/version reconciliation; not a cryptographic primitive.
export function stableHash(v){
  const s=stableStringify(v);let a=0x811c9dc5>>>0,b=0x9e3779b9>>>0;
  for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);a^=c;a=Math.imul(a,0x01000193)>>>0;b^=(c+i)&0xffff;b=Math.imul(b,0x85ebca6b)>>>0;b^=b>>>13}
  const h=x=>x.toString(16).padStart(8,'0');return `${h(a)}${h(b)}${h((a^b)>>>0)}${h(Math.imul(a^0x27d4eb2d,b^0x165667b1)>>>0)}`;
}
