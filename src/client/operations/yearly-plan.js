
// --- Yearly Plan ---
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAY_LABELS = ['Mo','Tu','We','Th','Fr','Sa','Su'];

function changeYear(delta) {
  if (delta === 0) yearlyYear = new Date().getFullYear();
  else yearlyYear += delta;
  invalidateYearlyCache();
  loadYearlyPlan();
}

function invalidateYearlyCache() {
  yearlyData = null;
}

function filterYearlyDataByCategories(data, names) {
  const filterEntries = obj => {
    const out = {};
    for (const [ds, items] of Object.entries(obj)) {
      const filtered = items.filter(t => names.includes(t.category));
      if (filtered.length) out[ds] = filtered;
    }
    return out;
  };
  return {
    ...data,
    dueDates: filterEntries(data.dueDates || {}),
    completedDates: filterEntries(data.completedDates || {}),
  };
}

function renderYearlyUpcoming() {
  const upcomingEl = document.getElementById('yearly-upcoming');
  if (!upcomingEl) return;
  const today = new Date().toISOString().split('T')[0];
  const todayDate = new Date(today);
  const priorityBadge = p => p === 'Critical' ? 'badge-critical' : p === 'High' ? 'badge-high' : p === 'Medium' ? 'badge-medium' : 'badge-low';
  const recurrenceLabel = r => ({ daily:'Daily', weekly:'Weekly', biweekly:'Biweekly', monthly:'Monthly', quarterly:'Quarterly', yearly:'Yearly', custom:'Custom' }[r] || r);
  const formatDueDate = (ds, isOverdue) => {
    const d = new Date(ds + 'T00:00:00');
    const diff = Math.round((d - todayDate) / 86400000);
    const label = MONTH_NAMES[d.getMonth()].substring(0, 3) + ' ' + d.getDate();
    if (isOverdue) {
      const daysAgo = Math.round((todayDate - d) / 86400000);
      return `<span style="color:var(--danger);font-size:12px">${label} · <span style="font-size:11px">${daysAgo}d ago</span></span>`;
    }
    if (diff === 0) return `<span style="font-weight:600;font-size:12px">Today</span>`;
    if (diff === 1) return `<span style="font-size:12px">Tomorrow</span>`;
    return `<span style="font-size:12px">${label} · <span style="color:var(--text-muted);font-size:11px">in ${diff}d</span></span>`;
  };

  let items = yearlyUpcomingCache;
  if (yearlyFilters.overdue_only) items = items.filter(i => i._status === 'overdue');
  if (yearlyFilters.priority) items = items.filter(i => i.priority === yearlyFilters.priority);
  if (yearlyFilters.search) {
    const q = yearlyFilters.search.toLowerCase();
    items = items.filter(i => i.title.toLowerCase().includes(q) || (i.category || '').toLowerCase().includes(q));
  }

  const overdueCount = items.filter(i => i._status === 'overdue').length;
  const upcomingCount = items.filter(i => i._status === 'upcoming').length;
  const upcomingGridCols = '2fr 140px 90px 1fr 80px 100px 110px';
  const buildTableRow = item => {
    const isOverdue = item._status === 'overdue';
    return `<div class="arch-table-row" style="grid-template-columns:${upcomingGridCols}${isOverdue ? ';background:var(--danger-bg,#fff5f5)' : ''}">
      <div class="arch-col-name" style="cursor:pointer" onclick="openTaskModal(${item.task_id})">
        <span class="arch-name" style="color:var(--primary)">${esc(item.title)}</span>
        ${item.category ? `<span class="arch-desc">${esc(item.category)}</span>` : ''}
      </div>
      <div class="arch-col-detail">${formatDueDate(item.date, isOverdue)}</div>
      <div class="arch-col-detail">
        ${isOverdue
          ? `<span class="badge badge-critical">Overdue</span>`
          : `<span class="badge badge-low" style="background:var(--success-light,#e6f9ee);color:var(--success,#16a34a)">Upcoming</span>`}
      </div>
      <div class="arch-col-detail"><span style="font-size:12px">${item.assignee ? esc(item.assignee) : '<span style="color:var(--text-muted)">—</span>'}</span></div>
      <div class="arch-col-detail"><span class="badge ${priorityBadge(item.priority)}">${item.priority}</span></div>
      <div class="arch-col-detail"><span class="task-recurrence-badge">&#8635; ${recurrenceLabel(item.recurrence)}</span></div>
      <div class="arch-col-actions" style="gap:6px">
        <button class="btn btn-secondary btn-sm" style="font-size:11px" onclick="openTaskModal(${item.task_id})">&#9998; Edit</button>
        <button class="btn btn-primary btn-sm" style="font-size:11px" onclick="quickComplete(${item.task_id},'${item.date}')">&#10003;</button>
      </div>
    </div>`;
  };

  let html = `<h3 class="section-title" style="margin-top:28px">
    Tasks — Overdue &amp; Next 4 Weeks
    <span class="req-cat-count" style="margin-left:6px">(${items.length})</span>
    ${overdueCount > 0 ? `<span class="badge badge-critical" style="margin-left:8px;font-size:11px">${overdueCount} overdue</span>` : ''}
    ${upcomingCount > 0 ? `<span style="font-size:12px;color:var(--text-muted);margin-left:6px">${upcomingCount} upcoming</span>` : ''}
  </h3>`;
  if (items.length === 0) {
    html += '<div class="empty-state">No overdue or upcoming tasks match the filters.</div>';
  } else {
    html += `<div class="arch-table">
      <div class="arch-table-head" style="grid-template-columns:${upcomingGridCols}">
        <div>Task</div><div>Due Date</div><div>Status</div><div>Assignee</div><div>Priority</div><div>Recurrence</div><div></div>
      </div>
      <div>${items.map(buildTableRow).join('')}</div>
    </div>`;
  }
  upcomingEl.innerHTML = html;
}

