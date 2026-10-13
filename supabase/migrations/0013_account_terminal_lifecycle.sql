-- Account-first onboarding and device-scoped entitlements. Apply before the
-- matching Edge Functions. Browser clients never receive signing credentials.
-- Existing JWTs must not retain facility access after a role/assignment change.
create or replace function public.current_role() returns text language sql stable
security definer set search_path = public, auth as $$
  select coalesce((select raw_app_meta_data->>'role' from auth.users where id = auth.uid()), '')
$$;
create or replace function public.my_gym_ids() returns uuid[] language sql stable
security definer set search_path = public, auth as $$
  select coalesce((select array_agg(v::uuid) from auth.users u,
    jsonb_array_elements_text(coalesce(u.raw_app_meta_data->'gym_ids', '[]'::jsonb)) v
    where u.id = auth.uid() and u.raw_app_meta_data->>'role' in ('owner','manager','ceo')
      and v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), '{}'::uuid[])
$$;
alter policy "ceo insert releases" on public.releases with check (public.current_role() = 'ceo');
alter policy "ceo update releases" on public.releases using (public.current_role() = 'ceo') with check (public.current_role() = 'ceo');
alter policy "ceo delete releases" on public.releases using (public.current_role() = 'ceo');
alter table public.gyms add column if not exists owner_user_id uuid references auth.users(id);
-- Backfill only unambiguous historical owner emails; do not guess ownership.
update public.gyms g set owner_user_id = u.id from auth.users u
where g.owner_user_id is null and lower(g.owner_email) = lower(u.email)
  and (select count(*) from auth.users x where lower(x.email) = lower(g.owner_email)) = 1;
create index if not exists gyms_owner_account on public.gyms(owner_user_id);

create table if not exists public.terminals (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  hwid text not null check (length(hwid) between 8 and 128),
  name text not null check (length(name) between 1 and 100),
  active boolean not null default true,
  registered_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique(gym_id, hwid)
);
alter table public.terminals enable row level security;
grant select on public.terminals to authenticated;
create policy "terminal inventory" on public.terminals for select to authenticated
using (public.current_role() = 'ceo' or gym_id = any(public.my_gym_ids()));

-- Trial + application + authoritative auth metadata commit together. Retries
-- serialize by user and return the original application without extending it.
create or replace function public.provision_owner_trial(
  p_user uuid, p_gym uuid, p_name text, p_location text, p_tier text,
  p_license uuid, p_token text, p_expires timestamptz
) returns uuid language plpgsql security definer set search_path = public, auth as $$
declare existing uuid; account auth.users%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('sls:owner:' || p_user::text));
  select * into strict account from auth.users where id = p_user;
  if account.email_confirmed_at is null then raise exception 'email verification required'; end if;
  if account.raw_app_meta_data->>'dashboard_access_managed' = 'true' then
    raise exception 'Account access is managed by the administrator';
  end if;
  if coalesce(account.raw_app_meta_data->>'role', '') not in ('', 'owner') then
    raise exception 'this account cannot self-register as an owner';
  end if;
  select id into existing from public.gyms where owner_user_id = p_user order by created_at limit 1;
  if existing is not null then
    -- Resume a historical half-provisioned account without resetting its trial.
    update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb)
      || jsonb_build_object('role','owner','gym_ids',case
        when coalesce(raw_app_meta_data->'gym_ids','[]'::jsonb) @> jsonb_build_array(existing)
        then coalesce(raw_app_meta_data->'gym_ids','[]'::jsonb)
        else coalesce(raw_app_meta_data->'gym_ids','[]'::jsonb) || jsonb_build_array(existing) end)
      where id = p_user;
    return existing;
  end if;
  insert into public.gyms(id,name,location,tier,status,owner_email,owner_user_id)
    values(p_gym,p_name,p_location,p_tier,'pending',account.email,p_user);
  insert into public.licenses(id,gym_id,raw_token,expires_at,tier,owner_email,issued_by,price_usd,days_valid,is_trial)
    values(p_license,p_gym,p_token,p_expires,p_tier,account.email,'system:trial',0,14,true);
  update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb)
    || jsonb_build_object('role','owner','gym_ids',
      coalesce(raw_app_meta_data->'gym_ids','[]'::jsonb) || jsonb_build_array(p_gym),
      'status','pending_approval') where id = p_user;
  insert into public.audit_logs(gym_id,actor,action,reason)
    values(p_gym,account.email,'owner.apply','Verified account: 14-day trial provisioned');
  return p_gym;
