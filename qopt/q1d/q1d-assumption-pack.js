const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){for(const v of Object.values(x))freeze(v);Object.freeze(x)}return x};

const common={
  schemaVersion:'F8_BETA_ASSUMPTION_PACK_V1',
  id:'F8_BETA_ASSUMPTION_PACK_Q1D_V1',
  version:'2026-09-28.1',
  simulationMode:'PROFESSIONAL_SIMULATION_BETA',
  productionVerified:false,
  currency:'ILS',
  qualifyingActionDate:'2030-01-10',
  optionalAnnuitizationDefaultCommencement:'2030-01-01',
  paymentDates:['2030-02-01','2030-03-01','2030-04-01','2030-05-01','2030-06-01','2030-07-01','2030-08-01','2030-09-01','2030-10-01','2031-02-01'],
  residual:{netFamilyValuePerCapital:1},
  receiptTreatment:{taxFractionOfGross:0,niHealthFractionOfGross:0,requiredConsumption:0,receiptFundedQualifying:false},
  valuation:{discountFactorToBase:1,inflationIndexFromBase:1},
  sourceEvolution:{grossReturnFactor:1,feeRetentionFactor:1,basisIndexFactor:1},
  mortality:{
    version:'Q1D_BETA_MORTALITY_V1',
    supportedMember:{age:60,sex:'male'},
    supportedSpouse:{age:58,sex:'female'},
    member:[
      {id:'m_pre',kind:'DEATH',deathDate:'2029-06-15',probability:.2},
      {id:'m_post',kind:'DEATH',deathDate:'2030-04-15',probability:.4},
      {id:'m_terminal',kind:'SURVIVE_TO_TERMINAL_HORIZON',terminalDate:'2032-12-31',probability:.4}
    ],
    spouse:[
      {id:'s_pre',kind:'DEATH',deathDate:'2029-10-15',probability:.25},
      {id:'s_post',kind:'DEATH',deathDate:'2030-08-15',probability:.25},
      {id:'s_terminal',kind:'SURVIVE_TO_TERMINAL_HORIZON',terminalDate:'2033-12-31',probability:.5}
    ]
  },
  provenance:{source:'F8_EXISTING_Q1A_Q1B_BETA_CONTRACTS',note:'Versioned integration authority only; no production legal authority.'},
  hash:'c798b9582fbdfd36c5f8c266fa1120a91fdb50fada297d95a4818a89ef7db5a5'
};
export const Q1D_ASSUMPTION_PACK=freeze(common);

const qOption=(id,factor,{survivorPercent=0,guaranteeMonths=0}={})=>({id,contractId:`${id}:CONTRACT`,annuityFactor:factor,commencementDate:'2030-01-01',survivorPercent,guaranteeMonths,authorityId:`${id}:AUTHORITY_V1`,authorityVersion:'2026-09-28.1'});
const profile=(id,{rotationRate=1.4,rotationMaximum=250,qualifyingCapacity=200,qualifyingMaxGross=200,qualifyingGrowth=1.3,qOptions=[]}={})=>freeze({
  schemaVersion:'F8_BETA_AUTHORITY_PROFILE_V1',id,version:'2026-09-28.1',assumptionPackId:common.id,
  mortalityAuthority:{id:'Q1D_BETA_MORTALITY_AUTHORITY_V1',version:common.mortality.version},
  taxNiAuthority:{id:'Q1D_BETA_TAX_NI_AUTHORITY_V1',version:'2026-09-28.1'},
  rotationAuthority:{id:'Q1D_BETA_ROTATION_AUTHORITY_V1',version:'2026-09-28.1',advancedSemantics:true,maximumCapital:rotationMaximum,netFamilyValuePerCapital:rotationRate},
  qualifyingAuthority:qualifyingCapacity>0?{id:'F8_BETA_QUALIFYING_CAPACITY_ASSUMPTION_V1',version:'2026-09-28.1',taxYear:2030,annualCapacity:qualifyingCapacity,alreadyUsed:0,maximumPolicyGross:qualifyingMaxGross,destinationGrowthFactor:qualifyingGrowth,actionDate:common.qualifyingActionDate}:null,
  optionalAnnuitizationAuthority:qOptions.length?{id:'Q1D_BETA_Q_CONTRACT_AUTHORITY_V1',version:'2026-09-28.1',options:qOptions,paymentSemanticsVersion:'Q1D_BETA_Q_PAYMENT_V1',receiptTreatmentVersion:'Q1D_BETA_Q_TREATMENT_V1',sourceConversionVersion:'Q1D_BETA_Q_SOURCE_CONVERSION_V1',continuationVersion:'Q1D_BETA_Q_CONTINUATION_V1'}:null
});
export const Q1D_AUTHORITY_PROFILES=freeze({
  F8_BETA_AUTHORITY_GENERAL_V1:profile('F8_BETA_AUTHORITY_GENERAL_V1',{qOptions:[qOption('general-q-a',4),qOption('general-q-b',8)]}),
  F8_BETA_AUTHORITY_A_SIMPLE_V1:profile('F8_BETA_AUTHORITY_A_SIMPLE_V1',{rotationRate:.9,rotationMaximum:250000,qualifyingCapacity:0,qualifyingMaxGross:0,qOptions:[]}),
  F8_BETA_AUTHORITY_B_ROTATION_Q_V1:profile('F8_BETA_AUTHORITY_B_ROTATION_Q_V1',{rotationRate:1.4,rotationMaximum:250000,qualifyingCapacity:200000,qualifyingMaxGross:200000,qualifyingGrowth:1.3,qOptions:[]}),
  F8_BETA_AUTHORITY_C_POSITIVE_Q_V1:profile('F8_BETA_AUTHORITY_C_POSITIVE_Q_V1',{rotationRate:1.4,rotationMaximum:250,qualifyingCapacity:200,qualifyingMaxGross:200,qualifyingGrowth:1.3,qOptions:[qOption('q-opt-a',4),qOption('q-opt-b',8)]}),
  F8_BETA_AUTHORITY_D_SURVIVOR_GUARANTEE_V1:profile('F8_BETA_AUTHORITY_D_SURVIVOR_GUARANTEE_V1',{rotationRate:1,rotationMaximum:0,qualifyingCapacity:0,qualifyingMaxGross:0,qOptions:[qOption('q-survivor-guarantee',4,{survivorPercent:.5,guaranteeMonths:4})]}),
  F8_BETA_AUTHORITY_E_Q_ZERO_V1:profile('F8_BETA_AUTHORITY_E_Q_ZERO_V1',{rotationRate:1.4,rotationMaximum:250,qualifyingCapacity:200,qualifyingMaxGross:200,qualifyingGrowth:1.3,qOptions:[qOption('q-dom-a',20),qOption('q-dom-b',25)]}),
  F8_BETA_AUTHORITY_NO_Q_V1:freeze({...profile('F8_BETA_AUTHORITY_NO_Q_V1',{qOptions:[]}),optionalAnnuitizationAuthority:null})
});
export function getQ1DAssumptionPack(id){return id===Q1D_ASSUMPTION_PACK.id?Q1D_ASSUMPTION_PACK:null}
export function getQ1DAuthorityProfile(id='F8_BETA_AUTHORITY_GENERAL_V1'){return Q1D_AUTHORITY_PROFILES[id]??null}
