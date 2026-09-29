import {nonnegative,iso,frozen,validateLot,validateRight,validateEconomicPath,validateFinalUse} from './schema.js';
const EPS=1e-8;
const LOT_SPLIT=Symbol('internal lot split');
export class EconomicPathLedger{
 #paths=new Map();#uses=new Map();#sinks=new Map();#lotLedger=null;
 registerLots(ledger){if(this.#lotLedger&&this.#lotLedger!==ledger)throw new Error('path ledger already bound to a lot ledger');this.#lotLedger=ledger}
 open(id,amount,options={}){
  nonnegative(amount,'path amount');if(this.#paths.has(id))throw new Error('duplicate economic path');const {parentPathId=null,sourceEventId=null}=options,parent=parentPathId?this.#paths.get(parentPathId):null;
  if(parentPathId&&(!parent||this.#uses.has(parentPathId)||this.#sinks.has(parentPathId)))throw new Error('invalid parent');if(parent?.currentLotId&&this.#lotLedger?.get(parent.currentLotId)?.economicPathId===parentPathId&&options.guard!==LOT_SPLIT)throw new Error('live lot must be split through LotLedger');
  const currentOwner=options.currentOwner??parent?.currentOwner??'member',currentLotId=options.currentLotId??null;
  if(!['member','spouse'].includes(currentOwner))throw new TypeError('invalid path owner');
  if(parent){const used=this.#children(parentPathId).reduce((s,x)=>s+x.amount,0);if(used+amount>parent.amount+EPS)throw new Error('child exceeds parent')}
  const path=validateEconomicPath({id,parentPathId,sourceEventId,currentOwner,currentLotId,amount,finalUseId:null});this.#paths.set(id,path);return path
 }
 #children(id){return [...this.#paths.values()].filter(p=>p.parentPathId===id)}
 get(id){return this.#paths.get(id)}
 bindLot(pathId,lotId,owner,amount,guard){if(guard!==LOT_SPLIT)throw new Error('lot binding requires LotLedger');const p=this.get(pathId);if(!p||this.#children(pathId).length||this.#uses.has(pathId)||this.#sinks.has(pathId)||p.currentOwner!==owner||Math.abs(p.amount-amount)>EPS||(p.currentLotId&&p.currentLotId!==lotId))throw new Error('lot/path value or owner mismatch');this.#paths.set(pathId,frozen({...p,currentLotId:lotId}))}
 #closeable(pathId,amount){const p=this.get(pathId);if(!p||this.#uses.has(pathId)||this.#sinks.has(pathId)||this.#children(pathId).length)throw new Error('economic path already used or split');nonnegative(amount,'leaf close amount');if(Math.abs(amount-p.amount)>EPS)throw new Error('partial leaf closure requires explicit split');return p}
 finalize(pathId,id,recipient,date,amountNet,category,valuationDate){const p=this.#closeable(pathId,amountNet);if(category==='immediate_inheritance'&&(p.currentOwner!=='member'||recipient!=='heirs'||date!==valuationDate))throw new Error('immediate inheritance requires member-owned path at member death');if([...this.#uses.values()].some(x=>x.id===id))throw new Error('duplicate final use');const use=validateFinalUse({id,pathId,recipient,date,amountNet:p.amount,category,valuationDate});this.#lotLedger?.retirePath(pathId,LOT_SPLIT);this.#uses.set(pathId,use);this.#paths.set(pathId,frozen({...p,finalUseId:id}));return use}
 sink(pathId,id,category,date,amount){const p=this.#closeable(pathId,amount);iso(date);if([...this.#sinks.values()].some(s=>s.id===id))throw new Error('duplicate sink');const sink=frozen({id,pathId,category,date,amount:p.amount});this.#lotLedger?.retirePath(pathId,LOT_SPLIT);this.#sinks.set(pathId,sink);return sink}
 finalUses(){return frozen([...this.#uses.values()])}sinks(){return frozen([...this.#sinks.values()])}
 liveLeaves(){return frozen([...this.#paths.values()].filter(p=>!this.#children(p.id).length&&!this.#uses.has(p.id)&&!this.#sinks.has(p.id)))}
 reconcile(lots){
  const roots=[...this.#paths.values()].filter(p=>!p.parentPathId),details=[];if(lots){const live=lots.lots();for(const lot of live){const p=this.get(lot.economicPathId);if(!p||p.currentLotId!==lot.id||p.currentOwner!==lot.owner||Math.abs(p.amount-lot.currentValue)>EPS||this.#children(p.id).length||this.#uses.has(p.id)||this.#sinks.has(p.id))throw new Error('live lot/path mismatch')}for(const p of this.#paths.values())if(p.currentLotId&&!this.#children(p.id).length&&!this.#uses.has(p.id)&&!this.#sinks.has(p.id)&&!live.some(l=>l.economicPathId===p.id))throw new Error('unbacked live path')}
  const visit=(p,seen)=>{if(seen.has(p.id))throw new Error('path cycle');const children=this.#children(p.id);if(children.length){const sum=children.reduce((s,x)=>s+x.amount,0);if(Math.abs(sum-p.amount)>EPS)throw new Error('incomplete path split');return children.map(c=>visit(c,new Set([...seen,p.id]))).reduce((a,b)=>({live:a.live+b.live,sinks:a.sinks+b.sinks,finalUses:a.finalUses+b.finalUses}),{live:0,sinks:0,finalUses:0})}return {live:this.#uses.has(p.id)||this.#sinks.has(p.id)?0:p.amount,sinks:this.#sinks.has(p.id)?p.amount:0,finalUses:this.#uses.has(p.id)?p.amount:0}};
  for(const root of roots){const result=visit(root,new Set());const gap=root.amount-result.live-result.sinks-result.finalUses;if(Math.abs(gap)>EPS)throw new Error('root-to-leaf conservation failure');details.push(frozen({rootPathId:root.id,rootAmount:root.amount,...result,gap}))}if([...this.#paths.values()].some(p=>p.parentPathId&&!this.#paths.has(p.parentPathId)))throw new Error('orphaned path');return frozen({roots:frozen(details),rootTotal:details.reduce((s,x)=>s+x.rootAmount,0),liveTotal:details.reduce((s,x)=>s+x.live,0),sinkTotal:details.reduce((s,x)=>s+x.sinks,0),finalTotal:details.reduce((s,x)=>s+x.finalUses,0),gap:details.reduce((s,x)=>s+x.gap,0)})
 }
}
export class LotLedger{
 #lots=new Map();#paths;constructor(paths){this.#paths=paths;paths.registerLots(this)}
 retirePath(pathId,guard){if(guard!==LOT_SPLIT)throw new Error('lot retirement requires economic path close');const lot=[...this.#lots.values()].find(x=>x.economicPathId===pathId);if(lot)this.#lots.delete(lot.id)}
 add(lot){const x=validateLot(lot);if(this.#lots.has(x.id)||[...this.#lots.values()].some(l=>l.economicPathId===x.economicPathId))throw new Error('duplicate lot or path');this.#paths.bindLot(x.economicPathId,x.id,x.owner,x.currentValue,LOT_SPLIT);this.#lots.set(x.id,x);return x}
 get(id){return this.#lots.get(id)}balance(){return [...this.#lots.values()].reduce((s,x)=>s+x.currentValue,0)}lots(){return frozen([...this.#lots.values()])}
 transfer(id,newId,amount,{owner,wrapper,providerId},fee=0){const old=this.get(id);nonnegative(amount,'transfer');nonnegative(fee,'fee');if(!old||this.#lots.has(newId)||amount<=0||amount>old.currentValue||fee>amount||!['member','spouse'].includes(owner)||!['pension','t190','savings_policy','taxable','cash'].includes(wrapper)||!providerId)throw new Error('invalid transfer');const oldPath=this.#paths.get(old.economicPathId);if(!oldPath||oldPath.currentLotId!==id||oldPath.currentOwner!==old.owner||Math.abs(oldPath.amount-old.currentValue)>EPS)throw new Error('lot/path mismatch');
  const before=this.balance(),ratio=amount/old.currentValue,remaining=old.currentValue-amount,retainedId=`${id}:remaining:${newId}`,retainedPath=`${old.economicPathId}:remaining:${newId}`,transferPath=`${old.economicPathId}:transfer:${newId}`,netPath=fee?`${transferPath}:net`:transferPath,costPath=fee?`${transferPath}:fee`:null;
  const retained={...old,id:retainedId,currentValue:remaining,originalPrincipal:old.originalPrincipal*(1-ratio),taxBasisNominal:old.taxBasisNominal*(1-ratio),taxBasisReal:old.taxBasisReal*(1-ratio),economicPathId:retainedPath};const moved={...old,id:newId,owner,wrapper,providerId,sourceType:'transfer',originalPrincipal:old.originalPrincipal*ratio,taxBasisNominal:old.taxBasisNominal*ratio,taxBasisReal:old.taxBasisReal*ratio,currentValue:amount-fee,economicPathId:netPath};
  for(const candidate of [retainedPath,transferPath,netPath,costPath])if(candidate&&this.#paths.get(candidate))throw new Error('duplicate transfer path');
  this.#paths.open(retainedPath,remaining,{parentPathId:oldPath.id,currentOwner:old.owner,currentLotId:remaining?retainedId:null,sourceEventId:`transfer:${newId}`,guard:LOT_SPLIT});this.#paths.open(transferPath,amount,{parentPathId:oldPath.id,currentOwner:owner,currentLotId:fee?null:(amount>fee?newId:null),sourceEventId:`transfer:${newId}`,guard:LOT_SPLIT});if(fee){this.#paths.open(netPath,amount-fee,{parentPathId:transferPath,currentOwner:owner,currentLotId:amount>fee?newId:null,sourceEventId:`transfer:${newId}`});this.#paths.open(costPath,fee,{parentPathId:transferPath,currentOwner:owner,sourceEventId:`transfer:${newId}`});this.#paths.sink(costPath,`transfer-fee:${newId}`,'explicit_fee',old.contributionDate,fee)}
  this.#lots.delete(id);if(remaining)this.add(retained);if(amount>fee)this.add(moved);else this.#paths.sink(netPath,`zero-net:${newId}`,'explicit_fee',old.contributionDate,0);
  const gap=before-this.balance()-fee;if(Math.abs(gap)>EPS)throw new Error('transfer conservation failure');this.#paths.reconcile(this);return frozen({lot:this.get(newId)||null,fee,costPathId:costPath,conservationGap:gap})
 }
 release(id,pathId,sourceEventId){const lot=this.get(id),parent=lot&&this.#paths.get(lot.economicPathId);if(!lot||!parent||parent.currentLotId!==id||parent.currentOwner!==lot.owner||Math.abs(parent.amount-lot.currentValue)>EPS||this.#paths.get(pathId))throw new Error('lot/path release mismatch');const next=this.#paths.open(pathId,lot.currentValue,{parentPathId:parent.id,currentOwner:lot.owner,sourceEventId,guard:LOT_SPLIT});this.#lots.delete(id);this.#paths.reconcile(this);return next}
 allocateAtDeath(id,{immediateAmount=0,spouseAmount=0,continuingAmount=0,finalUseId},memberDeathDate){
  iso(memberDeathDate);for(const [name,amount] of Object.entries({immediateAmount,spouseAmount,continuingAmount}))nonnegative(amount,name);
  const lot=this.get(id),parent=lot&&this.#paths.get(lot.economicPathId);if(!lot||lot.owner!=='member'||!parent||parent.currentLotId!==id||parent.currentOwner!=='member'||Math.abs(parent.amount-lot.currentValue)>EPS)throw new Error('member death lot/path mismatch');
  if(Math.abs(immediateAmount+spouseAmount+continuingAmount-lot.currentValue)>EPS)throw new Error('member death allocations must partition the lot exactly');
  if(immediateAmount&&!finalUseId)throw new TypeError('immediate finalUseId required');if(immediateAmount&&this.#paths.finalUses().some(u=>u.id===finalUseId))throw new Error('duplicate immediate final use');if(this.#paths.liveLeaves().every(p=>p.id!==parent.id))throw new Error('member lot path is already consumed');
  const prefix=`${parent.id}:death:${id}`,immediateId=`${prefix}:heirs`,spouseId=`${prefix}:spouse`,continuingId=`${prefix}:continuing`;
  for(const pathId of [immediateId,spouseId,continuingId])if(this.#paths.get(pathId))throw new Error('member death allocation path already exists');if(spouseAmount&&this.#lots.has(`inherited:${id}`)||continuingAmount&&this.#lots.has(`continuing:${id}`))throw new Error('member death target lot already exists');
  const makeChild=(pathId,amount,owner,lotId)=>this.#paths.open(pathId,amount,{parentPathId:parent.id,currentOwner:owner,currentLotId:lotId,sourceEventId:`member_death:${memberDeathDate}`,guard:LOT_SPLIT});
  const basis=(amount)=>({originalPrincipal:lot.originalPrincipal*amount/lot.currentValue,taxBasisNominal:lot.taxBasisNominal*amount/lot.currentValue,taxBasisReal:lot.taxBasisReal*amount/lot.currentValue});
  // A positive branch alone consumes the entire parent. Zero branches are omitted.
  let immediateUse=null,spouseLot=null,continuingLot=null;
  if(immediateAmount)makeChild(immediateId,immediateAmount,'member',null);
  if(spouseAmount)makeChild(spouseId,spouseAmount,'spouse',`inherited:${id}`);
  if(continuingAmount)makeChild(continuingId,continuingAmount,'member',`continuing:${id}`);
  this.#lots.delete(id);
  if(immediateAmount)immediateUse=this.#paths.finalize(immediateId,finalUseId,'heirs',memberDeathDate,immediateAmount,'immediate_inheritance',memberDeathDate);
  if(spouseAmount)spouseLot=this.add({...lot,...basis(spouseAmount),id:`inherited:${id}`,owner:'spouse',sourceType:'inherited',currentValue:spouseAmount,economicPathId:spouseId});
  if(continuingAmount)continuingLot=this.add({...lot,...basis(continuingAmount),id:`continuing:${id}`,currentValue:continuingAmount,economicPathId:continuingId});
  this.#paths.reconcile(this);return frozen({immediateUse,spouseLot,continuingLot})
 }
}
export class RightsLedger{#rights=new Map();add(right){const r=validateRight(right);if(this.#rights.has(r.id))throw new Error('duplicate right');this.#rights.set(r.id,r);return r}get(id){return this.#rights.get(id)}rights(){return frozen([...this.#rights.values()])}}
