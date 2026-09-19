
// Also emitted as a standalone bundle for the public website. No app initialization.
if (document.body.dataset.website) {
  const websiteFeatures = {
    planning: { number:'01 / EXECUTION', title:'Turn a good plan into everyday progress.', description:'Turn recurring processes into clear tasks. Assign owners, track execution and keep improvement actions moving.', list:['A yearly plan with recurring tasks','Execution and evidence for each occurrence','Follow-ups with an owner and a deadline'], heading:'Operational Planning', rows:[['Review access rights','Monthly · IT','Completed','green'],['Test the continuity plan','Quarterly · Operations','In progress','lilac'],['Update policies','Annually · Quality','Planned','neutral']], footer:'Every occurrence stays connected to the plan. Even when the next period begins.' },
    risks: { number:'02 / CONTROL', title:'Make risks visible. Make controls actionable.', description:'Identify risks, assess their impact and record what you are doing about them. Connect insight to controls and accountability.', list:['Assess risks by likelihood and impact','Connect controls to requirements','See connections to processes and systems'], heading:'Risk & control', rows:[['Unauthorized access','Access management · IT','High','lilac'],['Critical supplier failure','Continuity · Procurement','Medium','neutral'],['Outdated work instructions','Quality · Operations','Low','green']], footer:'From risk to control and owner. Keep the connections visible.' },
    audits: { number:'03 / IMPROVEMENT', title:'An audit is not the finish line. It is your next step.', description:'Prepare audits, record findings and turn them into follow-up actions. Involve leadership and track how improvements progress.', list:['Plan audits and work through checklists','Record and follow up on non-conformities','Connect management reviews to actions'], heading:'Audit & improvement', rows:[['Internal information security audit','Audit planning · September','In progress','lilac'],['Complete supplier assessment','Improvement · Procurement','Open','neutral'],['Incident reporting procedure','Follow-up · Operations','Completed','green']], footer:'Findings, actions and evidence in one place. From assessment to better execution.' },
  };
  const websiteTabs = [...document.querySelectorAll('[data-feature]')];
  function selectWebsiteFeature(button) {
    const feature = websiteFeatures[button.dataset.feature];
    websiteTabs.forEach(tab => {tab.setAttribute('aria-selected', String(tab === button)); tab.tabIndex = tab === button ? 0 : -1;});
    document.querySelector('#feature-panel').setAttribute('aria-labelledby', button.id);
    document.querySelector('.feature-number').textContent = feature.number;
    for (const [id,value] of Object.entries({'feature-title':feature.title,'feature-description':feature.description,'board-heading':feature.heading,'board-footer':feature.footer})) document.getElementById(id).textContent=value;
    document.getElementById('feature-list').replaceChildren(...feature.list.map(text=>{const li=document.createElement('li');li.textContent=text;return li;}));
    document.getElementById('board-rows').replaceChildren(...feature.rows.map(([title,sub,status,color])=>{
      const row=document.createElement('div');row.className='board-row';
      const copy=document.createElement('span'),b=document.createElement('b'),small=document.createElement('small'),pill=document.createElement('span');
      b.textContent=title;small.textContent=sub;copy.append(b,small);pill.className=`pill ${color}`;pill.textContent=status;row.append(copy,pill);return row;
    }));
  }
  websiteTabs.forEach((button,index)=>{
    button.addEventListener('click',()=>selectWebsiteFeature(button));
    button.addEventListener('keydown',event=>{
      let next;
      if(event.key==='ArrowRight')next=(index+1)%websiteTabs.length;
      if(event.key==='ArrowLeft')next=(index+websiteTabs.length-1)%websiteTabs.length;
      if(event.key==='Home')next=0;if(event.key==='End')next=websiteTabs.length-1;
      if(next!==undefined){event.preventDefault();websiteTabs[next].focus();selectWebsiteFeature(websiteTabs[next]);}
    });
  });
  document.querySelector('.menu-toggle')?.addEventListener('click',event=>{
    const open=event.currentTarget.getAttribute('aria-expanded')!=='true';event.currentTarget.setAttribute('aria-expanded',String(open));event.currentTarget.setAttribute('aria-label',open?'Close menu':'Open menu');document.querySelector('.nav nav').classList.toggle('open',open);
  });
  document.querySelectorAll('.nav nav a').forEach(link=>link.addEventListener('click',()=>{document.querySelector('.nav nav').classList.remove('open');document.querySelector('.menu-toggle')?.setAttribute('aria-expanded','false');}));
  let websiteInterval=new URLSearchParams(location.search).get('interval')==='year'?'year':'month';
  const websitePrices={month:14900,year:149000};
  function renderWebsitePrice(){
    document.querySelectorAll('[data-billing]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.billing===websiteInterval)));
    const amount=document.getElementById('price');if(amount)amount.textContent=new Intl.NumberFormat('en-IE',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(websitePrices[websiteInterval]/100);
    const unit=document.getElementById('price-unit');if(unit)unit.textContent=websiteInterval==='year'?' / year':' / month';
    const note=document.getElementById('price-fine');if(note)note.textContent=websiteInterval==='year'?'Renews annually. Save €298 compared with 12 monthly payments.':'Renews monthly. Cancel before your next billing period.';
    const link=document.getElementById('pricing-cta');if(link)link.href=`/start?interval=${websiteInterval}`;
  }
  document.querySelectorAll('[data-billing]').forEach(button=>button.addEventListener('click',()=>{websiteInterval=button.dataset.billing;renderWebsitePrice();}));renderWebsitePrice();
  const year=document.getElementById('copyright-year');if(year)year.textContent=new Date().getFullYear();
  async function websiteApi(path,body){
    const csrf=document.cookie.split('; ').find(item=>item.startsWith('csrf_token='))?.slice(11);
    const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-CSRF-Token':decodeURIComponent(csrf||'')}:{},body:body?JSON.stringify(body):undefined});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'Something went wrong. Please try again later.');return data;
  }
  if(document.body.dataset.website==='start'){
    const form=document.getElementById('checkout-form'),availability=document.getElementById('availability'),fields=document.getElementById('checkout-fields'),error=document.getElementById('checkout-error');
    websiteApi('/api/commerce/catalog').then(catalog=>{
      if(!catalog.enabled){availability.textContent='Online purchasing is coming soon. Explore the platform and license in the meantime. Existing users can sign in as usual.';return;}
      availability.textContent='Your organization is activated once your payment is confirmed.';
      document.getElementById('terms-link').href=catalog.termsUrl;document.getElementById('privacy-link').href=catalog.privacyUrl;fields.disabled=false;
      if(new URLSearchParams(location.search).has('cancelled'))availability.textContent='Your checkout was cancelled. You can continue using the same details.';
    }).catch(()=>{availability.textContent='Online purchasing is currently unavailable. Please try again later.';});
    form.addEventListener('submit',async event=>{
      event.preventDefault();error.hidden=true;const button=document.getElementById('checkout-submit');button.disabled=true;button.textContent='Opening secure checkout…';
      try{const data=Object.fromEntries(new FormData(form));data.interval=websiteInterval;data.accepted=data.accepted==='on';const result=await websiteApi('/api/commerce/checkout',data);if(result.processing){location.assign('/welcome');return;}const url=new URL(result.url);if(url.protocol!=='https:'||url.hostname!=='checkout.stripe.com')throw Error('The payment page could not be opened safely.');location.assign(url.href);}
      catch(err){error.textContent=err.message;error.hidden=false;button.disabled=false;button.textContent='Continue to secure checkout ↗';}
    });
  }
  if(document.body.dataset.website==='welcome'){
    let attempts=0;const title=document.getElementById('welcome-title'),message=document.getElementById('welcome-message'),retry=document.getElementById('check-again');
    async function checkOrder(){
      retry.hidden=true;
      try{const result=await websiteApi('/api/commerce/status');
        if(result.status==='active'){title.textContent='Your organization is ready.';message.textContent='Your license is active. Sign in with the email and password you chose during checkout.';document.getElementById('welcome-console').hidden=false;return;}
        if(result.status==='unavailable'){title.textContent='No order found.';message.textContent='Open this page in the browser you used to start your purchase. Already have an account? Sign in to your organization console.';document.getElementById('welcome-console').hidden=false;return;}
        if(++attempts<20){setTimeout(checkOrder,3000);return;}
        message.textContent='Your payment has not been confirmed yet. Some payment methods take longer. You do not need to pay again; please check the status later.';
      }catch(_){message.textContent='We cannot retrieve your status right now. Please try again. You do not need to pay again.';}retry.hidden=false;
    }
    retry.addEventListener('click',()=>{attempts=0;checkOrder();});checkOrder();
  }
  if(document.body.dataset.website==='billing')document.getElementById('billing-portal').addEventListener('click',async event=>{
    const button=event.currentTarget,message=document.getElementById('billing-message');button.disabled=true;message.hidden=true;
    try{const result=await websiteApi('/api/commerce/portal',{});const url=new URL(result.url);if(url.protocol!=='https:'||url.hostname!=='billing.stripe.com')throw Error('Unable to open the billing portal safely.');location.assign(url.href);}
    catch(err){message.textContent=err.message;message.hidden=false;button.disabled=false;}
  });

}