function renderYearlyFilters() {
  const bar = document.getElementById('yearly-filters-bar');
  if (!bar) return;
  bar.innerHTML = `
    <input type="search" placeholder="Search tasks..." value="${esc(yearlyFilters.search)}"
      style="min-width:160px" oninput="yearlyFilters.search=this.value;renderYearlyUpcoming()">
    <select onchange="yearlyFilters.priority=this.value;renderYearlyUpcoming()">
      <option value="">All Priorities</option>
      <option value="Low" ${yearlyFilters.priority==='Low'?'selected':''}>Low</option>
      <option value="Medium" ${yearlyFilters.priority==='Medium'?'selected':''}>Medium</option>
      <option value="High" ${yearlyFilters.priority==='High'?'selected':''}>High</option>
      <option value="Critical" ${yearlyFilters.priority==='Critical'?'selected':''}>Critical</option>
    </select>
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
      <input type="checkbox" ${yearlyFilters.overdue_only?'checked':''} onchange="yearlyFilters.overdue_only=this.checked;renderYearlyUpcoming()">
      Overdue only
    </label>
  `;
}

async function loadYearlyPlan() {
  document.getElementById('yearly-title').textContent = `Yearly Plan ${yearlyYear}`;
  renderYearlyFilters();
  try {
  const rawData = await api(`/api/yearly?year=${yearlyYear}`);
  // Apply process context filter to yearly data
  const yearCtxNames = getOpPlanContextNames();
  const data = yearCtxNames ? filterYearlyDataByCategories(rawData, yearCtxNames) : rawData;
  yearlyData = data;
  const today = new Date().toISOString().split('T')[0];

  // Compute per-month stats
  const monthStats = [];
  let totalDue = 0, totalCompleted = 0, totalOverdue = 0, totalSkipped = 0;
  for (let m = 0; m < 12; m++) {
    const daysInMonth = new Date(yearlyYear, m + 1, 0).getDate();
    let due = 0, completed = 0, overdue = 0;
    const taskDates = {}; // { task_id: { title, assignee, priority, recurrence, dates: [{date, type}] } }

    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${yearlyYear}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      if (data.dueDates[ds]) {
        due += data.dueDates[ds].length;
        for (const t of data.dueDates[ds]) {
          const isOverdue = ds < today && t.status === 'pending';
          if (t.status === 'skipped') totalSkipped++;
          if (isOverdue) overdue++;
          if (!taskDates[t.task_id]) taskDates[t.task_id] = { ...t, dates: [] };
          if (t.status !== 'completed') taskDates[t.task_id].dates.push({ date: ds, type: t.status === 'skipped' ? 'skipped' : isOverdue ? 'overdue' : 'due' });
        }
      }
      if (data.completedDates[ds]) {
        completed += data.completedDates[ds].length;
        for (const t of data.completedDates[ds]) {
          if (!taskDates[t.task_id]) taskDates[t.task_id] = { ...t, dates: [] };
          taskDates[t.task_id].dates.push({ date: ds, type: 'completed' });
        }
      }
    }
    monthStats.push({ due, completed, overdue, taskDates });
    totalDue += due;
    totalCompleted += completed;
    totalOverdue += overdue;
  }

  // Render yearly summary stats
  const summaryEl = document.getElementById('yearly-summary');
  const pct = totalDue > 0 ? Math.round((totalCompleted / totalDue) * 100) : 0;
  summaryEl.innerHTML = `
    <div class="stat-card"><div class="stat-value">${totalDue}</div><div class="stat-label">Total Scheduled (${yearlyYear})</div></div>
    <div class="stat-card done"><div class="stat-value">${totalCompleted}</div><div class="stat-label">Completed occurrences</div></div>
    <div class="stat-card${totalOverdue > 0 ? ' overdue' : ''}"><div class="stat-value">${totalOverdue}</div><div class="stat-label">Overdue</div></div>
    <div class="stat-card"><div class="stat-value">${totalSkipped}</div><div class="stat-label">Skipped</div></div>
    <div class="stat-card"><div class="stat-value">${pct}%</div><div class="stat-label">Completion Rate</div></div>
  `;

  // Render Gantt chart
  renderGanttChart(data, monthStats, today);

  // Collect all overdue+upcoming items and store for filter re-render
  const todayDate = new Date(today);
  const fourWeeksOut = new Date(todayDate);
  fourWeeksOut.setDate(fourWeeksOut.getDate() + 28);
  const fourWeeksStr = fourWeeksOut.toISOString().split('T')[0];

  const overdueItems = [];
  const upcomingItems = [];
  for (const [dateStr, tasks] of Object.entries(data.dueDates)) {
    for (const t of tasks) {
      if (t.status !== 'pending') continue;
      if (dateStr < today) {
        overdueItems.push({ ...t, date: dateStr, _status: 'overdue' });
      } else if (dateStr >= today && dateStr <= fourWeeksStr) {
        upcomingItems.push({ ...t, date: dateStr, _status: 'upcoming' });
      }
    }
  }
  overdueItems.sort((a, b) => a.date.localeCompare(b.date));
  upcomingItems.sort((a, b) => a.date.localeCompare(b.date));
  // Cache raw items for filter re-renders
  yearlyUpcomingCache = [...overdueItems, ...upcomingItems];

  renderYearlyUpcoming();
  } catch (err) {
    console.error('[loadYearlyPlan] Failed:', err);
    const el = document.getElementById('yearly-summary');
    if (el) el.innerHTML = `<div class="empty-state" style="color:var(--danger)">Failed to load yearly plan: ${esc(err.message)}</div>`;
  }
}

