-- Enrolled MFA cannot be bypassed through direct REST or privileged functions.
create or replace function public.current_role() returns text language sql stable
security definer set search_path = public, auth as $$
  select coalesce((select raw_app_meta_data->>'role' from auth.users u where id=auth.uid()
    and (auth.jwt()->>'aal'='aal2' or not exists(
      select 1 from auth.mfa_factors f where f.user_id=u.id and f.status='verified'))), '')
$$;
create or replace function public.my_gym_ids() returns uuid[] language sql stable
security definer set search_path = public, auth as $$
  select coalesce((select array_agg(v::uuid) from auth.users u,
    jsonb_array_elements_text(coalesce(u.raw_app_meta_data->'gym_ids','[]'::jsonb)) v
    where u.id=auth.uid() and public.current_role() in ('owner','manager','ceo')
      and v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), '{}'::uuid[])
$$;

-- Serializes CEO changes, prevents orphaning the fleet, validates assignments,
-- and commits the audit with the change. Service-only: actor is verified by Edge.
create or replace function public.set_dashboard_access(
  p_actor uuid, p_target uuid, p_role text, p_gyms uuid[]
) returns void language plpgsql security definer set search_path=public,auth as $$
declare caller auth.users%rowtype; target auth.users%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('sls:dashboard-access'));
  select * into strict caller from auth.users where id=p_actor for update;
  if caller.raw_app_meta_data->>'role' is distinct from 'ceo' or caller.email_confirmed_at is null then
    raise exception 'Verified CEO required';
  end if;
  select * into strict target from auth.users where id=p_target for update;
  if p_role is not null and p_role not in ('ceo','owner','manager') then raise exception 'Invalid role'; end if;
  if p_role is not null and target.email_confirmed_at is null then raise exception 'Target must verify their email first'; end if;
  if p_role in ('owner','manager') and coalesce(cardinality(p_gyms),0)=0 then raise exception 'Select at least one facility'; end if;
  if exists(select 1 from unnest(p_gyms) g where not exists(select 1 from gyms where id=g)) then
    raise exception 'Unknown facility assignment';
  end if;
  if target.raw_app_meta_data->>'role'='ceo' and p_role is distinct from 'ceo'
    and not exists(select 1 from auth.users where id<>p_target and raw_app_meta_data->>'role'='ceo') then
    raise exception 'Cannot remove the last CEO';
  end if;
  update auth.users set raw_app_meta_data=coalesce(raw_app_meta_data,'{}'::jsonb)
    || jsonb_build_object('role',p_role,'gym_ids',case when p_role is null or p_role='ceo' then '{}'::uuid[] else p_gyms end,
       'dashboard_access_managed',true) where id=p_target;
  insert into audit_logs(actor,action,reason,meta) values(caller.email,'user.access',target.email,
    jsonb_build_object('user_id',p_target,'role',p_role,'gym_ids',p_gyms));
end; $$;
revoke all on function public.set_dashboard_access(uuid,uuid,text,uuid[]) from public,anon,authenticated;
grant execute on function public.set_dashboard_access(uuid,uuid,text,uuid[]) to service_role;
