-- SLS v3 0002: dashboard gaps over 0001_init.sql.
-- Adds releases, plans, promos, branch_overrides, staff, kill flag + member lifecycle.
-- RLS: owners/managers scoped to JWT gym_ids (app_metadata.gym_ids array);
-- CEO bypasses via service_role in Edge Functions only (never anon key).

-- Kill-switch semantics: gyms.disabled = hard off (terminal must stop even with
-- valid license); licenses.revoked = key invalid. Terminal revokes when either set.
alter table gyms add column if not exists disabled boolean not null default false;

-- Member lifecycle (renew/freeze came from desktop commands in v2)
alter table members add column if not exists status text not null default 'active';
alter table members add column if not exists expires_at timestamptz;

-- Membership plans (pushed to terminals on sync)
create table if not exists plans (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid references gyms(id) on delete cascade, -- null = global template
  name text not null,
  price_cents bigint not null check (price_cents >= 0),
  duration_days int not null default 30,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_plans_gym on plans(gym_id);

-- Promo vouchers
create table if not exists promos (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid references gyms(id) on delete cascade, -- null = global
  code text not null,
  pct_off numeric not null default 0 check (pct_off >= 0 and pct_off <= 100),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_promos_gym on promos(gym_id);

-- Per-branch catalog price/stock overrides (owner portal pricing tab)
create table if not exists branch_overrides (
  product_id uuid not null references products(id) on delete cascade,
  gym_id uuid not null references gyms(id) on delete cascade,
  price_cents bigint,
  stock int,
  primary key (product_id, gym_id)
);

-- Staff / cashiers (PIN hashes via sls-core::auth Argon2id; terminal-only login)
create table if not exists staff (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references gyms(id) on delete cascade,
  full_name text not null,
  username text not null,
  pin_hash text not null,
  role text not null default 'staff' check (role in ('staff','manager','owner')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (gym_id, username)
);
create index if not exists idx_staff_gym on staff(gym_id);

-- Fleet releases (Tauri updater manifest source)
create table if not exists releases (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  channel text not null default 'stable' check (channel in ('stable','beta')),
  rollout_pct int not null default 100 check (rollout_pct >= 0 and rollout_pct <= 100),
  download_url text not null,
  notes text not null default '',
  created_at timestamptz not null default now()
);

-- MRR estimator view: active licenses x tier price (basic 99 / pro 199 / ultra 349)
create or replace view fleet_mrr as
select
  count(*) filter (where not revoked and not exists (
    select 1 from gyms g where g.id = licenses.gym_id and g.disabled)) as active_gyms,
  coalesce(sum(case
    when exists (select 1 from gyms g where g.id = licenses.gym_id and g.tier = 'basic') then 99
    when exists (select 1 from gyms g where g.id = licenses.gym_id and g.tier = 'pro') then 199
    when exists (select 1 from gyms g where g.id = licenses.gym_id and g.tier = 'ultra') then 349
    else 0 end), 0) as mrr_usd
from licenses
where not revoked and expires_at > now();
