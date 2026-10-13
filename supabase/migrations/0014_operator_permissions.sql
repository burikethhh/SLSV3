-- Managers may operate memberships, not administer credentials or accounting.
-- Explicit column grants matter: a table SELECT grant cannot hide PIN hashes.
create or replace function public.enforce_sync_tenant() returns trigger
language plpgsql set search_path=public as $$ begin
  if tg_op='UPDATE' and new.gym_id is distinct from old.gym_id then raise exception 'tenant ownership cannot change'; end if;
  if tg_table_name='attendance' then
    if new.member_id is not null then
      if not exists(select 1 from public.members where id=new.member_id and gym_id=new.gym_id) then
        raise exception 'member belongs to a different facility';
      end if;
    end if;
  end if;
  return new;
end; $$;
revoke all on public.staff from anon, authenticated;
grant select(id,gym_id,full_name,username,role,active,created_at), update(active) on public.staff to authenticated;
drop policy if exists "scoped staff" on public.staff;
create policy "assigned staff inventory" on public.staff for select to authenticated
using (gym_id = any(public.my_gym_ids()));
create policy "owner staff activation" on public.staff for update to authenticated
using (public.current_role()='owner' and gym_id=any(public.my_gym_ids()))
with check (public.current_role()='owner' and gym_id=any(public.my_gym_ids()));

-- Transaction contents are immutable from the dashboard. Accounting status
-- changes are owner-only, attributable, and never change terminal stock twice.
revoke insert,update,delete,truncate on public.sales from anon, authenticated;
grant select,update(status) on public.sales to authenticated;
drop policy if exists "scoped sales" on public.sales;
create policy "assigned sales read" on public.sales for select to authenticated
using (gym_id=any(public.my_gym_ids()));
create policy "owner accounting status" on public.sales for update to authenticated
using (public.current_role()='owner' and gym_id=any(public.my_gym_ids()))
with check (public.current_role()='owner' and gym_id=any(public.my_gym_ids()));
revoke insert,update,delete,truncate on public.attendance from anon, authenticated;
grant select on public.attendance to authenticated;
drop policy if exists "scoped attendance" on public.attendance;
create policy "assigned attendance read" on public.attendance for select to authenticated
using (gym_id=any(public.my_gym_ids()));

do $$ declare table_name text; policy_row record; begin
  foreach table_name in array array['products','plans','promos','branch_overrides','coaches'] loop
    -- Replace historical owner/manager ALL and write policies; retain CEO and
    -- global-template SELECT policies. CEO write policies stay CEO-only.
    for policy_row in select policyname from pg_policies where schemaname='public'
      and tablename=table_name and policyname in
      ('scoped products','scoped overrides','scoped coaches','owner plans write','owner plans update','owner plans delete',
       'owner promos write','owner promos update','owner promos delete') loop
      execute format('drop policy %I on public.%I',policy_row.policyname,table_name);
    end loop;
    execute format('create policy "assigned inventory read" on public.%I for select to authenticated using (gym_id=any(public.my_gym_ids()))',table_name);
    execute format('create policy "owner inventory insert" on public.%I for insert to authenticated with check (public.current_role()=''owner'' and gym_id=any(public.my_gym_ids()))',table_name);
    execute format('create policy "owner inventory update" on public.%I for update to authenticated using (public.current_role()=''owner'' and gym_id=any(public.my_gym_ids())) with check (public.current_role()=''owner'' and gym_id=any(public.my_gym_ids()))',table_name);
    execute format('create policy "owner inventory delete" on public.%I for delete to authenticated using (public.current_role()=''owner'' and gym_id=any(public.my_gym_ids()))',table_name);
    execute format('create trigger immutable_tenant before update on public.%I for each row execute function public.enforce_sync_tenant()',table_name);
  end loop;
end $$;

create or replace function public.audit_sale_status() returns trigger
language plpgsql security definer set search_path=public,auth as $$
begin
  if new.status is distinct from old.status then
    insert into public.audit_logs(gym_id,actor,action,reason,meta)
    values(new.gym_id,coalesce(auth.uid()::text,'service'),'sale.status_changed',old.status||' -> '||new.status,
      jsonb_build_object('sale_id',new.id,'total_cents',new.total_cents));
  end if;
  return new;
end; $$;
create trigger sale_status_audit after update of status on public.sales
for each row execute function public.audit_sale_status();

create or replace function public.touch_member_sync_time() returns trigger
language plpgsql set search_path=public as $$ begin new.updated_at=clock_timestamp(); return new; end; $$;
create trigger member_sync_time before update on public.members for each row execute function public.touch_member_sync_time();

-- Biometric vectors are native/service-only. Dashboard lifecycle changes do
-- not replace recognition credentials or reassign tenant ownership.
revoke all on public.members from anon,authenticated;
grant select(id,gym_id,full_name,embedding_dim,created_at,updated_at,deleted_at,status,expires_at),
  insert(id,gym_id,full_name,status,expires_at),update(full_name,status,expires_at,deleted_at) on public.members to authenticated;
grant all on public.members to service_role;
create or replace function public.sync_member_enrollment(p_gym uuid,p_member uuid,p_name text,p_vector jsonb,p_expires timestamptz)
returns void language sql security definer set search_path=public as $$
  insert into public.members(id,gym_id,full_name,embedding_dim,face_vector,expires_at)
  values(p_member,p_gym,p_name,512,p_vector,p_expires)
  on conflict(id) do update set gym_id=excluded.gym_id,full_name=excluded.full_name,face_vector=excluded.face_vector,embedding_dim=512;
$$;
revoke all on function public.sync_member_enrollment(uuid,uuid,text,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.sync_member_enrollment(uuid,uuid,text,jsonb,timestamptz) to service_role;
