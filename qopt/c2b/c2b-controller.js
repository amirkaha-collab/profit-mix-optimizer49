import {buildCapitalCaseV1,buildIncomeCaseV1,BASELINE_TYPES} from './c2b-contracts.js';
import {projectCapitalV1,rebaselineCapitalProjection} from './c2b-capital.js';
import {projectIncomeV1,rebaselineIncomeProjection} from './c2b-income.js';
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){for(const v of Object.values(x))freeze(v);Object.freeze(x)}return x};
export function createC2BController(route,raw={}){if(!['CAPITAL','INCOME'].includes(route))throw new Error('C2B_ROUTE');let state={route,optimizerCalls:0,case:null,projection:null,baselineType:BASELINE_TYPES.SAVINGS_POLICY,solveGeneration:0};
  const api={
    getState:()=>state,
    solve(nextRaw={}){const c=route==='CAPITAL'?buildCapitalCaseV1({...raw,...nextRaw,baselineType:state.baselineType}):buildIncomeCaseV1({...raw,...nextRaw,baselineType:state.baselineType});const p=route==='CAPITAL'?projectCapitalV1(c):projectIncomeV1(c);state=freeze({...state,optimizerCalls:state.optimizerCalls+1,case:c,projection:p,solveGeneration:state.solveGeneration+1});return p},
    setBaseline(type){if(!Object.values(BASELINE_TYPES).includes(type))throw new Error('C2B_BASELINE');state=freeze({...state,baselineType:type,projection:state.projection?(route==='CAPITAL'?rebaselineCapitalProjection(state.case,state.projection,type):rebaselineIncomeProjection(state.case,state.projection,type)):null});return state.projection},
    updateMaterial(nextRaw){return api.solve(nextRaw)},
    reset(){state=freeze({route,optimizerCalls:0,case:null,projection:null,baselineType:BASELINE_TYPES.SAVINGS_POLICY,solveGeneration:0});return state}
  };return api
}
