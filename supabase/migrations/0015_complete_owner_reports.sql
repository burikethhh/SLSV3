-- Aggregate in PostgreSQL under caller RLS, never from a capped UI history.
-- All calendar boundaries are Asia/Manila, independent of browser timezone.
create or replace function public.owner_report() returns jsonb
language sql stable security invoker set search_path=public as $$
with bounds as (
  select (now() at time zone 'Asia/Manila')::date today,
    date_trunc('month',now() at time zone 'Asia/Manila')::date month_start
), sale_rows as (
  select s.*, (s.created_at at time zone 'Asia/Manila')::date as day,
    case when s.status='refund' then -s.total_cents else s.total_cents end signed_total
  from public.sales s,bounds b where s.status<>'void'
    and (s.created_at at time zone 'Asia/Manila')::date >= least(b.month_start,b.today-29)
    and s.created_at<=now()
), entries as (
  select a.*,extract(hour from a.created_at at time zone 'Asia/Manila')::int as hour
  from public.attendance a,bounds b where (a.created_at at time zone 'Asia/Manila')::date=b.today
), product_totals as (
  select item->>'product_id' id,
    sum((case when s.status='refund' then -1 else 1 end) *
      greatest(0,coalesce((item->>'qty')::numeric,0)*coalesce((item->>'unit_cents')::numeric,0)-coalesce((item->>'discount_cents')::numeric,0))) total_cents
  from sale_rows s cross join bounds b cross join lateral jsonb_array_elements(s.items) item
  where s.day>=b.today-29 group by item->>'product_id'
)
select jsonb_build_object(
  'timezone','Asia/Manila',
  'month_revenue_cents',coalesce((select sum(signed_total) from sale_rows,bounds where day>=month_start),0),
  'today_revenue_cents',coalesce((select sum(signed_total) from sale_rows,bounds where day=today),0),
  'today_transactions',(select count(*) from sale_rows,bounds where day=today),
  'active_members',(select count(*) from public.members where deleted_at is null and status='active' and (expires_at is null or expires_at>now())),
  'today_checkins',(select count(*) from entries where member_id is not null and direction='in'),
  'today_exits',(select count(*) from entries where direction='out'),
  'daily',coalesce((select jsonb_agg(row_to_json(d) order by d.day) from (
    select dates.day::date as day,coalesce(sum(s.signed_total),0) total_cents
    from bounds b cross join lateral generate_series(b.today-29,b.today,interval '1 day') dates(day)
    left join sale_rows s on s.day=dates.day::date group by dates.day) d),'[]'::jsonb),
  'top_products',coalesce((select jsonb_agg(row_to_json(t)) from (
    select t.id,coalesce(p.name,'Removed product') name,t.total_cents from product_totals t
    left join public.products p on p.id::text=t.id where t.total_cents>0 order by t.total_cents desc limit 5) t),'[]'::jsonb),
  'hours',coalesce((select jsonb_agg(row_to_json(h)) from (select hour,count(*) entries from entries
    where direction='in' and member_id is not null group by hour order by hour) h),'[]'::jsonb),
  'branches',coalesce((select jsonb_agg(row_to_json(g)) from (
    select g.id,g.name,coalesce((select sum(s.signed_total) from sale_rows s where s.gym_id=g.id),0) total_cents,
      (select count(*) from sale_rows s where s.gym_id=g.id) transactions,
      (select count(*) from entries e where e.gym_id=g.id and e.direction='in' and e.member_id is not null) checkins
    from public.gyms g order by g.name) g),'[]'::jsonb)
);
$$;
revoke all on function public.owner_report() from public,anon;
grant execute on function public.owner_report() to authenticated,service_role;
