import {DECISION_EPS} from '../../methodology/shared/numerical-contract.js';

const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){for(const v of Object.values(x))freeze(v);Object.freeze(x)}return x};
const positive=v=>typeof v==='number'&&Number.isFinite(v)&&v>DECISION_EPS;
const statusCell=(cell,label)=>({label,status:cell?.status??'MISSING',amount:typeof cell?.amount==='number'&&Number.isFinite(cell.amount)?cell.amount:null});

const strategyCopy={
  ROTATION:'מהלך קצבתי / רוטציה',
  QUALIFYING:'הפקדה לרובד המזכה',
  OPTIONAL_ANNUITIZATION:'המרת הון לקצבה',
  RESIDUAL:'יתרה הונית'
};

function whyDrivers(product,result){
  const a=product?.optimized?.allocation??{};
  const out=['מבין החלופות שהותרו ונבדקו, זו התוכנית שנבחרה על ידי המנוע לפי הערך המשפחתי הצפוי.'];
  if(positive(a.R))out.push('התוכנית שנבחרה משתמשת בחוזה הרוטציה הנתמך שסופק למקרה.');
  if(positive(a.Q))out.push('התוכנית כוללת שימוש ברובד המזכה במסגרת קיבולת מאומתת שנקשרה למקרה.');
  if(positive(a.q))out.push('התוכנית כוללת המרה לקצבה לפי אפשרות חוזית שנבחרה על ידי המנוע מתוך ההרשאות הזמינות.');
  if(positive(a.Residual))out.push('חלק מההון נשאר במסלול ההוני בתוכנית שנבחרה.');
  return freeze(out.slice(0,4));
}

function groupActions(result){
  const human=new Map((result?.actionPlan??[]).map(a=>[a.actionId,a]));
  const groups=result?.viewModel?.actionPlan?.groups;
  if(!groups)return freeze([{key:'FUTURE',label:'פעולות בתוכנית',actions:[...human.values()]}]);
  const defs=[['NOW','עכשיו'],['FUTURE','פעולות עתידיות'],['COMMENCEMENT','בתחילת הקצבה'],['POST_COMMENCEMENT','לאחר תחילת הקצבה']];
  return freeze(defs.map(([key,label])=>({key,label,actions:(groups[key]??[]).map(a=>human.get(a.actionId)).filter(Boolean)})).filter(g=>g.actions.length));
}

function moneyMovie(result){
  if(!result?.viewModel)return freeze({status:'UNAVAILABLE',events:[],rows:[]});
  const rows=result.viewModel.yearlyTable?.rows??[];
  const actionById=new Map((result.actionPlan??[]).map(a=>[a.actionId,a]));
  const events=[];
  for(const row of rows){
    for(const id of row.actionIds??[]){
      const a=actionById.get(id);
      if(a&&!events.some(e=>e.actionId===id))events.push({actionId:id,date:a.date??row.date??null,year:row.calendarYear??null,what:a.what,amount:a.amount,source:a.source,destination:a.destination});
    }
  }
  if(result.scenario?.memberDate)events.push({actionId:'SCENARIO_MEMBER_DEATH',date:result.scenario.memberDate,year:Number(String(result.scenario.memberDate).slice(0,4)),what:'תרחיש פטירת העמית',amount:null,source:null,destination:null});
  return freeze({status:'AVAILABLE',events:events.sort((a,b)=>String(a.date??'9999').localeCompare(String(b.date??'9999'))),rows});
}

