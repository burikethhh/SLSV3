// Explicit production release operations. Keys are retrieved into memory only;
// confidential snapshots stay in a per-user ACL-restricted local directory.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const root=resolve(import.meta.dirname,'..');
const project='tlfytevjhzcgrttcdipq', base=`https://${project}.supabase.co`;
if((await readFile(join(root,'supabase/.temp/project-ref'),'utf8')).trim()!==project) throw Error('Project identity mismatch');
function cli(command) {
  try { return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{cwd:root,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024}); }
  catch { throw Error('Release CLI operation failed; private diagnostics withheld'); }
}
async function serviceKey() {
  const raw=JSON.parse(cli(`supabase projects api-keys --project-ref ${project} -o json`));
  const keys=Array.isArray(raw)?raw:Object.values(raw).find(Array.isArray);
  const key=keys?.find(k=>k.name==='service_role')?.api_key;
  if(!key) throw Error('Existing service-role key unavailable');
  return key;
}
async function request(path, key, options={}) {
  const response=await fetch(base+path,{...options,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',...options.headers}});
  if(!response.ok) throw Error(`Release request failed (${response.status}); private response withheld`);
  return response;
}
const action=process.argv[2];
if(action==='backup') {
  const folder=join(process.env.LOCALAPPDATA,'SLSReleaseBackups',`20261013-${randomUUID()}`);
  await mkdir(folder,{recursive:true});
  // Only current user and SYSTEM may read this directory on Windows.
  cli(`$taskSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; icacls '${folder.replaceAll("'","''")}' /inheritance:r /grant:r ('*'+$taskSid+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F'`);
  const tables=['gyms','licenses','members','sales','attendance','products','plans','promos','staff','branch_overrides','coaches','audit_logs','releases'];
  const query=`select jsonb_build_object(${tables.map(t=>`'${t}',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.${t} t)`).join(',')},'account_metadata',(select jsonb_agg(jsonb_build_object('id',id,'raw_app_meta_data',raw_app_meta_data)) from auth.users),'functions',(select jsonb_agg(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'),'policies',(select jsonb_agg(to_jsonb(p)) from pg_policies p where schemaname='public'),'grants',(select jsonb_agg(to_jsonb(g)) from information_schema.role_table_grants g where table_schema='public')) snapshot`;
  const result=JSON.parse(cli(`supabase db query --linked '${query.replaceAll("'","''")}'`));
  if(!result.rows?.[0]?.snapshot) throw Error('Snapshot unavailable');
  const bytes=JSON.stringify(result.rows[0].snapshot,null,2);
  await writeFile(join(folder,'pre-migration.json'),bytes,{flag:'wx'});
  console.log(JSON.stringify({backup_folder:folder,sha256:createHash('sha256').update(bytes).digest('hex'),tables:tables.length,accounts:result.rows[0].snapshot.account_metadata.length}));
} else if(action==='feed') {
  if(process.env.SLS_PUBLISH_RELEASE!=='3.0.4') throw Error('Set SLS_PUBLISH_RELEASE=3.0.4 only after release checks and artifact upload');
  const installer=join(root,'desktop/src-tauri/target/release/bundle/nsis/SLS v3_3.0.4_x64-setup.exe');
  const sig=(await readFile(installer+'.sig','utf8')).trim();
  const bytes=await readFile(installer), sha=createHash('sha256').update(bytes).digest('hex');
  const url='https://github.com/burikethhh/SLSV3/releases/download/v3.0.4/SLS.v3_3.0.4_x64-setup.exe';
  const download=await fetch(url);
  if(!download.ok || createHash('sha256').update(Buffer.from(await download.arrayBuffer())).digest('hex')!==sha) throw Error('Published installer does not match verified local artifact');
  const key=await serviceKey();
  const existing=await (await request('/rest/v1/releases?select=version&version=eq.3.0.4&channel=eq.stable',key)).json();
  if(existing.length) throw Error('3.0.4 already published; do not overwrite a released artifact');
  await request('/rest/v1/releases',key,{method:'POST',body:JSON.stringify({version:'3.0.4',channel:'stable',rollout_pct:100,download_url:url,sig,
    notes:'Account-first owner activation; 14-day trial; CEO-confirmed 30-day paid subscription; native operator sessions; backed-up legacy recovery; full roster and plan sync; complete reports. Installer SHA256 '+sha})});
  console.log('PASS published stable 3.0.4 feed with matching installer hash and signature');
} else if(action==='smoke') {
  const keys=JSON.parse(cli(`supabase projects api-keys --project-ref ${project} -o json`));
  const list=Array.isArray(keys)?keys:Object.values(keys).find(Array.isArray);
  const anon=list.find(k=>k.name==='anon').api_key;
  for(const name of ['owner-apply','license-fetch','license-issue','gym-admin','user-admin','staff-create','bootstrap-ceo']) {
    const response=await fetch(base+'/functions/v1/'+name,{method:'POST',headers:{apikey:anon,Authorization:`Bearer ${anon}`,'Content-Type':'application/json'},body:'{}'});
    if(![401,403].includes(response.status)) throw Error(`Unauthenticated ${name} returned ${response.status}`);
    console.log(`PASS unauthenticated ${name} denied (${response.status})`);
  }
  const role=await fetch(base+'/rest/v1/rpc/set_dashboard_access',{method:'POST',headers:{apikey:anon,Authorization:`Bearer ${anon}`,'Content-Type':'application/json'},
    body:JSON.stringify({p_actor:randomUUID(),p_target:randomUUID(),p_role:'ceo',p_gyms:[]})});
  if(![401,403,404].includes(role.status)) throw Error('Anonymous account-admin RPC not denied');
  console.log(`PASS anonymous account-admin RPC denied (${role.status})`);
} else throw Error('Choose backup, feed, or smoke');
