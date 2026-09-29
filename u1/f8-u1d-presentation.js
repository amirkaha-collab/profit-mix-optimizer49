const fail=m=>{throw new Error(`U1D_PRESENTATION: ${m}`)};
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){for(const v of Object.values(x))freeze(v);Object.freeze(x)}return x};

export const U1D_STATUS_COPY=freeze({
  AVAILABLE_NOT_SELECTED:'לא נדרשת פעולה',
  NOT_APPLICABLE:'לא רלוונטי לתוכנית זו',
  MISSING:'לא ניתן לחשב ללא מידע נוסף',
  UNKNOWN:'לא ניתן לחשב ללא מידע נוסף',
  UNAVAILABLE:'לא ניתן לחשב ללא מידע נוסף',
  UNVERIFIED:'דורש אימות לפני ביצוע',
  BLOCKED:'דורש אימות לפני ביצוע'
});

export function statusCopy(status){return U1D_STATUS_COPY[status]??null}

export function actionYear(action){
  if(Number.isInteger(action?.taxYear))return action.taxYear;
  const y=Number(String(action?.date??'').slice(0,4));
  return Number.isInteger(y)&&y>1900?y:null;
}

export function actionAge(action){const v=action?.memberAge;return v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null}

export function actionDisplayAmount(action){
  for(const k of ['netAmount','grossAmount','amount']){const v=action?.[k];if(v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v)))return Number(v)}
  return null;
}

export function actionDestinationBucket(action){
  const explicit=String(action?.destinationType??action?.destination?.productType??'').toUpperCase();
  const id=String(action?.destinationId??'').toUpperCase();
  const route=String(action?.entryRoute??'').toUpperCase();
  const type=String(action?.actionType??'').toUpperCase();
  const s=[explicit,id,route,type].join('|');
  if(/QUALIFY/.test(s))return 'T190_QUALIFYING';
  if(/POLICY|SAVINGS_POLICY/.test(s))return 'SAVINGS_POLICY';
  if(/RECOGNIZED|T190/.test(s)&&!/QUALIFY/.test(s))return 'T190_RECOGNIZED';
  return null;
}

export function canonicalActionRefs(actions=[]){
  if(!Array.isArray(actions))fail('actions array required');
  const seen=new Set(),refs=[];
  for(const a of actions){
    if(!a?.actionId)fail('actionId required');
    if(seen.has(a.actionId))fail(`duplicate canonical actionId: ${a.actionId}`);
    seen.add(a.actionId);refs.push(a.actionId);
  }
  return freeze(refs);
}

export function buildYearlyTableRows(yearlyRows=[],actions=[]){
  // A calendar year may legitimately contain more than one exact-date projection segment
  // (for example 1-Jan accrual plus an in-year death/settlement row). U1 display must preserve
  // those rows verbatim rather than summing or choosing one. Only exact duplicate dates fail closed.
  const rows=[],byYear=new Map(),byDate=new Map();
  for(const raw of Array.isArray(yearlyRows)?yearlyRows:[]){
    const year=Number(raw?.calendarYear??raw?.year);
    if(!Number.isInteger(year))continue;
    const date=typeof raw?.date==='string'&&raw.date?raw.date:null;
    if(date&&byDate.has(date))fail(`duplicate exact-date projection row: ${date}`);
    const row={...structuredClone(raw),calendarYear:year,actionIds:[...(raw.actionIds??raw.actions?.map?.(x=>x.actionId)??[])]};
    rows.push(row);if(date)byDate.set(date,row);
    if(!byYear.has(year))byYear.set(year,[]);byYear.get(year).push(row);
  }
  for(const action of actions){
    const year=actionYear(action);if(year==null)continue;
    const date=typeof action?.date==='string'&&action.date?action.date:null;
    const yearRows=byYear.get(year)??[];
    let row=date?byDate.get(date):null;
    if(!row&&yearRows.length===1)row=yearRows[0];
    if(!row){
      row={calendarYear:year,date:date??null,memberAge:actionAge(action),projectionStatus:'ACTION_ONLY',productBalances:[],taxTotal:null,NIHealthTotal:null,events:[],flags:{},actionIds:[]};
      rows.push(row);if(!byYear.has(year))byYear.set(year,[]);byYear.get(year).push(row);if(date)byDate.set(date,row);
    }
    row.actionIds=[...(row.actionIds??[])];
    if(!row.actionIds.includes(action.actionId))row.actionIds.push(action.actionId);
  }
  const timeKey=r=>typeof r.date==='string'&&r.date?r.date:`${String(r.calendarYear).padStart(4,'0')}-12-31`;
  return freeze(rows.sort((a,b)=>timeKey(a).localeCompare(timeKey(b))||(Number(a.memberAge??0)-Number(b.memberAge??0))).map(r=>freeze(r)));
}

