-- 0006_ceo_bypass.sql — close the last CEO read gaps from the audit.
--
-- 0004 added CEO read policies for most tables, but `branch_overrides` and
-- `coaches` were missed (no CEO policy at all), so a CEO querying them
-- directly via the anon key gets zero rows. Mutations stay in Edge Fns
-- (service_role); these are SELECT-only like the rest of 0004.

drop policy if exists "ceo read overrides" on branch_overrides;
create policy "ceo read overrides" on branch_overrides for select to authenticated
  using (public.current_role() = 'ceo');

drop policy if exists "ceo read coaches" on coaches;
create policy "ceo read coaches" on coaches for select to authenticated
  using (public.current_role() = 'ceo');
