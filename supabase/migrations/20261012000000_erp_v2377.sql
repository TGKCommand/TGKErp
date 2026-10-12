-- =====================================================================================================
-- TGK ERP v23.77 migration - run once in the Supabase SQL editor. Safe to run again.
--   #2  erp_apply()        : ship / receive / pack / unpack as ONE all-or-nothing database transaction
--   #3  erp_stock_audit()  : the daily stock check (drift, gaps in the history, negative stock,
--                            pending deductions, shipped lines with no deduction)
-- Until this is run the ERP keeps using its previous step-by-step path, so nothing breaks in between.
-- =====================================================================================================

-- per-line shipment ledger (also part of the v23.65 migration - repeated here so this file stands alone)
alter table sales add column if not exists deduct_pending boolean default false;
alter table sales add column if not exists stock_deducted_at timestamptz;
create index if not exists sales_deduct_pending_idx on sales (deduct_pending) where deduct_pending;
create index if not exists inv_corrections_pn_created_idx on inv_corrections (pn, created_at);

-- -----------------------------------------------------------------------------------------------------
-- One stock change: lock the row, apply the ERP's single stock rule (on hand never below 0, the shortfall
-- is backorder, stock coming in pays backorder off first), write the history row. Raises on any problem,
-- which rolls back the whole erp_apply() call that invoked it.
-- -----------------------------------------------------------------------------------------------------
create or replace function erp_stock_move(p_kind text, p_id text, p_delta numeric, p_reason text,
                                          p_source text, p_ref text, p_user text)
returns jsonb language plpgsql as $$
declare
  v_tbl text; v_fld text; v_pn text; v_prev numeric; v_bo numeric; v_new numeric; v_settle numeric;
  v_ref_type text;
begin
  if p_kind = 'assembly' then v_tbl := 'assemblies'; v_fld := 'total_on_hand';
  elsif p_kind = 'part' then v_tbl := 'parts'; v_fld := 'total_unpckgd';
  else raise exception 'erp_stock_move: unknown kind %', p_kind; end if;
  if p_delta is null or p_delta = 0 then raise exception 'erp_stock_move: zero move for % %', p_kind, p_id; end if;

  execute format('select pn, coalesce(%I,0)::numeric, coalesce(backorder_qty,0)::numeric from %I where id::text = $1 for update',
                 v_fld, v_tbl) into v_pn, v_prev, v_bo using p_id;
  if v_pn is null then raise exception 'erp_stock_move: % % not found', p_kind, p_id; end if;

  if p_delta > 0 then
    v_settle := least(v_bo, p_delta); v_bo := v_bo - v_settle; v_new := v_prev + (p_delta - v_settle);
  else
    v_new := v_prev + p_delta;
    if v_new < 0 then v_bo := v_bo - v_new; v_new := 0; end if;
  end if;

  execute format('update %I set %I = $1, backorder_qty = $2, updated_at = now() where id::text = $3', v_tbl, v_fld)
    using v_new, v_bo, p_id;

  select data_type into v_ref_type from information_schema.columns
   where table_schema = 'public' and table_name = 'inv_corrections' and column_name = 'reference_id';
  if v_ref_type = 'uuid' then
    insert into inv_corrections (pn, previous_qty, new_qty, adjustment, reason, source, user_email, reference_id)
    values (v_pn, v_prev, v_new, p_delta, p_reason, p_source, p_user,
            case when p_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_ref::uuid end);
  else
    insert into inv_corrections (pn, previous_qty, new_qty, adjustment, reason, source, user_email, reference_id)
    values (v_pn, v_prev, v_new, p_delta, p_reason, p_source, p_user, p_ref);
  end if;

  return jsonb_build_object('kind', p_kind, 'id', p_id, 'pn', v_pn, 'prev', v_prev, 'new', v_new,
                            'backorder', v_bo, 'delta', p_delta);
end $$;

