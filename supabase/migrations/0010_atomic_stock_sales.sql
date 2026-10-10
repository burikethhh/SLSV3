-- Record an offline sale and decrement inventory atomically.
-- Replayed sale ids are no-ops, so sync retries cannot double-decrement stock.
create or replace function public.record_sale_and_decrement_stock(
  p_sale_id uuid,
  p_gym_id uuid,
  p_items jsonb,
  p_total_cents bigint,
  p_pay_method text,
  p_created_at timestamptz
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  product_id uuid;
  qty int;
begin
  insert into sales(id, gym_id, items, total_cents, pay_method, created_at)
  values (p_sale_id, p_gym_id, p_items, p_total_cents, p_pay_method, p_created_at)
  on conflict (id) do nothing;

  if not found then
    return;
  end if;

  for item in select * from jsonb_array_elements(p_items) loop
    product_id := nullif(item->>'product_id', '')::uuid;
    qty := (item->>'qty')::int;
    if product_id is null or qty is null or qty <= 0 then
      raise exception 'invalid sale item';
    end if;
    -- Offline sales keep the price charged at checkout; the owner may have
    -- changed the cloud catalog price before this terminal reconnects.
    if not exists (select 1 from products where id = product_id and gym_id = p_gym_id) then
      raise exception 'product does not belong to gym';
    end if;
    update products
      set stock = stock - qty, updated_at = now()
      where id = product_id and gym_id = p_gym_id;
    if not found then
      raise exception 'product missing';
    end if;
  end loop;
exception when others then
  raise;
end;
$$;

revoke all on function public.record_sale_and_decrement_stock(uuid, uuid, jsonb, bigint, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_sale_and_decrement_stock(uuid, uuid, jsonb, bigint, text, timestamptz) to service_role;
