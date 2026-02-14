// KPI chip updaters

export function updateKpis({ stage, pot, toCall, timeLeft }) {
  const kpiStageEl = document.getElementById('kpiStage');
  const kpiPotEl = document.getElementById('kpiPot');
  const kpiCallEl = document.getElementById('kpiToCall');
  const kpiTimerEl = document.getElementById('kpiTimer');

  if (kpiStageEl) kpiStageEl.textContent = `Stage: ${stage.toUpperCase()}`;
  if (kpiPotEl)   kpiPotEl.textContent = `Pot: £${(pot||0).toFixed(0)}`;
  if (kpiCallEl)  kpiCallEl.textContent = `To Call: £${(toCall||0).toFixed(0)}`;
  if (kpiTimerEl) kpiTimerEl.textContent = `Time: ${timeLeft != null ? `${timeLeft}s` : '—'}`;
}