-- -----------------------------------------------------------------------------------------------------
-- erp_apply(p): guards + row updates + stock moves in ONE transaction. Anything fails -> nothing changes.
-- p = {
--   guards : [{table, id, field, not_in:[...] | equals:'x' | equals_num:n}]  lock the row; refuse if it no longer matches
--   updates: [{table, id, set:{col:value,...}} ]        whitelisted tables/columns only
--   moves  : [{kind:'part'|'assembly', id, delta, reason?, source?, reference_id?}]
--   reason, source, reference_id, user                   defaults for the moves
-- }
-- Returns {ok:true, moves:[{kind,id,pn,prev,new,backorder,delta}]} or {ok:false, guard, current}.
-- Runs with the caller's own permissions (security invoker), so it can do nothing the ERP can't already do.
-- -----------------------------------------------------------------------------------------------------
create or replace function erp_apply(p jsonb)
returns jsonb language plpgsql as $$
declare
  g jsonb; u jsonb; m jsonb; v_tbl text; v_cur text; v_cols text; v_bad text; v_n int;
  v_allowed text[]; v_res jsonb := '[]'::jsonb;
begin
  for g in select * from jsonb_array_elements(coalesce(p->'guards', '[]'::jsonb)) loop
    v_tbl := g->>'table';
    if v_tbl not in ('sales', 'po_lines', 'purchases') then raise exception 'erp_apply: guard table % not allowed', v_tbl; end if;
    if (g->>'field') not in ('fulfillment_status', 'status', 'qty_received') then raise exception 'erp_apply: guard field % not allowed', g->>'field'; end if;
    execute format('select %I::text from %I where id::text = $1 for update', g->>'field', v_tbl) into v_cur using g->>'id';
    get diagnostics v_n = row_count;  -- EXECUTE does not set FOUND
    if v_n = 0 then raise exception 'erp_apply: % % not found', v_tbl, g->>'id'; end if;
    if g ? 'not_in' and coalesce(v_cur, '') in (select jsonb_array_elements_text(g->'not_in')) then
      return jsonb_build_object('ok', false, 'guard', g, 'current', v_cur);
    end if;
    if g ? 'equals' and coalesce(v_cur, '') <> coalesce(g->>'equals', '') then
      return jsonb_build_object('ok', false, 'guard', g, 'current', v_cur);
    end if;
    if g ? 'equals_num' and coalesce(nullif(v_cur, '')::numeric, 0) <> (g->>'equals_num')::numeric then
      return jsonb_build_object('ok', false, 'guard', g, 'current', v_cur);
    end if;
  end loop;

  for u in select * from jsonb_array_elements(coalesce(p->'updates', '[]'::jsonb)) loop
    v_tbl := u->>'table';
    v_allowed := case v_tbl
      when 'sales' then array['fulfillment_status','tracking_number','carrier','shipped_at','updated_at','is_split_shipment','deduct_pending','stock_deducted_at']
      when 'po_lines' then array['qty_received','status','notes','updated_at']
      when 'purchases' then array['status','updated_at']
      else null end;
    if v_allowed is null then raise exception 'erp_apply: update table % not allowed', v_tbl; end if;
    select string_agg(k, ', ') into v_bad from jsonb_object_keys(u->'set') k where not (k = any (v_allowed));
    if v_bad is not null then raise exception 'erp_apply: column(s) % not allowed on %', v_bad, v_tbl; end if;
    select string_agg(format('%I = r.%I', k, k), ', ') into v_cols from jsonb_object_keys(u->'set') k;
    if v_cols is null then continue; end if;
    execute format('update %I t set %s from jsonb_populate_record(null::%I, $1) r where t.id::text = $2', v_tbl, v_cols, v_tbl)
      using u->'set', u->>'id';
    get diagnostics v_n = row_count;
    if v_n = 0 then raise exception 'erp_apply: % % not found', v_tbl, u->>'id'; end if;
  end loop;

  for m in select * from jsonb_array_elements(coalesce(p->'moves', '[]'::jsonb)) loop
    v_res := v_res || jsonb_build_array(erp_stock_move(
      m->>'kind', m->>'id', (m->>'delta')::numeric,
      coalesce(m->>'reason', p->>'reason'), coalesce(m->>'source', p->>'source'),
      coalesce(m->>'reference_id', p->>'reference_id'), p->>'user'));
  end loop;

  return jsonb_build_object('ok', true, 'moves', v_res);
end $$;

