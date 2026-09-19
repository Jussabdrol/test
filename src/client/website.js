// Public website only; also bundled with the console by the shared manifest.
(() => {
  if (!document.body.dataset.website) return;
  const $ = id => document.getElementById(id);
  const menu = document.querySelector('.menu-toggle');
  menu?.addEventListener('click', () => {
    const open = menu.getAttribute('aria-expanded') !== 'true';
    menu.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    $('site-nav').classList.toggle('open', open);
  });
  if ($('copyright-year')) $('copyright-year').textContent = new Date().getFullYear();
  function billing(interval) {
    const annual = interval === 'year';
    document.querySelectorAll('[data-billing]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.billing === interval)));
    if (!$('price')) return;
    $('price').textContent = annual ? '€1,490' : '€149';
    $('price-unit').textContent = annual ? '/ year' : '/ month';
    $('price-fine').textContent = annual ? 'Planned annual billing. Save €298 compared with 12 monthly payments. Excluding VAT.' : 'Planned monthly billing. Excluding VAT.';
    if ($('pricing-cta')) $('pricing-cta').href = '/start?interval=' + interval;
  }
  document.querySelectorAll('[data-billing]').forEach(b => b.addEventListener('click', () => billing(b.dataset.billing)));
  if (new URLSearchParams(location.search).get('interval') === 'year') billing('year');
  const steps = [
    {number:'01 / UNDERSTAND',title:'Start with the risk.',description:'An old account may still have access to a system. Record the risk and connect it to an access management process and a treatment.',items:['Record likelihood and impact','Link a treatment and requirement','Keep the process in view'],type:'RISK REGISTER',record:'Unnecessary system access',copy:'Accounts retain access after responsibilities change.',fields:[['Process','Access management'],['Risk owner','IT owner'],['Treatment','Review access regularly']],link:'Connected to → Access review',guide:'first-workspace'},
    {number:'02 / ASSIGN',title:'Make the work repeatable.',description:'Create a recurring access review task, assign responsibility and give the next occurrence a due date. The yearly plan keeps the recurring work visible.',items:['Define the task and recurrence','Assign an owner','Work from the yearly plan or My Tasks'],type:'RECURRING TASK',record:'Review system access',copy:'Check current accounts against the people and responsibilities in your team.',fields:[['Owner','IT owner'],['Recurrence','Quarterly'],['Due','30 September · example']],link:'Connected to → Access management',guide:'recurring-work'},
    {number:'03 / RECORD',title:'Keep evidence with the work.',description:'Complete the occurrence with a record of what was checked. Add relevant evidence to the task instance so it can be reviewed later.',items:['Record the result','Attach relevant evidence','Keep a history of completed occurrences'],type:'TASK INSTANCE',record:'Quarterly access review',copy:'Example result: two outdated accounts identified and removed.',fields:[['Status','Completed'],['Record','Accounts checked'],['Evidence','Access-review.pdf · example']],link:'Connected to → Review system access',guide:'recurring-work'},
    {number:'04 / IMPROVE',title:'Review. Follow up. Repeat.',description:'Use audit findings, non-conformities and follow-up actions to improve your management system. Keep the evidence and the next action connected.',items:['Record findings during an audit','Create follow-up actions','Review progress with your team'],type:'AUDIT FOLLOW-UP',record:'Improve account offboarding',copy:'Example finding: account closure needs a clearer owner and completion check.',fields:[['Owner','Operations owner'],['Action','Update offboarding checklist'],['Status','In progress']],link:'Connected to → Access management',guide:'audit-preparation'}
  ];
  let step = 0;
  function showStep(index, focus = false) {
    step = index;
    const data = steps[index];
    document.querySelectorAll('[data-tour]').forEach(b => {
      const selected = Number(b.dataset.tour) === index;
      b.setAttribute('aria-selected', String(selected)); b.tabIndex = selected ? 0 : -1;
      if (selected && focus) b.focus();
    });
    $('tour-panel').setAttribute('aria-labelledby', 'tour-tab-' + index);
    for (const [id,value] of Object.entries({'tour-number':data.number,'tour-title':data.title,'tour-description':data.description,'record-type':data.type,'record-title':data.record,'record-copy':data.copy,'record-link':data.link})) $(id).textContent = value;
    $('tour-list').replaceChildren(...data.items.map(text => {const li=document.createElement('li');li.textContent=text;return li;}));
    $('record-fields').replaceChildren(...data.fields.map(([label,value]) => {const row=document.createElement('div');const dt=document.createElement('dt');const dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;row.append(dt,dd);return row;}));
    $('tour-guide').href = '/guides#' + data.guide;
    $('tour-prev').disabled = index === 0;
    $('tour-next').textContent = ['Next: task →','Next: evidence →','Next: review →','Start again ↻'][index];
    $('tour-progress').textContent = `Step ${index+1} of 4`;
  }
  document.querySelectorAll('[data-tour]').forEach(b => {
    b.addEventListener('click', () => showStep(Number(b.dataset.tour)));
    b.addEventListener('keydown', e => {
      if (!['ArrowRight','ArrowLeft','Home','End'].includes(e.key)) return;
      e.preventDefault();showStep(e.key === 'Home' ? 0 : e.key === 'End' ? 3 : (step + (e.key === 'ArrowRight' ? 1 : 3)) % 4, true);
    });
  });
  $('tour-next')?.addEventListener('click', () => showStep((step+1)%4));
  $('tour-prev')?.addEventListener('click', () => showStep(Math.max(0,step-1)));
  const form = $('support-form');
  if (!form) return;
  const hints = {product:'The guides explain setup, tasks and audit workflows.',technical:'Include the page, steps to reproduce, expected result and what happened.',account:'Include your organization name. Never send passwords or payment details.',privacy:'Describe your security or privacy concern without including secrets or customer records.',feedback:'Describe the problem you want to solve and how it affects your workflow.'};
  const topic = new URLSearchParams(location.search).get('topic');
  if (Object.hasOwn(hints, topic)) $('support-topic').value = topic;
  const updateHint = () => {$('topic-help').textContent=hints[$('support-topic').value];};
  $('support-topic').addEventListener('change',updateHint);updateHint();
  let submissionId, previousPayload;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const body = Object.fromEntries(new FormData(form));
    const serialized = JSON.stringify(body);
    if (serialized !== previousPayload) {submissionId=crypto.randomUUID();previousPayload=serialized;}
    body.submission_id=submissionId;
    $('support-submit').disabled=true;$('support-submit').textContent='Sending…';$('support-error').hidden=true;
    try {
      const csrf = document.cookie.split('; ').find(c=>c.startsWith('csrf_token='));
      const response = await fetch('/api/support/tickets',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf ? decodeURIComponent(csrf.slice(11)) : ''},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
      const result = await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(result.error || 'Your message could not be sent. Please try again.');
      if (!result.reference) throw new Error('No ticket confirmation received. Please try again.');
      $('ticket-reference').textContent=result.reference;form.hidden=true;$('support-success').hidden=false;$('support-success').focus();
    } catch(error) {
      $('support-error').textContent = error.name === 'TimeoutError' ? 'No confirmation received yet. Try again; the same message will not create a duplicate ticket.' : (error.message === 'Failed to fetch' ? 'Connection interrupted. Please try again.' : error.message);
      $('support-error').hidden=false;
    } finally {$('support-submit').disabled=false;$('support-submit').textContent='Send message ↗';}
  });
})();
