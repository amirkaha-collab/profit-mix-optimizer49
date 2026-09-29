import {buildInheritanceViewModel} from '../../u1/f8-binding.js';
import {DECISION_EPS} from '../../methodology/shared/numerical-contract.js';
import {
  Q1B_FIXTURE_IDS,
  buildQ1BFrozenFixture,
  replayQ1BFixedSelectedPlanScenario
} from '../q1b/q1b-fixed-selected-plan-replay.js';

const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){for(const v of Object.values(x))freeze(v);Object.freeze(x)}return x};
const fail=m=>{throw new Error(`Q1C_PRODUCT_INTEGRATION: ${m}`)};
const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const sum=(xs,f=x=>x)=>xs.reduce((n,x)=>n+f(x),0);

export const Q1C_PRODUCT_VERSION='F8_PROFESSIONAL_SIMULATION_BETA_USER_REVIEW_CANDIDATE_0';
export const Q1B_EXTERNAL_EVIDENCE_BACKLOG=32;
export const ORDERING_UNRESOLVED_USER_MESSAGE='כאשר שני אירועים מתרחשים באותו יום אין למערכת מידע מספיק לקבוע איזה מהם קדם. לכן לא חושבה תוצאה לאותו גבול זמן.';

const profileMeta=freeze({
  Q1B_Q_ZERO:{label:'תכנון הוני ללא המרה לקצבה',summary:'ההון נשאר במסלולים ההוניים שנבחרו; אין המרה נוספת לקצבה.'},
  Q1B_Q_ONLY_DELAYED_FIRST_RECEIPT:{label:'המרת ההון לקצבה — תשלום ראשון מאוחר',summary:'ההון מומר לקצבה, עם פער זמן בין תחילת הזכות לתשלום הראשון.'},
  Q1B_Q_PLUS_ROTATION:{label:'קצבה משולבת עם רוטציה',summary:'חלק מההון משמש למהלך רוטציה וחלק נוסף מומר לקצבה.'},
  Q1B_Q_PLUS_QUALIFYING:{label:'קצבה משולבת עם הפקדה לרובד המזכה',summary:'חלק מההון מומר לקצבה וחלק משמש להפקדה מתוכננת לרובד המזכה.'},
  Q1B_R_Q_q_MIXED:{label:'תוכנית משולבת מלאה',summary:'התוכנית משלבת רוטציה, רובד מזכה והמרת חלק מההון לקצבה.'},
  Q1B_SURVIVOR_GUARANTEE:{label:'קצבה עם זכויות לבן/בת הזוג והבטחה',summary:'הקצבה כוללת שיעור לשאיר ותקופת תשלומים מובטחים.'},
  Q1B_RECEIPT_FUNDED_Q:{label:'קצבה עם ניתוב עודף תקבולים לרובד המזכה',summary:'עודף מתקבולי הקצבה מופנה תחילה לרובד המזכה לפי הקיבולת הזמינה.'}
});

const strategyLabel=freeze({
  ROTATION:'רוטציה / מהלך קצבתי',
  QUALIFYING:'הפקדה מתוכננת לרובד המזכה',
  OPTIONAL_ANNUITIZATION:'המרת חלק מההון לקצבה',
  RESIDUAL:'השארת יתרה במסלול ההוני'
});
const actionLabel=freeze({
  ROTATION:'בצע/י את מהלך הרוטציה שנבחר',
  QUALIFYING:'העבר/י את הסכום לרובד המזכה במועד שנבחר',
  OPTIONAL_ANNUITIZATION:'המר/י את החלק שנבחר לקצבה',
  RESIDUAL:'השאר/י את היתרה במסלול ההוני'
});
const destinationLabel=freeze({
  ROTATION:'מסלול הקצבה שנבחר',
  QUALIFYING:'הרובד המזכה',
  OPTIONAL_ANNUITIZATION:'זכות הקצבה שנבחרה',
  RESIDUAL:'המסלול ההוני הקיים'
});
const nextStepLabel=freeze({
  ROTATION:'לאחר מכן הרכיב ממשיך לפי מסלול הקצבה שנבחר בתוכנית.',
  QUALIFYING:'לאחר מכן הסכום ממשיך ברובד המזכה בהתאם לתוכנית שנבחרה.',
  OPTIONAL_ANNUITIZATION:'לאחר מכן נוצרת זכות הקצבה והתקבולים משולמים לפי לוח התשלומים החוזי שנבחר.',
  RESIDUAL:'לאחר מכן היתרה ממשיכה במסלול ההוני שנבחר.'
});