-- -----------------------------------------------------------------------------------------------------
-- #3 Daily stock check. Reads only. p_days limits the history-gap and shipped-line checks.
-- -----------------------------------------------------------------------------------------------------
create or replace function erp_stock_audit(p_days int default 30)
returns jsonb language plpgsql stable as $$
declare v jsonb;
begin
  with items as (
    select 'part'::text kind, id::text id, pn, new_sku, coalesce(total_unpckgd,0)::numeric oh from parts
    union all
    select 'assembly', id::text, pn, new_sku, coalesce(total_on_hand,0)::numeric from assemblies
  ),
  keys as (
    select kind, id, pn as key from items
    union select kind, id, new_sku from items where coalesce(new_sku,'') <> ''
  ),
  log as (
    select k.kind, k.id, c.id::text cid, c.created_at, c.previous_qty::numeric prev, c.new_qty::numeric nw, c.source, c.reason,
           lag(c.new_qty::numeric) over w prior_new,
           row_number() over (partition by k.kind, k.id order by c.created_at desc, c.id desc) rn
    from inv_corrections c join keys k on k.key = c.pn
    where c.new_qty is not null
    window w as (partition by k.kind, k.id order by c.created_at, c.id)
  ),
  drift as (
    select i.kind, i.id, i.pn, i.oh on_hand, l.nw last_logged, l.created_at last_logged_at
    from items i join log l on l.kind = i.kind and l.id = i.id and l.rn = 1
    where l.nw <> i.oh
  ),
  gaps as (
    select l.kind, i.pn, l.created_at, l.prior_new expected_before, l.prev logged_before, l.source, l.reason
    from log l join items i on i.kind = l.kind and i.id = l.id
    where l.prior_new is not null and l.prev is not null and l.prev <> l.prior_new
      and l.created_at > now() - make_interval(days => p_days)
  ),
  neg as (select kind, pn, oh on_hand from items where oh < 0),
  pend as (select id::text id, order_number, pn, qty from sales where deduct_pending is true),
  shipped as (
    select s.id::text sid, s.order_number, s.pn, s.qty, s.tracking_number, s.shipped_at, k.kind, k.id item_id
    from sales s join keys k on k.key = s.pn
    where s.fulfillment_status in ('Shipped','Delivered') and s.shipped_at > now() - make_interval(days => p_days)
      and coalesce(s.source,'') not in ('Shopify History','ShipStation Import')
  ),
  undeducted as (
    select sh.sid, sh.kind, sh.item_id, sh.order_number, sh.pn, sh.qty, sh.tracking_number, sh.shipped_at
    from shipped sh
    where not exists (
      select 1 from inv_corrections c join keys k2 on k2.key = c.pn and k2.kind = sh.kind and k2.id = sh.item_id
      where c.source in ('shipment','manual') and (
            c.reference_id::text = sh.sid
         or (coalesce(sh.order_number,'') <> '' and c.reason ilike '%' || replace(sh.order_number,'#','') || '%')
         or (coalesce(sh.tracking_number,'') <> '' and c.reason ilike '%' || sh.tracking_number || '%')
         or (c.source = 'shipment' and c.created_at between sh.shipped_at - interval '1 day' and sh.shipped_at + interval '2 days'))
    )
  )
  select jsonb_build_object(
    'generated_at', now(), 'days', p_days,
    'counts', jsonb_build_object(
      'drift', (select count(*) from drift), 'gaps', (select count(*) from gaps), 'negative', (select count(*) from neg),
      'pending', (select count(*) from pend), 'undeducted', (select count(*) from undeducted)),
    'drift', coalesce((select jsonb_agg(d) from (select * from drift order by abs(on_hand - last_logged) desc limit 200) d), '[]'::jsonb),
    'gaps', coalesce((select jsonb_agg(x) from (select * from gaps order by created_at desc limit 200) x), '[]'::jsonb),
    'negative', coalesce((select jsonb_agg(n) from (select * from neg order by on_hand limit 200) n), '[]'::jsonb),
    'pending', coalesce((select jsonb_agg(pq) from (select * from pend limit 200) pq), '[]'::jsonb),
    'undeducted', coalesce((select jsonb_agg(ud) from (select * from undeducted order by shipped_at desc limit 200) ud), '[]'::jsonb)
  ) into v;
  return v;
end $$;

grant execute on function erp_stock_move(text, text, numeric, text, text, text, text) to authenticated;
grant execute on function erp_apply(jsonb) to authenticated;
grant execute on function erp_stock_audit(int) to authenticated;
