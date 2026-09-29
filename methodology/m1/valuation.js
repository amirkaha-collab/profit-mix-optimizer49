/** Methodology Spec V1, M1: explicit common-time valuation. No production rate is supplied here. */
export class MethodologyBlocked extends Error {
  constructor(message) { super(message); this.name = 'MethodologyBlocked'; }
}

const block = message => { throw new MethodologyBlocked(message); };
const date = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) block('valid ISO date required');
  return value;
};
const finite = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) block(`${label} must be finite`);
  return value;
};
const freeze = object => {
  if (object && typeof object === 'object' && !Object.isFrozen(object)) {
    Object.values(object).forEach(freeze);
    Object.freeze(object);
  }
  return object;
};
const exactMap = (rows, valueKey, baseDate, label) => {
  if (!Array.isArray(rows) || rows.length === 0) block(`${label} dated quotes required`);
  const map = new Map();
  for (const row of rows) {
    date(row.date);
    if (row.date < baseDate || map.has(row.date)) block(`${label} dates invalid or duplicated`);
    const value = finite(row[valueKey], `${label} quote`);
    if (value <= 0) block(`${label} quote must be positive`);
    map.set(row.date, value);
  }
  if (map.get(baseDate) !== 1) block(`${label} must be anchored at the base date`);
  return map;
};

/**
 * Date-specific factors are deliberately exact. Interpolation or extrapolation requires a
 * separately approved, versioned convention; no rate or calendar approximation is invented.
 */
export function normalizeValuationConvention(raw) {
  const c = structuredClone(raw);
  if (c?.schemaVersion !== 'F8_VALUATION_CONVENTION_V1' ||
      typeof c.version !== 'string' || !c.version ||
      !['REAL', 'NOMINAL'].includes(c.moneyBasis)) block('versioned ValuationConvention required');
  date(c.baseDate);
  if (c.valuationDiscountCurve?.version == null ||
      c.valuationDiscountCurve?.moneyBasis !== c.moneyBasis) block('independent versioned discount curve required');
  if (c.inflationConvention?.version == null ||
      c.inflationConvention?.baseDate !== c.baseDate) block('versioned inflation convention required');
  exactMap(c.valuationDiscountCurve.factors, 'factorToBase', c.baseDate, 'discount');
  exactMap(c.inflationConvention.priceIndices, 'indexFromBase', c.baseDate, 'inflation');
  if (c.productionVerified !== false && c.productionVerified !== true) block('verification status required');
  return freeze(c);
}

export function normalizeMoneyValue(raw) {
  const m = structuredClone(raw);
  finite(m?.amount, 'money amount');
  date(m.valuationDate);
  if (!['REAL', 'NOMINAL'].includes(m.moneyBasis) ||
      !['GROSS', 'NET'].includes(m.taxStatus) || !m.ownerId ||
      !(m.productId || m.economicPathId) || !m.currency) block('complete MoneyValue required');
  return freeze(m);
}

export function valueAtBase(rawMoneyValue, rawConvention) {
  const m = normalizeMoneyValue(rawMoneyValue);
  const c = normalizeValuationConvention(rawConvention);
  if (m.taxStatus !== 'NET') block('family objective requires net money value');
  if (m.valuationDate < c.baseDate) block('value before common base date');
  const discounts = exactMap(c.valuationDiscountCurve.factors, 'factorToBase', c.baseDate, 'discount');
  const indices = exactMap(c.inflationConvention.priceIndices, 'indexFromBase', c.baseDate, 'inflation');
  const factor = discounts.get(m.valuationDate);
  if (factor === undefined) block('discount factor missing for valuation date');
  let amount = m.amount;
  if (m.moneyBasis !== c.moneyBasis) {
    const index = indices.get(m.valuationDate);
    if (index === undefined) block('inflation index missing for conversion date');
    amount = m.moneyBasis === 'NOMINAL' ? amount / index : amount * index;
  }
  return freeze({
    schemaVersion: 'F8_COMMON_BASE_VALUE_V1', amount: amount * factor,
    valuationDate: c.baseDate, moneyBasis: c.moneyBasis, taxStatus: 'NET',
    ownerId: m.ownerId, productId: m.productId, economicPathId: m.economicPathId,
    currency: m.currency, inputValuationDate: m.valuationDate,
    curveVersion: c.valuationDiscountCurve.version,
    inflationVersion: c.inflationConvention.version
  });
}

/** Terminal survival is a continuation state, never a death imputed at the horizon. */
export function evaluateClosedDistribution(rawScenarios, rawConvention) {
  const c = normalizeValuationConvention(rawConvention);
  const scenarios = structuredClone(rawScenarios);
  if (!Array.isArray(scenarios) || !scenarios.length) block('explicit distribution required');
  const ids = new Set();
  let probability = 0;
  let currency = null;
  const rows = scenarios.map(s => {
    if (typeof s.id !== 'string' || !s.id || ids.has(s.id)) block('unique scenario ID required');
    ids.add(s.id);
    if (!['MEMBER_DEATH', 'SURVIVE_TO_TERMINAL_HORIZON'].includes(s.kind)) block('explicit branch kind required');
    const p = finite(s.probability, 'scenario probability');
    if (p < 0 || p > 1) block('scenario probability outside [0,1]');
    probability += p;
    const m = normalizeMoneyValue(s.familyValue);
    if (currency !== null && m.currency !== currency) block('mixed currencies require an explicit conversion');
    currency = m.currency;
    if (s.kind === 'MEMBER_DEATH') {
      if (date(s.memberDeathDate) !== m.valuationDate || Object.hasOwn(s, 'terminalDate')) block('death valuation must be at member death');
    } else if (date(s.terminalDate) !== m.valuationDate || Object.hasOwn(s, 'memberDeathDate')) {
      block('survival continuation must be valued at the terminal date without imputed death');
    }
    const converted = valueAtBase(m, c);
    return {id: s.id, kind: s.kind, probability: p, commonBaseValue: converted,
      weightedValue: p * converted.amount};
  });
  if (Math.abs(probability - 1) > 1e-10) block('probability mass is incomplete; no renormalization');
  if (!rows.some(r => r.kind === 'SURVIVE_TO_TERMINAL_HORIZON'))
    block('explicit terminal continuation required; zero mass may be supplied after proven extinction');
  return freeze({schemaVersion:'F8_EXPECTED_COMMON_BASE_VALUE_V1',baseDate:c.baseDate,
    moneyBasis:c.moneyBasis,probabilityMass:probability,
    expectedNetFamilyValue:rows.reduce((sum,row)=>sum+row.weightedValue,0),scenarios:rows,
    conventionVersion:c.version,productionVerified:c.productionVerified});
}