function planStrategy(plan){
  const alloc=plan.selectedStrategy?.allocationByType??{};
  return freeze(Object.entries(alloc).filter(([,v])=>num(Number(v))!=null&&Number(v)>DECISION_EPS).map(([type,amount])=>({type,label:strategyLabel[type]??'רכיב בתוכנית',amount:Number(amount)})));
}
function sourceText(action){
  if(action.actionType==='QUALIFYING')return 'מההון שיועד לרכיב ההוני';
  if(action.actionType==='OPTIONAL_ANNUITIZATION')return 'מההון שנבחר להמרה לקצבה';
  if(action.actionType==='ROTATION')return 'מההון שיועד לרוטציה';
  return 'מהיתרה שנשארת במסלול ההוני';
}
function humanActionPlan(plan){
  return freeze((plan.economicActions??[]).map(a=>({
    actionId:a.actionId,
    type:a.actionType,
    what:actionLabel[a.actionType]??'בצע/י את הפעולה שנבחרה',
    amount:num(a.netAmount)??num(a.grossAmount)??num(a.amount),
    grossAmount:num(a.grossAmount),
    tax:num(a.tax),
    source:sourceText(a),
    destination:destinationLabel[a.actionType]??'היעד שנבחר בתוכנית',
    then:nextStepLabel[a.actionType]??'לאחר מכן הפעולה ממשיכה בהתאם לתוכנית שנבחרה.',
    date:a.date??null,
    executionStatus:a.executionStatus??null,
    stopCondition:a.stopCondition??null
  })));
}
function scenarioCashflows(evidence){
  const flows=evidence?.contractCashflows?.scheduled??[];
  return freeze(flows.map(x=>({date:x.date??null,recipient:x.recipient??null,kind:x.kind??x.type??x.category??null,gross:num(x.gross)??num(x.amount)??0})));
}
function survivorSummary(ctx,evidence){
  const f=ctx.q1b.frozenDecision;
  const cashflows=scenarioCashflows(evidence);
  const spouse=cashflows.filter(x=>String(x.recipient).toLowerCase()==='spouse');
  const heirs=cashflows.filter(x=>String(x.recipient).toLowerCase()==='heirs');
  return freeze({
    selected:f.qCapital>DECISION_EPS,
    survivorPercent:f.survivorPercent,
    guaranteeMonths:f.guaranteeMonths,
    spousePayments:spouse,
    heirGuaranteePayments:heirs,
    spouseGross:sum(spouse,x=>x.gross),
    heirGuaranteeGross:sum(heirs,x=>x.gross),
    explanation:f.qCapital<=DECISION_EPS?'לא נבחר רכיב קצבתי בתוכנית.':f.survivorPercent>0||f.guaranteeMonths>0?'הזכויות לבן/בת הזוג ולתקופת ההבטחה נשארות לפי החוזה שנבחר מראש; שינוי תרחיש הפטירה אינו בוחר חוזה חדש.':'בתוכנית שנבחרה אין שיעור שאירים או תקופת הבטחה.'
  });
}
function executionSummary(ctx,evidence){
  const qSelected=ctx.q1b.frozenDecision.qCapital>DECISION_EPS;
  return freeze({
    annuitizationSelected:qSelected,
    annuitizationExecuted:evidence?.qExecuted===true,
    annuitizationStatus:evidence?.qExecutionStatus??(qSelected?'NOT_EXECUTED':'NOT_SELECTED'),
    rightsCreated:evidence?.qRightsCreated?.length??0,
    memberReceiptsExecuted:evidence?.memberReceipts?.executed?.length??0,
    memberReceiptsSkipped:evidence?.memberReceipts?.skipped?.length??0,
    receiptFundedQualifyingActions:evidence?.receiptEvidence?.receiptQActionIds?.length??0,
    combinedCapacity:evidence?.combinedCapacity??[]
  });
}
function invariantSummary(ctx,evidence){
  const f=ctx.q1b.frozenDecision;
  return freeze({
    samePlanId:evidence.planId===f.planId,
    optimizerCalls:evidence.optimizerCalls,
    qCapital:f.qCapital,
    contractOptionId:f.contractOptionId,
    commencementDate:f.commencementDate,
    selectedR:f.selectedR,
    selectedQ:f.selectedQ,
    selectedResidual:f.selectedResidual,
    expectedFamilyValue:f.expectedFamilyValue
  });
}
function mainOutcome(ctx,evidence,vm){
  const plan=ctx.planProjection;
  return freeze({
    expected:{baseline:plan.baselineExpectedFamilyValue,planned:plan.expectedFamilyValue,delta:plan.expectedDelta},
    scenario:vm?{baseline:vm.headline.baseline.total.amount,planned:vm.headline.planned.total.amount,delta:vm.headline.delta.amount}:null,
    distinction:'הערך הצפוי משמש לבחירת התוכנית. תרחיש ה־What-if בודק מה יקרה לאותה תוכנית אם מועדי הפטירה ישתנו.'
  });
}

