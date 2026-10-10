-- Serialize first-CEO bootstrap so concurrent first requests cannot both win.
create or replace function public.claim_first_ceo(target_user uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  perform pg_advisory_xact_lock(hashtext('sls:first-ceo-bootstrap'));
  if exists (select 1 from auth.users where raw_app_meta_data->>'role' = 'ceo') then
    return false;
  end if;

  update auth.users
  set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('role', 'ceo', 'gym_ids', '[]'::jsonb)
  where id = target_user;
  return found;
end;
$$;

revoke all on function public.claim_first_ceo(uuid) from public, anon, authenticated;
grant execute on function public.claim_first_ceo(uuid) to service_role;
