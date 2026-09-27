-- SLS v3 0003: RBAC claims + Row Level Security.
-- Convention: auth.users app_metadata = { role: 'ceo'|'owner'|'manager', gym_ids: [uuid...] }.
-- CEO bypasses RLS via service_role inside Edge Functions only (never anon/authenticated).
-- Terminals sync via Edge Functions with license-token auth (service_role inside).

-- Claim helpers (STABLE so the planner caches per query)
create or replace function public.current_role() returns text
language sql stable as $$ select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') $$;

create or replace function public.my_gym_ids() returns uuid[]
language sql stable as $$
  select coalesce(
    (select array_agg((v)::uuid) from jsonb_array_elements_text(
      coalesce(auth.jwt() -> 'app_metadata' -> 'gym_ids', '[]'::jsonb)) as v),
    '{}'::uuid[])
$$;

-- Enable RLS everywhere clients touch directly
alter table gyms enable row level security;
alter table licenses enable row level security;
alter table members enable row level security;
alter table attendance enable row level security;
alter table products enable row level security;
alter table sales enable row level security;
alter table plans enable row level security;
alter table promos enable row level security;
alter table branch_overrides enable row level security;
alter table staff enable row level security;
alter table coaches enable row level security;
alter table audit_logs enable row level security;
-- releases: public read (Tauri updater manifest), CEO-only write via edge fn
alter table releases enable row level security;

-- Generic scoped policies: owners/managers see + mutate only their gyms.
-- (licenses INSERT/revoke stay in Edge Functions; policy below is read-only.)
create policy "scoped read gyms" on gyms for select to authenticated
  using (id = any (public.my_gym_ids()));
create policy "scoped read licenses" on licenses for select to authenticated
  using (gym_id = any (public.my_gym_ids()));
create policy "scoped members" on members for all to authenticated
  using (gym_id = any (public.my_gym_ids())) with check (gym_id = any (public.my_gym_ids()));
create policy "scoped attendance" on attendance for all to authenticated
  using (gym_id = any (public.my_gym_ids())) with check (gym_id = any (public.my_gym_ids()));
create policy "scoped products" on products for all to authenticated
  using (gym_id = any (public.my_gym_ids())) with check (gym_id = any (public.my_gym_ids()));
create policy "scoped sales" on sales for all to authenticated
  using (gym_id = any (public.my_gym_ids())) with check (gym_id = any (public.my_gym_ids()));
create policy "scoped plans" on plans for all to authenticated
  using (gym_id is null or gym_id = any (public.my_gym_ids()))
  with check (gym_id is null or gym_id = any (public.my_gym_ids()));
create policy "scoped promos" on promos for all to authenticated
  using (gym_id is null or gym_id = any (public.my_gym_ids()))
  with check (gym_id is null or gym_id = any (public.my_gym_ids()));
create policy "scoped overrides" on branch_overrides for all to authenticated
  using (gym_id = any (public.my_gym_ids())) with check (gym_id = any (public.my_gym_ids()));
create policy "scoped staff" on staff for all to authenticated
  using (gym_id = any (public.my_gym_ids())) with check (gym_id = any (public.my_gym_ids()));
create policy "scoped coaches" on coaches for all to authenticated
  using (gym_id = any (public.my_gym_ids())) with check (gym_id = any (public.my_gym_ids()));
create policy "scoped audit read" on audit_logs for select to authenticated
  using (gym_id is null or gym_id = any (public.my_gym_ids()));

-- Releases: anyone (incl. updater) can read; writes via service_role only.
create policy "public read releases" on releases for select to anon, authenticated using (true);

-- Denormalize perf note (see dashboard plan §8): every tenant table carries gym_id
-- directly with an index, so RLS is a single indexed comparison, no joins.