function phaseFor(action,commencementAge){
  const age=actionAge(action),type=String(action.actionType??'').toUpperCase();
  if(/ANNUIT|COMMENCE|ROTATION/.test(type))return 'COMMENCEMENT';
  if(Number.isFinite(commencementAge)&&Number.isFinite(age)&&age>commencementAge)return 'POST_COMMENCEMENT';
  if(action?.immediate===true||action?.date===action?.valuationDate||action?.timing==='NOW')return 'NOW';
  return 'FUTURE';
}

export function buildActionPlan(actions=[],stage3={}){
  const refs=canonicalActionRefs(actions),groups={NOW:[],FUTURE:[],COMMENCEMENT:[],POST_COMMENCEMENT:[]};
  const commencementAge=Number.isFinite(Number(stage3?.commencementAge))?Number(stage3.commencementAge):null;
  for(const action of actions)groups[phaseFor(action,commencementAge)].push(action);
  const verification=freeze([
    'יש לאמת מול הגוף המנהל את זמינות המוצר והפעולה במועד הביצוע.',
    'יש לאמת לפני ביצוע את הסיווג לצורכי מס ואת הכללים המשפטיים הרלוונטיים.',
    'בקצבה יש לאמת מקדם, שיעור שאירים ותקופת תשלומים מובטחים בפועל.'
  ]);
  return freeze({actions,actionRefs:refs,groups:freeze(groups),verification});
}

export function reconcileU1DViewModel(vm){
  if(vm?.schemaVersion!=='F8_INHERITANCE_VIEW_MODEL_V2')fail('ViewModel V2 required');
  const planned=vm.headline?.planned?.total??vm.headline?.planned;
  const stage4=vm.journey?.stages?.find?.(s=>s.type==='FAMILY_OUTCOME');
  if(!planned||!stage4?.totalFamilyValue)fail('headline and Stage 4 total required');
  if(planned.status!==stage4.totalFamilyValue.status||planned.amount!==stage4.totalFamilyValue.amount)fail('headline ↔ ScenarioProjection reconciliation failed');
  const canonical=new Set(vm.actionPlan?.actionRefs??[]);
  const checkRefs=(refs,label)=>{for(const id of refs??[])if(!canonical.has(id))fail(`${label} generated unknown action ${id}`)};
  const stage2=vm.journey?.stages?.find?.(s=>s.type==='TRANSFER_JOURNEY');
  checkRefs(stage2?.actionRefs,'Stage2');
  for(const row of vm.yearlyTable?.rows??[])checkRefs(row.actionIds,'YearlyTable');
  checkRefs(vm.actionPlan?.actionRefs,'ActionPlan');
  const tableRefs=new Set((vm.yearlyTable?.rows??[]).flatMap(r=>r.actionIds??[]));
  for(const id of canonical)if(!tableRefs.has(id))fail(`ActionPlan action missing from YearlyTable: ${id}`);
  return freeze({status:'PASS',headlineScenario:true,stage2Actions:true,yearlyActions:true,actionPlanActions:true,noConsumerGeneratedActions:true});
}