end; $$;
revoke all on function public.provision_owner_trial(uuid,uuid,text,text,text,uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function public.provision_owner_trial(uuid,uuid,text,text,text,uuid,text,timestamptz) to service_role;

-- Paid activation is distinct from application approval. The client sends the
-- previous entitlement id as an optimistic lock to prevent duplicate billing.
create or replace function public.activate_paid_subscription(
  p_gym uuid, p_previous uuid, p_license uuid, p_token text, p_tier text,
  p_expires timestamptz, p_price integer, p_actor text, p_reference text
) returns uuid language plpgsql security definer set search_path = public as $$
declare facility public.gyms%rowtype; latest uuid;
begin
  select * into strict facility from public.gyms where id = p_gym for update;
  if facility.status <> 'active' or facility.disabled then raise exception 'approve and enable facility first'; end if;
  if length(trim(p_reference)) < 3 then raise exception 'payment reference required'; end if;
  select id into latest from public.licenses where gym_id = p_gym order by created_at desc, id desc limit 1;
  if latest is distinct from p_previous then raise exception 'subscription changed; refresh before retrying'; end if;
  insert into public.licenses(id,gym_id,raw_token,expires_at,tier,owner_email,issued_by,price_usd,days_valid,is_trial)
    values(p_license,p_gym,p_token,p_expires,p_tier,facility.owner_email,p_actor,p_price,30,false);
  update public.licenses set revoked = true where gym_id = p_gym and id <> p_license;
  update public.gyms set tier = p_tier where id = p_gym;
  insert into public.audit_logs(gym_id,actor,action,license_id,reason,meta)
    values(p_gym,p_actor,'subscription.payment_confirmed',p_license,p_reference,
      jsonb_build_object('days',30,'price_usd',p_price,'expires_at',p_expires));
  return p_license;
end; $$;
revoke all on function public.activate_paid_subscription(uuid,uuid,uuid,text,text,timestamptz,integer,text,text) from public, anon, authenticated;
grant execute on function public.activate_paid_subscription(uuid,uuid,uuid,text,text,timestamptz,integer,text,text) to service_role;

-- Service-role sync bypasses RLS: enforce immutable tenant ownership in the DB
-- itself, including concurrent inserts that collide on another gym's UUID.
create or replace function public.enforce_sync_tenant() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.gym_id is distinct from old.gym_id then
    raise exception 'tenant ownership cannot change';
  end if;
  if tg_table_name = 'attendance' then
    if new.member_id is not null then
    if not exists(select 1 from public.members where id = new.member_id and gym_id = new.gym_id) then
      raise exception 'member belongs to a different facility';
    end if;
    end if;
  end if;
  return new;
end; $$;
create trigger members_immutable_tenant before update on public.members for each row execute function public.enforce_sync_tenant();
create trigger attendance_immutable_tenant before insert or update on public.attendance for each row execute function public.enforce_sync_tenant();

-- One newest entitlement per facility; historical tokens cannot resurrect a
-- revoked subscription or crowd another facility out of dashboard results.
create or replace view public.current_subscriptions with (security_invoker = on) as
select distinct on (gym_id) id,gym_id,revoked,expires_at,created_at,tier,price_usd,days_valid,is_trial
from public.licenses order by gym_id,created_at desc,id desc;
grant select on public.current_subscriptions to authenticated;

create or replace view public.fleet_mrr with (security_invoker = on) as
select
  count(*) filter (where not g.disabled and g.status <> 'rejected' and not l.revoked
    and l.expires_at >= now() - interval '3 days') as active_gyms,
  coalesce(sum(case when not g.disabled and g.status = 'active' and not l.revoked
    and not l.is_trial and l.expires_at >= now() - interval '3 days'
    then l.price_usd else 0 end),0) as mrr_usd
from public.gyms g left join public.current_subscriptions l on l.gym_id = g.id;
