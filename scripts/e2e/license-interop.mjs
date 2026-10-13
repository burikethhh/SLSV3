// Explicit signing interoperability fixture; never creates or prints a real
// subscription, never connects to Supabase, never persists the private key.
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const pem=await readFile(resolve(root,'supabase/RSA_PRIVATE_KEY_PEM.txt'),'utf8');
const code=`import {signEntitlement,makeClaims} from './supabase/functions/_shared/entitlement.ts';
const token=await signEntitlement(makeClaims({id:crypto.randomUUID(),name:'Offline signing fixture',owner_email:'fixture@example.invalid'},crypto.randomUUID(),'pro',new Date(Date.now()+86400000))); console.log(token);`;
const signed=spawnSync('deno',['eval','--no-config','--no-lock','--node-modules-dir=none',code],{cwd:root,env:{...process.env,RSA_PRIVATE_KEY_PEM:pem},encoding:'utf8',windowsHide:true});
if(signed.status!==0 || !signed.stdout.trim().startsWith('GPOS-')) throw Error('Offline signing fixture failed (private diagnostics withheld)');
const checked=spawnSync('cargo',['test','--lib','license_verify::tests::production_token_verifies_with_embedded_key','--','--ignored','--exact'],{cwd:resolve(root,'desktop/src-tauri'),env:{...process.env,TEST_LICENSE_TOKEN:signed.stdout.trim()},encoding:'utf8',windowsHide:true});
if(checked.status!==0 || !checked.stdout.includes('1 passed')) throw Error('Embedded RSA key interoperability failed; credentials withheld');
console.log('PASS offline Edge RSA-PSS fixture verifies with embedded native public key; no production writes');
