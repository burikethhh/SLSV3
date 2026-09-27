-- SLS v3 single source of truth. Supabase Postgres.
-- Local SQLite mirrors these table names (see desktop/src-tauri/src/db.rs).
-- Multi-tenant via gym_id; RLS enforced per gym (policies below use JWT app_metadata gym_id).

-- Gyms / licensing (Key Vault)
create table if not exists gyms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tier text not null check (tier in ('basic','pro','ultra')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists licenses (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references gyms(id) on delete cascade,
  raw_token text not null,
  revoked boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_licenses_gym on licenses(gym_id);

-- People (face vectors stored anonymized; 512-d EdgeFace; legacy 128-d accepted)
create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references gyms(id) on delete cascade,
  full_name text not null,
  embedding_dim smallint not null default 512,
  face_vector jsonb, -- normalized float array
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists idx_members_gym on members(gym_id);

-- Single-camera gate: direction always 'in'
create table if not exists attendance (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references gyms(id) on delete cascade,
  member_id uuid references members(id) on delete set null,
  direction text not null default 'in' check (direction = 'in'),
  confidence real,
  created_at timestamptz not null default now()
);
create index if not exists idx_attendance_gym_time on attendance(gym_id, created_at desc);

-- Catalog / sales (money = integer cents)
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references gyms(id) on delete cascade,
  name text not null,
  price_cents bigint not null check (price_cents >= 0),
  stock int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_products_gym_name on products(gym_id, name);

create table if not exists sales (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references gyms(id) on delete cascade,
  items jsonb not null, -- [{product_id, qty, unit_cents}]
  total_cents bigint not null,
  pay_method text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_sales_gym_time on sales(gym_id, created_at desc);

-- Coaches + audit
create table if not exists coaches (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references gyms(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id bigint generated always as identity primary key,
  gym_id uuid references gyms(id) on delete cascade,
  actor text not null,
  action text not null,
  created_at timestamptz not null default now()
);
