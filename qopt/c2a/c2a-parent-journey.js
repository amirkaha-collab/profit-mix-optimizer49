export const C2A_GOALS=Object.freeze({CAPITAL:'CAPITAL',INCOME:'INCOME',INHERITANCE:'INHERITANCE'});
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){for(const v of Object.values(x))freeze(v);Object.freeze(x)}return x};
export function createC2AState(){return freeze({selectedGoal:'NONE',activeRoute:'NONE',optimizerCalls:0,inheritanceQ1DCalls:0,routeMountSeq:0,caseEpoch:1})}
export function selectC2AGoal(prev,goal){if(!Object.values(C2A_GOALS).includes(goal))throw new Error('C2A_UNSUPPORTED_GOAL');return freeze({...prev,selectedGoal:goal,activeRoute:goal,routeMountSeq:prev.routeMountSeq+1})}
export function backC2AToGoals(prev){return freeze({...prev,selectedGoal:'NONE',activeRoute:'NONE',optimizerCalls:0,inheritanceQ1DCalls:0})}
export function newC2ACase(prev){return freeze({selectedGoal:'NONE',activeRoute:'NONE',optimizerCalls:0,inheritanceQ1DCalls:0,routeMountSeq:prev.routeMountSeq,caseEpoch:prev.caseEpoch+1})}
export function observeC2AInheritanceOptimizer(prev,calls){const n=Number.isInteger(calls)&&calls>=0?calls:0;return freeze({...prev,optimizerCalls:n,inheritanceQ1DCalls:n})}
