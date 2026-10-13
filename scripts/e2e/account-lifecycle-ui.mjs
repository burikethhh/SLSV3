import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const output = process.env.SLS_UI_ARTIFACTS || join(tmpdir(), 'sls-account-ui-' + Date.now());
await mkdir(output, { recursive: true });
const chrome = spawn(process.env.SLS_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--remote-debugging-port=9347', `--user-data-dir=${join(output, 'browser-profile')}`,
  '--no-first-run', '--disable-background-networking', '--disable-extensions', '--mute-audio',
], { windowsHide: true, stdio: 'ignore' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;
for (let i = 0; i < 40; i++) {
  try { browser = await (await fetch('http://127.0.0.1:9347/json/version')).json(); break; } catch { await sleep(250); }
}
if (!browser) throw new Error('Headless browser did not start');
const ws = new WebSocket(browser.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let sequence = 0;
const pending = new Map();
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const p = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) p?.reject(new Error(JSON.stringify(message.error)));
    else p?.resolve(message.result);
  }
};
function send(method, params = {}, sessionId) {
  const id = ++sequence;
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return promise;
}
async function tab(url, source = '', width = 1280, height = 800) {
  const { browserContextId } = await send('Target.createBrowserContext');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 }, sessionId);
  if (source) await send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);
  await send('Page.navigate', { url }, sessionId);
  await sleep(2400);
  return sessionId;
}
async function evaluate(sessionId, expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function capture(sessionId, name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  await writeFile(join(output, name + '.png'), Buffer.from(data, 'base64'));
}

let tests = 0;
const pass = name => { tests++; console.log('PASS ' + name); };
const gym = '550e8400-e29b-41d4-a716-446655440000';
const native = active => `
window.__native_calls = [];
window.__account = {signed_in:${active},gym_id:${active ? "'550e8400-e29b-41d4-a716-446655440000'" : 'null'},
  email:'owner@example.invalid',gyms:[{id:'550e8400-e29b-41d4-a716-446655440000',name:'Fixture Gym'}],
  online:true,pending_uploads:0,operator:${active ? "{role:'manager',username:'Fixture manager',seconds_remaining:900}" : "null"},license:${active ? "{type:'Valid',tier:'pro',days_remaining:14}" : "{type:'Unlicensed'}"},message:'Fixture connection'};
window.__TAURI__ = {core:{invoke:async (name,args) => {
  window.__native_calls.push(name);
  if (name === 'account_status') return structuredClone(window.__account);
  if (name === 'account_sign_in') {window.__account.signed_in=true; window.__account.email=args.email; return window.__account;}
  if (name === 'hw_status') return {connected:false,feature:true};
  if (name === 'license_status') return window.__account.license;
  if (name === 'settings_lock_state') return false;
  if (name === 'settings_get') return null;
  if (name === 'sync_pending') return 0;
  if (name === 'sales_summary') return {total_cents:0,count:0};
  if (name === 'plans_list') return [{id:'plan',name:'Monthly',duration_days:30,price_cents:15000}];
  if (name === 'product_search') return [{id:'water',name:'Water',price_cents:5000,stock:10}];
  if (['attendance_list','hw_poll_buttons','member_search','sale_list'].includes(name)) return [];
  return null;
}}};
const originalFetch=fetch.bind(window);
window.fetch=(input,options)=>{const url=input instanceof Request?input.url:String(input);if(url.includes('.supabase.co'))throw Error('Unexpected live network request');return originalFetch(input,options)};
`;
const cloud = (role, release = null) => `
window.__cloud_calls=[];
const fixtureGym='550e8400-e29b-41d4-a716-446655440000';
let fixtureUser={id:'550e8400-e29b-41d4-a716-446655440001',email:'owner@example.invalid',app_metadata:{role:'${role}',gym_ids:['550e8400-e29b-41d4-a716-446655440000']},user_metadata:{onboarding:{gym_name:'Fixture Gym',location:'Test branch',tier:'pro'}}};
let fixtureAal='aal1';
if('${role}'==='mfa'){fixtureUser.app_metadata.role='owner';fixtureUser.factors=[{id:'550e8400-e29b-41d4-a716-446655440003',factor_type:'totp',status:'verified',friendly_name:'Fixture authenticator'}];}
const fixtureSession=()=>({access_token:'eyJhbGciOiJIUzI1NiJ9.'+btoa(JSON.stringify({exp:2000000000,aal:fixtureAal})).replaceAll('=','')+'.fixture',refresh_token:'fixture-refresh',expires_at:2000000000,expires_in:3600,token_type:'bearer',user:fixtureUser});
if('${role}'!=='signup') {if('${role}'==='unprovisioned')fixtureUser.app_metadata={};localStorage.setItem('sb-tlfytevjhzcgrttcdipq-auth-token',JSON.stringify(fixtureSession()));}
const originalFetch=fetch.bind(window);
window.fetch=async(input,options)=>{
 const url=input instanceof Request?input.url:String(input);
 if(!url.includes('.supabase.co'))return originalFetch(input,options);
 const path=new URL(url).pathname;const method=options?.method||(input instanceof Request?input.method:'GET');
 const payload=options?.body?JSON.parse(options.body):null;window.__cloud_calls.push({path,payload});
 let data=[];
 if(path.endsWith('/signup'))data={user:fixtureUser,session:null};
 if(path.endsWith('/token')) {fixtureUser.app_metadata={role:'owner',gym_ids:[fixtureGym]};data=fixtureSession();}
 if(path.endsWith('/user'))data=fixtureUser;
 if(path.endsWith('/challenge'))data={id:'fixture-challenge',expires_at:2000000000};
 if(path.endsWith('/verify')){fixtureAal='aal2';data=fixtureSession();}
 if(path.endsWith('/owner-apply'))data={ok:true,gym_id:fixtureGym};
 if(path.endsWith('/gyms'))data=[{id:fixtureGym,name:'Fixture Gym',tier:'pro',status:'pending',disabled:false}];
 if(path.endsWith('/licenses')||path.endsWith('/current_subscriptions'))data=[{id:'550e8400-e29b-41d4-a716-446655440002',gym_id:fixtureGym,tier:'pro',expires_at:'2026-01-01T00:00:00Z',is_trial:true,revoked:false}];
 if(path.endsWith('/terminals'))data=[];
 if(path.endsWith('/releases'))data=${JSON.stringify(release)};
 if(path.endsWith('/fleet_mrr'))data={active_gyms:1,mrr_usd:0};
 if(path.endsWith('/user-admin'))data={users:[]};
 if(path.endsWith('/owner_report'))data={month_revenue_cents:15000,today_revenue_cents:15000,today_transactions:600,active_members:700,checkins:900,exits:100,daily:[],top_products:[],hourly:[],branches:[]};
 return new Response(method==='HEAD'?null:JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json','Content-Range':'0-0/0'}});
};
`;
try {
  const desktop = await tab('http://127.0.0.1:5187/',native(false));
  assert.equal(await evaluate(desktop,"document.getElementById('view-connection').hidden"),false);
  assert.equal(await evaluate(desktop,"document.getElementById('hdr-unlock').disabled"),true);
  await evaluate(desktop,"document.querySelector('[data-view=pos]').click()");
  assert.equal(await evaluate(desktop,"window.__native_calls.includes('product_search')"),false);
  assert.equal(await evaluate(desktop,"!!document.getElementById('set-token')"),false);
  await capture(desktop,'gympos-first-run');
  pass('unlicensed startup blocks navigation and operations without a key form');
  await evaluate(desktop,`document.getElementById('connection-email').value='owner@example.invalid';document.getElementById('connection-password').value='Synthetic-password ';document.getElementById('connection-login').requestSubmit()`);
  await sleep(700);
  assert.equal(await evaluate(desktop,"document.getElementById('connection-gym').options[0].text"),'Fixture Gym');
  pass('owner sign-in leads to named facility and terminal selection');
  const enabled = await tab('http://127.0.0.1:5187/',native(true));
  assert.equal(await evaluate(enabled,"document.getElementById('hdr-unlock').disabled"),false);
  assert.match(await evaluate(enabled,"document.getElementById('hdr-license').textContent"),/PRO/);
  await evaluate(enabled,"window.__account.license={type:'Expired'};window.__sls_refresh_state()");
  assert.equal(await evaluate(enabled,"document.getElementById('hdr-unlock').disabled"),true);
  assert.equal(await evaluate(enabled,"document.getElementById('view-connection').hidden"),false);
  pass('running terminal locks on expiry and retains connection/help access');
  const cashier=await tab('http://127.0.0.1:5187/',native(true));
  await evaluate(cashier,"window.__account.operator={role:'staff',username:'Cashier'};window.__sls_refresh_state()");
  assert.equal(await evaluate(cashier,"document.getElementById('hdr-unlock').disabled"),true);
  pass('cashier license access does not expose manager manual unlock');
  await evaluate(cashier,"document.querySelector('[data-view=members]').click()");
  await sleep(500);
  assert.match(await evaluate(cashier,"document.getElementById('mem-plan').innerText"),/Monthly/);
  pass('member enrollment presents synced plan and peso price');
  const noBridge=await tab('http://127.0.0.1:5187/');
  assert.equal(await evaluate(noBridge,"document.getElementById('hdr-unlock').disabled"),true);
  assert.match(await evaluate(noBridge,"document.getElementById('view-connection').innerText"),/Desktop connection unavailable/);
  pass('missing native bridge cannot simulate activation');
  const registration=await tab('http://127.0.0.1:5177/#/register',cloud('signup'));
  await evaluate(registration,`document.getElementById('em').value='new@example.invalid';document.getElementById('pw').value='Synthetic-pass ';document.getElementById('reg-gym').value='<img src=x onerror=alert(1)>';document.getElementById('reg-loc').value='Test branch';document.getElementById('register-form').requestSubmit()`);
  await sleep(600);
  const signup=await evaluate(registration,"window.__cloud_calls");
  assert.equal(signup.filter(call=>call.path.endsWith('/signup')).length,1);
  assert.equal(signup.some(call=>call.path.endsWith('/token')||call.path.endsWith('/owner-apply')),false);
  assert.equal(signup[0].payload.password,'Synthetic-pass ');
  assert.equal(signup[0].payload.data.onboarding.gym_name,'<img src=x onerror=alert(1)>');
  assert.match(await evaluate(registration,"document.getElementById('login-msg').textContent"),/details are saved/);
  await capture(registration,'web-verification-next-step');
  pass('confirmation signup saves gym draft, preserves password, and never attempts immediate login');
  const setup=await tab('http://127.0.0.1:5177/#/setup',cloud('unprovisioned'));
  assert.equal(await evaluate(setup,"window.__cloud_calls.filter(call=>call.path.endsWith('/owner-apply')).length"),1);
  assert.equal(await evaluate(setup,"location.hash"),'#/owner/start');
  await capture(setup,'web-get-started');
  pass('verified account resumes setup and reaches Get Started automatically');
  const oldDownload=await tab('http://127.0.0.1:5177/#/owner/start',cloud('owner',{version:'3.0.3',download_url:'https://example.invalid/old-installer.exe'}));
  assert.equal(await evaluate(oldDownload,"!!document.querySelector('a[href=\"https://example.invalid/old-installer.exe\"]')"),false);
  const newDownload=await tab('http://127.0.0.1:5177/#/owner/start',cloud('owner',{version:'3.0.4',download_url:'https://example.invalid/account-installer.exe'}));
  assert.equal(await evaluate(newDownload,"!!document.querySelector('a[href=\"https://example.invalid/account-installer.exe\"]')"),true);
  pass('account setup rejects old installers and accepts the matching release');
  const owner=await tab('http://127.0.0.1:5177/#/owner/keys',cloud('owner'));
  assert.match(await evaluate(owner,"document.getElementById('view').innerText"),/Expired/);
  assert.equal(await evaluate(owner,"document.getElementById('view').innerText.includes('TRIAL ACTIVE')"),false);
  await capture(owner,'web-owner-subscription');
  pass('pending application does not mislabel an expired trial as active');
  const ceo=await tab('http://127.0.0.1:5177/#/ceo/keys',cloud('ceo'));
  assert.equal(await evaluate(ceo,"!!document.getElementById('payment-reference')"),true);
  assert.equal(await evaluate(ceo,"window.__cloud_calls.some(call=>call.path.endsWith('/user-admin'))"),false);
  assert.equal(await evaluate(ceo,"!!document.getElementById('show-once')"),false);
  await capture(ceo,'web-ceo-subscriptions');
  pass('CEO subscription route requires payment proof without loading hidden account sections');
  const accounts=await tab('http://127.0.0.1:5177/#/ceo/users',cloud('ceo'));
  assert.match(await evaluate(accounts,"document.getElementById('ugyms').innerText"),/Fixture Gym/);
  assert.equal(await evaluate(accounts,"document.querySelector('#ugyms input').type"),'checkbox');
  await capture(accounts,'web-ceo-named-assignments');
  pass('CEO account assignment uses named facility checkboxes, not UUID text');
  const manager=await tab('http://127.0.0.1:5177/#/owner/staff',cloud('manager'));
  assert.equal(await evaluate(manager,"document.getElementById('add').disabled"),true);
  assert.equal(await evaluate(manager,"document.getElementById('pin').type"),'password');
  pass('dashboard manager cannot create staff credentials and PIN entry is masked');
  const mfa=await tab('http://127.0.0.1:5177/#/owner/keys',cloud('mfa'));
  assert.equal(await evaluate(mfa,"!!document.getElementById('mfa-code')"),true);
  assert.equal(await evaluate(mfa,"window.__cloud_calls.some(call=>call.path.endsWith('/gyms'))"),false);
  await evaluate(mfa,"document.getElementById('mfa-code').value='123456';document.getElementById('mfa-form').requestSubmit()");
  await sleep(650);
  assert.equal(await evaluate(mfa,"!!document.getElementById('mfa-code')"),false);
  pass('enrolled MFA blocks dashboard data until a challenge is verified');
  const mobile=await tab('http://127.0.0.1:5177/#/register',cloud('signup'),390,844);
  assert.equal(await evaluate(mobile,"document.documentElement.scrollWidth<=innerWidth"),true);
  await capture(mobile,'web-mobile-registration');
  pass('registration fits mobile viewport');
  console.log(tests+' synthetic UI scenarios passed; artifacts: '+output);
} catch(error) { console.error('UI scenario failed: '+error.message);process.exitCode=1; }
finally { await send('Browser.close').catch(()=>{});ws.close();chrome.kill(); }
