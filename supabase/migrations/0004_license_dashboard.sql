-- SLS v3 0004: license distribution authz + accounting.
-- CEO can read all tenant rows from the dashboard (writes go through Edge Fns).
-- Owners keep gym_id-scoped access; raw_token never leaves service_role.
-- licenses/audit_logs gain queryable columns so "who got which key, when, value" works.

-- ── licenses: accounting columns (tier/price live only inside signed claims today)
alter table licenses add column if not exists tier text check (tier in ('basic','pro','ultra'));
alter table licenses add column if not exists owner_email text not null default '';
alter table licenses add column if not exists issued_by text not null default '';
alter table licenses add column if not exists price_usd int not null default 0;
alter table licenses add column if not exists days_valid int not null default 30;

-- ── audit_logs: bind actions to license + optional reason
alter table audit_logs add column if not exists license_id uuid references licenses(id) on delete set null;
alter table audit_logs add column if not exists reason text not null default '';
alter table audit_logs add column if not exists meta jsonb not null default '{}'::jsonb;

-- ── CEO read policies (bootstrap sets gym_ids=[] so owner-scoped policies match nothing)
create policy "ceo read gyms" on gyms for select to authenticated
  using (public.current_role() = 'ceo');
create policy "ceo read licenses" on licenses for select to authenticated
  using (public.current_role() = 'ceo');
create policy "ceo read members" on members for select to authenticated
  using (public.current_role() = 'ceo');
create policy "ceo read attendance" on attendance for select to authenticated
  using (public.current_role() = 'ceo');
create policy "ceo read products" on products for select to authenticated
  using (public.current_role() = 'ceo');
create policy "ceo read sales" on sales for select to authenticated
  using (public.current_role() = 'ceo');
create policy "ceo read plans" on plans for select to authenticated
  using (public.current_role() = 'ceo');
create policy "ceo read promos" on promos for select to authenticated
  using (public.current_role() = 'ceo');
create policy "ceo read staff" on staff for select to authenticated
  using (public.current_role() = 'ceo');
create policy "ceo read audit" on audit_logs for select to authenticated
  using (public.current_role() = 'ceo');

-- Owner: read own gym's audit (not other tenants; null-gym rows stay CEO/global)
drop policy if exists "scoped audit read" on audit_logs;
create policy "scoped audit read" on audit_logs for select to authenticated
  using (
    public.current_role() = 'ceo'
    or (gym_id is not null and gym_id = any (public.my_gym_ids()))
  );

-- ── Hide raw_token from browser clients (Edge Fns use service_role → bypass RLS/grants)
revoke select on licenses from anon, authenticated;
grant select (id, gym_id, revoked, expires_at, created_at, tier, owner_email, issued_by, price_usd, days_valid)
  on licenses to authenticated;
grant select on licenses to service_role;

-- ── fleet_mrr: distinct live gyms, exclude disabled, include 3-day grace, CEO/auth only
create or replace view fleet_mrr
with (security_invoker = on) as
with latest as (
  select distinct on (l.gym_id)
    l.gym_id, l.revoked, l.expires_at, l.tier as lic_tier
  from licenses l
  order by l.gym_id, l.expires_at desc
),
per_gym as (
  select
    g.id,
    g.tier,
    g.disabled,
    coalesce(la.lic_tier, g.tier) as effective_tier,
    la.revoked,
    la.expires_at
  from gyms g
  left join latest la on la.gym_id = g.id
)
select
  count(*) filter (
    where not disabled
      and coalesce(not revoked, false)
      and expires_at > now() - interval '3 days'
  ) as active_gyms,
  coalesce(sum(case
    when not disabled
      and coalesce(not revoked, false)
      and expires_at > now() - interval '3 days'
    then case effective_tier
      when 'basic' then 99
      when 'pro' then 199
      when 'ultra' then 349
      else 0
    end
    else 0
  end), 0) as mrr_usd
from per_gym;

grant select on fleet_mrr to authenticated;
revoke all on fleet_mrr from anon;
