
// =====================================================================
// AI AGENT – Chat module
// =====================================================================

let agentHistory = []; // { role: 'user'|'assistant', content }
let agentConfigured = true; // set to false when backend reports 503

async function loadAIAgent() {
  // On first load, probe the endpoint to know if the key is set
  if (agentConfigured) return; // already checked
  try {
    const r = await fetch('/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '__probe__' }) });
    if (r.status === 503) _markAgentUnconfigured();
    else agentConfigured = true;
  } catch { /* network error – assume configured, will surface on send */ }
}

function _markAgentUnconfigured() {
  agentConfigured = false;
  const inputRow = document.getElementById('agent-input-row');
  const unconfigured = document.getElementById('agent-unconfigured');
  if (inputRow) inputRow.style.display = 'none';
  if (unconfigured) unconfigured.style.display = 'flex';
}

function clearAgentChat() {
  agentHistory = [];
  const msgs = document.getElementById('agent-messages');
  if (!msgs) return;
  msgs.innerHTML = `
    <div class="agent-welcome">
      <div class="agent-avatar">&#10024;</div>
      <p>Hello! I'm your BOP AI assistant. What would you like to know?</p>
    </div>`;
}

function agentKeyDown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAgentMessage(); }
}

function agentAutoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// Minimal, safe markdown → HTML renderer
function renderAgentMarkdown(raw) {
  // Escape HTML first, then selectively un-escape for markdown
  let t = raw
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // Code spans (must come before other transforms)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    // Bold / italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Headings (line-level)
    .replace(/^#{3,} (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm,  '<h3>$1</h3>')
    // Unordered list items
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    // Numbered list items
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Wrap consecutive <li> runs in <ul>
  t = t.replace(/((<li>.*?<\/li>\n?)+)/gs, '<ul>$1</ul>');

  // Paragraphs: split by blank lines, wrap non-block lines
  t = t.split(/\n{2,}/).map(chunk => {
    chunk = chunk.trim();
    if (!chunk) return '';
    if (/^<(h3|ul|ol|li|pre|code|blockquote)/.test(chunk)) return chunk;
    return `<p>${chunk.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  return t;
}

function _appendAgentMsg(role, htmlContent) {
  const msgs = document.getElementById('agent-messages');
  if (!msgs) return;
  msgs.querySelector('.agent-welcome')?.remove();

  const row = document.createElement('div');
  row.className = `agent-msg-row ${role}`;
  row.innerHTML = `<div class="agent-bubble">${htmlContent}</div>`;
  msgs.appendChild(row);
  msgs.scrollTop = msgs.scrollHeight;
  return row;
}

function _showTyping() {
  const msgs = document.getElementById('agent-messages');
  if (!msgs) return;
  const row = document.createElement('div');
  row.id = 'agent-typing';
  row.className = 'agent-msg-row assistant agent-typing';
  row.innerHTML = '<div class="agent-bubble"><div class="agent-typing-dots"><span></span><span></span><span></span></div></div>';
  msgs.appendChild(row);
  msgs.scrollTop = msgs.scrollHeight;
}
function _hideTyping() { document.getElementById('agent-typing')?.remove(); }

async function sendAgentMessage() {
  const input   = document.getElementById('agent-input');
  const sendBtn = document.getElementById('agent-send-btn');
  const message = input?.value.trim();
  if (!message) return;

  input.value = '';
  input.style.height = 'auto';
  input.disabled = true;
  sendBtn.disabled = true;

  _appendAgentMsg('user', esc(message));
  agentHistory.push({ role: 'user', content: message });
  _showTyping();

  try {
    const data = await api('/api/agent', {
      method: 'POST',
      body: { message, history: agentHistory.slice(-20) },
      timeout: 60000,
    });
    _hideTyping();
    _appendAgentMsg('assistant', renderAgentMarkdown(data.reply));
    agentHistory.push({ role: 'assistant', content: data.reply });
  } catch (err) {
    _hideTyping();
    const msg = err.message || 'Something went wrong. Please try again.';
    // Check if this is the "not configured" error
    if (msg.includes('not configured') || msg.includes('OPENAI_API_KEY')) _markAgentUnconfigured();
    _appendAgentMsg('assistant', `<span style="color:var(--danger)">&#9888; ${esc(msg)}</span>`);
  } finally {
    if (input)   { input.disabled = false; input.focus(); }
    if (sendBtn) sendBtn.disabled = false;
  }
}

// ===========================================================================
// PROCESS FLOWCHART  (editor powered by React Flow via flowchart-editor.mjs)
// ===========================================================================

// Toggle the flowchart expand panel for a process row (same pattern as KPI panel)
function toggleProcessFlowchartPanel(processId) {
  const panel = document.getElementById(`proc-flowchart-panel-${processId}`);
  const arrow = document.getElementById(`proc-flowchart-arrow-${processId}`);
  if (!panel) return;
  const isOpen = panel.classList.toggle('open');
  arrow.innerHTML = isOpen ? '&#9650;' : '&#9660;';
  if (isOpen) {
    if (!panel.dataset.loaded) {
      panel.dataset.loaded = '1';
      loadProcessFlowchartPanel(processId);
    }
  } else {
    // Unmount React component when panel collapses to free memory
    if (window.FlowchartEditor) window.FlowchartEditor.unmount(`proc-flowchart-canvas-${processId}`);
    panel.dataset.loaded = '';   // allow fresh mount next open
  }
}

async function loadProcessFlowchartPanel(processId) {
  const panel = document.getElementById(`proc-flowchart-panel-${processId}`);
  if (!panel) return;
  panel.innerHTML = '<div class="proc-flowchart-loading">Loading…</div>';

  // flowchart-editor.mjs loads asynchronously; wait briefly if not ready yet
  if (!window.FlowchartEditor) {
    await new Promise(r => setTimeout(r, 600));
    if (!window.FlowchartEditor) {
      panel.innerHTML = '<div class="proc-flowchart-empty">Flowchart editor unavailable – please reload the page.</div>';
      return;
    }
  }

  const items = await api('/api/architecture?arch_type=process');
  const item = items.find(i => i.id === processId);
  const flowchartData = item?.flowchart || null;

  panel.innerHTML = `<div class="proc-flowchart-canvas" id="proc-flowchart-canvas-${processId}"></div>`;

  window.FlowchartEditor.mount(
    `proc-flowchart-canvas-${processId}`,
    flowchartData,
    async (data) => {
      await api(`/api/architecture/${processId}`, {
        method: 'PUT',
        body: { flowchart: JSON.stringify(data) },
      });
    }
  );
}
