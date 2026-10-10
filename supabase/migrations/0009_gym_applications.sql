-- 0009_gym_applications.sql — gym owner application workflow & trial licensing.

-- 1) Gyms: track application status ('pending', 'active', 'rejected'), location, and owner_email
alter table gyms add column if not exists status text not null default 'active';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'gyms_status_check') then
    alter table gyms add constraint gyms_status_check check (status in ('pending', 'active', 'rejected'));
  end if;
end $$;

alter table gyms add column if not exists location text not null default '';
alter table gyms add column if not exists owner_email text not null default '';
alter table gyms add column if not exists approved_at timestamptz;

-- 2) Licenses: track license type ('trial', 'production')
alter table licenses add column if not exists is_trial boolean not null default false;
grant select (is_trial) on licenses to authenticated;

-- 3) Allow CEO to view and update gym status across all branches
drop policy if exists "ceo manage gyms" on gyms;
create policy "ceo manage gyms" on gyms for all to authenticated
  using (public.current_role() = 'ceo')
  with check (public.current_role() = 'ceo');