function familyOutcome(result){
  if(result?.status==='ORDERING_UNRESOLVED')return freeze({status:'ORDERING_UNRESOLVED',message:result.scenario.userMessage,steps:[]});
  const stage=result?.viewModel?.journey?.stages?.find(s=>s.type==='FAMILY_OUTCOME');
  const survivor=result?.survivorGuarantee;
  if(!stage)return freeze({status:'UNAVAILABLE',message:'נתוני תוצאת המשפחה אינם זמינים בתרחיש זה.',steps:[]});
  const steps=[
    {title:'עד הפטירה',text:'התוכנית שנבחרה נשארת קפואה; רק הביצוע בפועל משתנה לפי התרחיש.'},
    {title:'במועד הפטירה',cell:statusCell(stage.totalFamilyValue,'ערך כולל למשפחה')},
    {title:'מה בן/בת הזוג מקבל/ת',cell:statusCell(stage.survivorValue,'ערך שאירים'),text:survivor?.explanation??null},
    {title:'תקופת ההבטחה',cell:statusCell(stage.guaranteeValue,'ערך תשלומים מובטחים')},
    {title:'מה קורה לאחר מכן',cell:statusCell(stage.spouseContinuationValue,'ערך המשך דרך בן/בת הזוג')},
    {title:'מה נשאר למשפחה / לעיזבון',cell:statusCell(stage.eventualEstateValue,'הון עתידי בעיזבון')}
  ];
  const hasContractRights=survivor?.selected&&((typeof survivor.survivorPercent==='number'&&survivor.survivorPercent>0)||(Number.isInteger(survivor.guaranteeMonths)&&survivor.guaranteeMonths>0));
  const contract=hasContractRights?{
    survivorPercent:typeof survivor.survivorPercent==='number'?survivor.survivorPercent:null,
    guaranteeMonths:Number.isInteger(survivor.guaranteeMonths)?survivor.guaranteeMonths:null,
    spousePaymentCount:Array.isArray(survivor.spousePayments)?survivor.spousePayments.length:0,
    heirGuaranteePaymentCount:Array.isArray(survivor.heirGuaranteePayments)?survivor.heirGuaranteePayments.length:0,
    explanation:survivor.explanation??null
  }:null;
  return freeze({status:'AVAILABLE',message:null,contract,steps});
}

function professional(product,result){
  return freeze({
    assumptionPackId:product?.planProjection?.assumptions?.assumptionPackId??null,
    assumptionPackVersion:product?.planProjection?.assumptions?.assumptionPackVersion??null,
    authorityProfileId:product?.planProjection?.assumptions?.authorityProfileId??null,
    productionReady:product?.planProjection?.productionReady===true,
    blockedReasons:[...(result?.viewModel?.professionalDetails?.blockedReasons??product?.planProjection?.blockedReasons??[])],
    warnings:[...(result?.viewModel?.warnings??[])],
    rightsCount:product?.planProjection?.rightsClaims?.length??0,
    capacityEvidenceCount:product?.planProjection?.capacityClaimsByScenario?.length??0,
    contractOptionSelected:product?.planProjection?.contractSelections?.contractOptionId!=null,
    reconciliation:result?.viewModel?.reconciliation?.status??null
  });
}

export function buildCandidate1Presentation(product,result){
  if(product?.status!=='READY')throw new Error('CANDIDATE1_PRESENTATION: READY product required');
  if(!result||!['REPLAYED','ORDERING_UNRESOLVED'].includes(result.status))throw new Error('CANDIDATE1_PRESENTATION: scenario result required');
  const expected=result.mainOutcome.expected;
  return freeze({
    schemaVersion:'F8_CANDIDATE1_PRESENTATION_V1',
    planIdentity:{planId:product.planProjection.planId,identityHash:product.planProjection.identityHash,optimizerCallsDuringScenario:result.optimizerCalls},
    recommendation:{
      expected:{planned:expected.planned,baseline:expected.baseline,delta:expected.delta},
      scenario:result.mainOutcome.scenario,
      distinction:result.mainOutcome.distinction,
      why:whyDrivers(product,result),
      strategy:(result.strategy??[]).map(x=>({...x,label:strategyCopy[x.type]??x.label}))
    },
    actionGroups:groupActions(result),
    movie:moneyMovie(result),
    family:familyOutcome(result),
    professional:professional(product,result),
    orderingUnresolved:result.status==='ORDERING_UNRESOLVED'?{message:result.scenario.userMessage,ordering:result.scenario.ordering??null}:null,
    scenario:result.scenario,
    invariants:result.invariants
  });
}
