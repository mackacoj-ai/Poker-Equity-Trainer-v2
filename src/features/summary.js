// Extend per-street records with betting KPIs and help build session aggregates

export function kpiAccumulator() {
  return {
    preflopInRangeCnt: 0,
    preflopHands: 0,
    cbetAttempts: 0,
    cbetOkGreen: 0,
    sizeOkGreen: 0,
    turnBarrels: 0,
    turnBarrelOkGreen: 0,
    riverBarrels: 0,
    riverBarrelOkGreen: 0
  };
}

export function rollupKpis(kpi, record) {
  if (record.stage === 'preflop') {
    kpi.preflopHands += 1;
    if (record.preflopInRange) kpi.preflopInRangeCnt += 1;
  }
  if (record.stage === 'flop' && record.cbetAttempted != null) {
    kpi.cbetAttempts += record.cbetAttempted ? 1 : 0;
    if (record.cbetOk === 'green') kpi.cbetOkGreen += 1;
    if (record.sizeOk === 'green') kpi.sizeOkGreen += 1;
  }
  if (record.stage === 'turn' && record.wasBarrel) {
    kpi.turnBarrels += 1;
    if (record.barrelOk === 'green') kpi.turnBarrelOkGreen += 1;
    if (record.sizeOk === 'green') kpi.sizeOkGreen += 1;
  }
  if (record.stage === 'river' && record.wasBarrel) {
    kpi.riverBarrels += 1;
    if (record.barrelOk === 'green') kpi.riverBarrelOkGreen += 1;
    if (record.sizeOk === 'green') kpi.sizeOkGreen += 1;
  }
  return kpi;
}
