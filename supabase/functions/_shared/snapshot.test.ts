import { readSnapshot } from "./snapshot.ts";
const assert = (condition: boolean) => { if (!condition) throw new Error("assertion failed"); };
Deno.test("snapshot returns all 1200 rows without capped roster loss", async () => {
  const rows=Array.from({length:1200},(_,i)=>({id:String(i).padStart(5,"0")}));
  const result=await readSnapshot((after,size)=>Promise.resolve({data:rows.filter(r=>after===null||r.id>after).slice(0,size),error:null}));
  assert(result.length===1200);
});
Deno.test("query failure, bound, and stuck cursor never become complete snapshots", async () => {
  for (const task of [
    ()=>readSnapshot(()=>Promise.resolve({data:null,error:"offline"})),
    ()=>readSnapshot(()=>Promise.resolve({data:Array.from({length:500},()=>({id:"same"})),error:null})),
    ()=>readSnapshot(()=>Promise.resolve({data:[{id:"x"},{id:"y"}],error:null}),1),
  ]) { let failed=false;try{await task();}catch{failed=true;}assert(failed); }
});
