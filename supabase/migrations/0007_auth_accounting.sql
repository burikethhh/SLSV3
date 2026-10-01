-- 0007_auth_accounting.sql — auth + accounting hardening from the audit.
--
-- 1) Sales: status (sale/refund/void) instead of deletes, allowlisted pay_method.
--    Terminal sync recomputes totals server-side; old rows stay valid.
-- 2) Plans/promos: only CEO may write GLOBAL (gym_id IS NULL) template rows.
--    Owners keep gym-scoped writes; the old WITH CHECK allowed any owner to
--    insert null-gym rows visible to every gym.

-- ── sales status + tender allowlist ──
alter table sales add column if not exists status text not null default 'sale';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sales_status_check') then
    alter table sales add constraint sales_status_check check (status in ('sale', 'refund', 'void'));
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sales_pay_method_check') then
    alter table sales add constraint sales_pay_method_check
      check (pay_method in ('cash', 'gcash', 'maya', 'card', 'qrph', 'bank'));
  end if;
end $$;

-- ── plans: owners gym-scoped only, CEO writes globals ──
drop policy if exists "scoped plans" on plans;
create policy "scoped plans read" on plans for select to authenticated
  using (gym_id is null or gym_id = any (public.my_gym_ids()));
create policy "owner plans write" on plans for insert to authenticated
  with check (gym_id = any (public.my_gym_ids()));
create policy "owner plans update" on plans for update to authenticated
  using (gym_id = any (public.my_gym_ids()))
  with check (gym_id = any (public.my_gym_ids()));
create policy "owner plans delete" on plans for delete to authenticated
  using (gym_id = any (public.my_gym_ids()));
create policy "ceo plans write" on plans for all to authenticated
  using (public.current_role() = 'ceo')
  with check (public.current_role() = 'ceo');

-- ── promos: same split ──
drop policy if exists "scoped promos" on promos;
create policy "scoped promos read" on promos for select to authenticated
  using (gym_id is null or gym_id = any (public.my_gym_ids()));
create policy "owner promos write" on promos for insert to authenticated
  with check (gym_id = any (public.my_gym_ids()));
create policy "owner promos update" on promos for update to authenticated
  using (gym_id = any (public.my_gym_ids()))
  with check (gym_id = any (public.my_gym_ids()));
create policy "owner promos delete" on promos for delete to authenticated
  using (gym_id = any (public.my_gym_ids()));
create policy "ceo promos write" on promos for all to authenticated
  using (public.current_role() = 'ceo')
  with check (public.current_role() = 'ceo');