async function quickComplete(taskId, dateStr) {
  if (!dateStr) return openCompleteModal(taskId);
  try {
    const instances = await api(`/api/task-instances?task_id=${taskId}&from=${dateStr}&to=${dateStr}`);
    const inst = instances.find(i => i.task_id === taskId && i.scheduled_date === dateStr && i.status === 'pending');
    if (!inst) {
      showToast('This occurrence is no longer pending. The plan has been refreshed.', 'error');
      return loadYearlyPlan();
    }
    return await openInstanceCompleteModal(inst.id);
  } catch (err) {
    showToast('Could not open this occurrence: ' + err.message, 'error');
  }
}

let activePopover = null;

function showDayDetail(event, dateStr) {
  event.stopPropagation();
  closeDayDetail();
  if (!yearlyData) return;
  renderDayPopover(event, dateStr, yearlyData);
}

function renderDayPopover(event, dateStr, data) {
  const due = (data.dueDates[dateStr] || []).filter(t => t.status !== 'completed');
  const completed = data.completedDates[dateStr] || [];
  const today = new Date().toISOString().split('T')[0];

  const pop = document.createElement('div');
  pop.className = 'day-popover';

  let items = '';
  for (const t of completed) {
    items += `<div class="day-popover-item" style="border-left:3px solid var(--success)">
      <strong>${esc(t.title)}</strong>
      <div class="dpi-meta">Completed${t.completed_by ? ' by ' + esc(t.completed_by) : ''}${t.completed_at ? ' on ' + esc(String(t.completed_at).slice(0,10)) : ''} &middot; ${esc(t.recurrence)} &middot; ${esc(t.assignee || 'Unassigned')}</div>
    </div>`;
  }
  for (const t of due) {
    const isOverdue = t.status === 'pending' && dateStr < today;
    const color = isOverdue ? 'var(--danger)' : 'var(--primary)';
    const label = t.status === 'skipped' ? 'Skipped' : isOverdue ? 'Overdue' : 'Scheduled';
    items += `<div class="day-popover-item" style="border-left:3px solid ${color}">
      <div style="display:flex;justify-content:space-between;align-items:start">
        <div>
          <strong>${esc(t.title)}</strong> <span class="badge badge-${t.priority.toLowerCase()}">${t.priority}</span>
          <div class="dpi-meta">${label} &middot; ${esc(t.recurrence)} &middot; ${esc(t.assignee || 'Unassigned')}</div>
        </div>
        <div style="margin-left:8px;flex-shrink:0">
          ${actionMenu([
            ...(t.status === 'pending' ? [{ label: '&#10003; Mark Done', onclick: `closeDayDetail();quickComplete(${t.task_id},'${dateStr}')`, cls: 'success' }] : []),
            { label: '&#9998; Edit', onclick: `closeDayDetail();openTaskModal(${t.task_id})` },
          ])}
        </div>
      </div>
    </div>`;
  }

  if (!items) items = '<div class="empty-state" style="padding:16px">No tasks on this date</div>';

  const formattedDate = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  pop.innerHTML = `
    <div class="day-popover-header">
      <h4>${formattedDate}</h4>
      <button class="modal-close" onclick="closeDayDetail()">&times;</button>
    </div>
    ${items}
  `;

  document.body.appendChild(pop);
  activePopover = pop;

  // Position near click
  const rect = event.target.getBoundingClientRect();
  let left = rect.right + 8;
  let top = rect.top;
  if (left + 330 > window.innerWidth) left = rect.left - 330;
  if (top + 400 > window.innerHeight) top = window.innerHeight - 410;
  if (top < 10) top = 10;
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', closeDayDetailOutside);
  }, 10);
}

function closeDayDetail() {
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
  document.removeEventListener('click', closeDayDetailOutside);
}

function closeDayDetailOutside(e) {
  if (activePopover && !activePopover.contains(e.target)) {
    closeDayDetail();
  }
}
