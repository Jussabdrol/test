// Disclosure state stays in the page so tab changes do not collapse active work.
function togglePlanningFilters(group) {
  const panel = document.getElementById(`${group}-extra-filters`);
  panel.hidden = !panel.hidden;
  document.getElementById(`${group}-filter-toggle`).setAttribute('aria-expanded', String(!panel.hidden));
}

function updatePlanningFilterSummary(group) {
  const state = group === 'work' ? workFilters : filters;
  const active = [];
  if (state.series) {
    const series = workSeries.find(item => String(item.id) === state.series);
    active.push(`Series: ${series?.title || state.series}`);
  }
  if (state.assignee) active.push(`Role: ${state.assignee}`);
  if (state.priority) active.push(`Priority: ${state.priority}`);
  const toggle = document.getElementById(`${group}-filter-toggle`);
  toggle.textContent = active.length ? `More filters (${active.length})` : 'More filters';
  const summary = document.getElementById(`${group}-active-filters`);
  summary.hidden = !active.length;
  summary.textContent = active.join(' · ');
}