export function listQ1CProductProfiles(){return freeze(Q1B_FIXTURE_IDS.map(id=>({id,...profileMeta[id]})))};

export function buildQ1CProductContext(fixtureId='Q1B_R_Q_q_MIXED'){
  if(!Q1B_FIXTURE_IDS.includes(fixtureId))fail(`unknown beta input profile ${fixtureId}`);
  const q1b=buildQ1BFrozenFixture(fixtureId);
  return freeze({
    schemaVersion:'F8_Q1C_PRODUCT_CONTEXT_V1',
    productVersion:Q1C_PRODUCT_VERSION,
    fixtureId,
    profile:profileMeta[fixtureId],
    q1b,
    planProjection:q1b.planProjection,
    strategy:planStrategy(q1b.planProjection),
    actionPlan:humanActionPlan(q1b.planProjection),
    externalEvidenceBacklog:Q1B_EXTERNAL_EVIDENCE_BACKLOG
  });
}

export function runQ1CProductScenario(ctx,spec){
  if(ctx?.schemaVersion!=='F8_Q1C_PRODUCT_CONTEXT_V1')fail('q1C product context required');
  const evidence=replayQ1BFixedSelectedPlanScenario(ctx.q1b,spec);
  if(evidence.status==='ORDERING_UNRESOLVED'){
    return freeze({
      schemaVersion:'F8_Q1C_PRODUCT_RESULT_V1',status:'ORDERING_UNRESOLVED',productVersion:Q1C_PRODUCT_VERSION,
      fixtureId:ctx.fixtureId,profile:ctx.profile,planProjection:ctx.planProjection,scenarioProjection:null,viewModel:null,
      mainOutcome:mainOutcome(ctx,evidence,null),strategy:ctx.strategy,actionPlan:ctx.actionPlan,
      scenario:{id:evidence.scenario.id,memberDate:evidence.scenario.memberDate,spouseDate:evidence.scenario.spouseDate,status:'ORDERING_UNRESOLVED',userMessage:ORDERING_UNRESOLVED_USER_MESSAGE,ordering:evidence.ordering},
      survivorGuarantee:survivorSummary(ctx,null),execution:null,invariants:invariantSummary(ctx,evidence),optimizerCalls:0
    });
  }
  if(evidence.status!=='REPLAYED'||!evidence.scenarioProjection)fail('unexpected q1B replay status');
  const vm=buildInheritanceViewModel(ctx.planProjection,evidence.scenarioProjection,{displayBasis:'NOMINAL',route:'INHERITANCE',goal:'INHERITANCE'});
  if(vm.identity.planId!==ctx.planProjection.planId)fail('ViewModel changed plan identity');
  if(evidence.optimizerCalls!==0)fail('optimizer call forbidden in q1C replay');
  return freeze({
    schemaVersion:'F8_Q1C_PRODUCT_RESULT_V1',status:'REPLAYED',productVersion:Q1C_PRODUCT_VERSION,
    fixtureId:ctx.fixtureId,profile:ctx.profile,planProjection:ctx.planProjection,scenarioProjection:evidence.scenarioProjection,viewModel:vm,
    mainOutcome:mainOutcome(ctx,evidence,vm),strategy:ctx.strategy,actionPlan:ctx.actionPlan,
    scenario:{id:evidence.scenario.id,memberDate:evidence.scenario.memberDate,spouseDate:evidence.scenario.spouseDate,status:'REPLAYED',userMessage:null},
    survivorGuarantee:survivorSummary(ctx,evidence),execution:executionSummary(ctx,evidence),invariants:invariantSummary(ctx,evidence),optimizerCalls:0,
    evidence
  });
}
