-- 0005_dashboard_fixes.sql — live feed realtime + CEO releases publish.
--
-- 1) Realtime: `supabase_realtime` existed with ZERO tables (verified live
--    2026-09-27) so every postgres_changes subscription was silent —
--    owner Live feed never received an INSERT. Add `sales`.
-- 2) Releases: only a SELECT policy existed (0003) and no Edge Fn writes
--    releases, so CEO "Publish" always hit 42501. Allow authenticated users
--    whose server-set app_metadata.role is ceo (self-registration cannot
--    mint that claim — only service_role writes app_metadata).
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'sales'
  ) then
    alter publication supabase_realtime add table public.sales;
  end if;
end $$;

create policy "ceo insert releases" on public.releases
  for insert to authenticated
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'ceo');

create policy "ceo update releases" on public.releases
  for update to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'ceo')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'ceo');

create policy "ceo delete releases" on public.releases
  for delete to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'ceo');

-- 3) Updater signature: the Releases form has always had a minisign ".sig"
--    field but the table had nowhere to put it.
alter table public.releases add column if not exists sig text not null default '';

