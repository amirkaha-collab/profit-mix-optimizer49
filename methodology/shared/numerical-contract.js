// Canonical numerical semantics for economic decisions. Keep decision-zero
// distinct from wider reconciliation/value tolerances.
export const DECISION_EPS = 1e-9;
export const RECONCILIATION_EPS = 1e-8;
export const isDecisionPositive = amount => typeof amount === 'number' && Number.isFinite(amount) && amount > DECISION_EPS;
export const isDecisionZero = amount => typeof amount === 'number' && Number.isFinite(amount) && Math.abs(amount) <= DECISION_EPS;
