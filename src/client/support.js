// Platform support is separate from tenant records; server checks superadmin access.
let supportNextPage = null;
let supportLoadSequence = 0;
function renderSupportTicketsPanel() {
  return `<section class="support-panel" aria-labelledby="support-heading"><div class="support-heading"><div><h2 id="support-heading">Contact & support tickets</h2><p id="support-counts">Website messages · written support</p></div><div class="support-toolbar"><label for="support-filter">Status</label><select id="support-filter" onchange="loadMSPSupportTickets()"><option value="open">Open</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option><option value="all">All</option></select><button type="button" onclick="loadMSPSupportTickets()">Refresh</button></div></div><p class="support-hint">Internal notes stay private. “Reply by email” opens your email app; saving a ticket does not send a reply. The public form does not promise immediate or 24/7 support.</p><div id="support-tickets" role="status">Loading tickets…</div><div class="support-toolbar"><button type="button" id="support-first" hidden onclick="loadMSPSupportTickets()">Newest tickets</button><button type="button" id="support-next" hidden onclick="loadMSPSupportTickets(supportNextPage)">Older tickets →</button></div></section>`;
}
async function loadMSPSupportTickets(before = null) {
  const container=document.getElementById('support-tickets');
  if (!container) return;
  const sequence=++supportLoadSequence;
  container.textContent='Loading tickets…';
  document.getElementById('support-next').hidden=true;
  try {
    const filter=document.getElementById('support-filter').value;
    const data=await api('/api/msp/support-tickets?status='+encodeURIComponent(filter)+(before ? '&before='+before : ''));
    if (sequence!==supportLoadSequence || !container.isConnected) return;
    document.getElementById('support-counts').textContent=['open','in_progress','resolved'].map(status => `${data.counts.find(c=>c.status===status)?.count || 0} ${status.replace('_',' ')}`).join(' · ');
    container.innerHTML=data.tickets.length ? data.tickets.map(ticket=>`<details class="support-ticket"><summary><span class="support-ticket-title">${esc(ticket.subject)}</span><span>${esc(ticket.topic)} · ${esc(ticket.status.replace('_',' '))}</span><time>${esc(new Date(ticket.created_at).toLocaleDateString())}</time></summary><div class="support-ticket-body"><p><strong>${esc(ticket.name || 'Visitor')}</strong> · ${esc(ticket.email)}${ticket.organization ? ' · '+esc(ticket.organization) : ''}</p><p class="support-reference">BOP-${esc(ticket.reference)}</p><div class="support-message">${esc(ticket.message)}</div><a class="btn btn-secondary" href="${esc('mailto:'+encodeURIComponent(ticket.email)+'?subject='+encodeURIComponent('Re: '+ticket.subject+' [BOP-'+ticket.reference+']'))}">Reply by email ↗</a><form onsubmit="saveMSPSupportTicket(event,${ticket.id},${ticket.revision})"><label for="ticket-status-${ticket.id}">Status</label><select name="status" id="ticket-status-${ticket.id}">${['open','in_progress','resolved'].map(s=>`<option value="${s}"${s===ticket.status?' selected':''}>${esc(s.replace('_',' '))}</option>`).join('')}</select><label for="ticket-notes-${ticket.id}">Internal notes · not sent to the visitor</label><textarea name="internal_notes" id="ticket-notes-${ticket.id}" rows="3" maxlength="10000">${esc(ticket.internal_notes)}</textarea><button type="submit" class="btn btn-primary">Save ticket</button><span role="status" class="support-save-status"></span></form></div></details>`).join('') : '<p>No tickets in this view.</p>';
    supportNextPage=data.next;
    document.getElementById('support-next').hidden=!data.next;
    document.getElementById('support-first').hidden=!before;
  } catch(error) {if(sequence===supportLoadSequence) container.textContent='Could not load tickets: '+error.message;}
}
async function saveMSPSupportTicket(event,id,revision) {
  event.preventDefault();const form=event.target;const button=form.querySelector('button');const message=form.querySelector('.support-save-status');
  button.disabled=true;message.textContent='Saving…';
  try {
    const values=Object.fromEntries(new FormData(form));
    const result=await api('/api/msp/support-tickets/'+id,{method:'PATCH',body:{...values,revision}});
    form.onsubmit=e=>saveMSPSupportTicket(e,id,result.revision);
    const ticket=form.closest('details');ticket.querySelector('summary span:nth-child(2)').textContent=ticket.querySelector('summary span:nth-child(2)').textContent.split(' · ')[0]+' · '+values.status.replace('_',' ');
    message.textContent='Saved. No email was sent.';
    // Counts and filtering update on explicit refresh, preserving unsaved work in other tickets.
  } catch(error) {message.textContent=error.message;}
  finally {button.disabled=false;}
}
