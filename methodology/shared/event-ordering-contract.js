// Canonical Professional Simulation Beta ordering for planned member-initiated
// optional actions when only calendar dates (no timestamps) are known.
// This is a simulation convention, not a production legal/contractual rule.
export const DATE_ONLY_CONSERVATIVE_MEMBER_ACTION_ORDERING_V1 = Object.freeze({
  id:'DATE_ONLY_CONSERVATIVE_MEMBER_ACTION_ORDERING_V1',
  mode:'PROFESSIONAL_SIMULATION_BETA',
  timeResolution:'CALENDAR_DATE_ONLY',
  actionClass:'MEMBER_INITIATED_PLANNED_OPTIONAL_ACTION',
  sameDayOutcome:'NOT_EXECUTED',
  productionLegalOrContractualRule:false
});

export function memberInitiatedActionOrdering({memberDeathDate,actionDate}){
  if(memberDeathDate<actionDate)return Object.freeze({relation:'DEATH_BEFORE_ACTION',executed:false,convention:DATE_ONLY_CONSERVATIVE_MEMBER_ACTION_ORDERING_V1});
  if(memberDeathDate===actionDate)return Object.freeze({relation:'DEATH_SAME_CALENDAR_DATE_AS_ACTION',executed:false,convention:DATE_ONLY_CONSERVATIVE_MEMBER_ACTION_ORDERING_V1});
  return Object.freeze({relation:'DEATH_AFTER_ACTION',executed:true,convention:DATE_ONLY_CONSERVATIVE_MEMBER_ACTION_ORDERING_V1});
}
