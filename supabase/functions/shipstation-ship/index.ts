import { createClient } from 'npm:@supabase/supabase-js@2'
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
// [AUDIT v23.65] How the last deductForShipment call ended: deducted | duplicate | manual | notfound | failed
let _lastDeduct = ''
let _pendingColumnOk = true
// Per-line ledger: sales.deduct_pending is set BEFORE a line is marked Shipped and cleared once its stock is
// deducted (or found already deducted). Anything left pending is retried automatically.
async function markDeductPending(ids: string[], on: boolean): Promise<void> {
  if (!_pendingColumnOk || !ids.length) return
  const upd: any = { deduct_pending: on }
  if (!on) upd.stock_deducted_at = new Date().toISOString()
  const { error } = await db.from('sales').update(upd).in('id', ids)
  if (error) {
    if (/deduct_pending|stock_deducted_at|column/i.test(error.message || '')) { _pendingColumnOk = false; console.warn('[SS] sales.deduct_pending not migrated - per-line retry disabled until the migration runs') }
    else console.warn('[SS] could not update deduct_pending:', error.message)
  }
}
async function logEdgeError(message: string): Promise<void> {
  await db.from('error_log').insert({ page: 'shipstation-ship', app_version: 'edge shipstation-ship', message }).then(() => {}, () => {})
}
// Deduct one sales line and settle its pending flag. Returns false only when it must be retried.
async function deductLine(line: any, tracking: string, orderRef: string): Promise<boolean> {
  _lastDeduct = 'failed'
  try { await deductForShipment(line.pn, Number(line.qty) || 1, tracking, orderRef) } catch (e) { _lastDeduct = 'failed'; console.error('[SS] deduction threw for', line.pn, e) }
  if (_lastDeduct === 'failed') {
    await logEdgeError('Stock deduction failed for ' + line.pn + ' on ' + orderRef + ' (tracking ' + tracking + ') - left pending, retried automatically')
    return false
  }
  if (_lastDeduct === 'notfound') await logEdgeError(line.pn + ' on ' + orderRef + ' shipped but is not in Parts or Assemblies - no stock deducted')
  await markDeductPending([line.id], false)
  return true
}
async function retryPendingDeductions(limit: number): Promise<{ tried: number, done: number, failed: number, remaining: number | null }> {
  const out = { tried: 0, done: 0, failed: 0, remaining: null as number | null }
  if (!_pendingColumnOk) return out
  const { data: rows, error } = await db.from('sales').select('id,pn,qty,order_number,tracking_number').eq('deduct_pending', true).limit(limit)
  if (error) { if (/deduct_pending|column/i.test(error.message || '')) _pendingColumnOk = false; return out }
  for (const l of (rows || [])) {
    // Never retry without a tracking number: it is the duplicate guard that makes a retry safe.
    if (!l.tracking_number) { await logEdgeError('Pending deduction for ' + l.pn + ' on ' + l.order_number + ' has no tracking number - fix the line, then retry'); continue }
    out.tried++
    if (await deductLine(l, l.tracking_number, l.order_number || '')) out.done++; else out.failed++
  }
  const { count } = await db.from('sales').select('id', { count: 'exact', head: true }).eq('deduct_pending', true)
  out.remaining = count ?? null
  return out
}
// One stock rule, same as the ERP's apply_stock_delta: on hand never goes below 0, the shortfall is backorder,
// and stock coming back clears backorder first. Uses the database function when it exists.
async function stockDelta(kind: 'assembly' | 'part', id: string, delta: number): Promise<{ prev: number, next: number } | null> {
  try {
    const { data, error } = await db.rpc('apply_stock_delta', { p_kind: kind, p_id: String(id), p_delta: delta })
    if (!error && data) { const row = Array.isArray(data) ? data[0] : data; if (row && row.new_qty != null) return { prev: Number(row.prev_qty || 0), next: Number(row.new_qty) } }
  } catch (_) { /* fall through */ }
  const table = kind === 'assembly' ? 'assemblies' : 'parts', field = kind === 'assembly' ? 'total_on_hand' : 'total_unpckgd'
  const { data: r, error: rErr } = await db.from(table).select(field + ',backorder_qty').eq('id', id).maybeSingle()
  if (rErr || !r) return null
  const prev = Number((r as any)[field]) || 0
  let bo = Number((r as any).backorder_qty) || 0
  let next: number
  if (delta >= 0) { const settle = Math.min(bo, delta); bo -= settle; next = prev + (delta - settle) }
  else { next = prev + delta; if (next < 0) { bo += -next; next = 0 } }
  const upd: any = { backorder_qty: bo, updated_at: new Date().toISOString() }
  upd[field] = next
  const { error: uErr } = await db.from(table).update(upd).eq('id', id)
  if (uErr) return null
  return { prev, next }
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function ok(body: string) { return new Response(body, { headers: CORS }) }
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}
function stripHash(s: string): string { return s.replace(/^#/, '').replace(/^Manual_/i, '') }

// [FIX] Same falsy-zero trap fixed in shopify-orders.ts: `item.quantity || 1` reads an explicit
// quantity of 0 as ONE, because 0 is falsy in JS. ShipStation genuinely does report zeroed line
// items this way - confirmed live on order #10497, whose payload carried
// {"sku":"JXB-C7001A0-S","quantity":0} - so every import path below would resurrect an item that
// was deliberately removed from the order, as a quantity of one. A missing/undefined quantity
// still defaults to 1 (unchanged for normal orders); an explicit 0 or negative means the line is
// not part of the order and callers skip it entirely.
function ssItemQty(item: any): number {
  return (item?.quantity === undefined || item?.quantity === null) ? 1 : Number(item.quantity)
}

function centralDateOnly(d?: string): string {
  const dt = d ? new Date(d) : new Date()
  return new Date(dt.getTime() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

async function buildOrderMap() {
  const { data } = await db.from('sales')
    .select('id,order_number,pn,fulfillment_status,qty')
    .in('fulfillment_status', ['Open', 'Packed', 'Partial', 'partial', 'On Hold', 'Pre-Order', 'Pre-order'])
    .limit(100000)
  const map: any = {}
  for (const line of (data || [])) {
    const key = stripHash(line.order_number || '')
    if (!map[key]) map[key] = []
    map[key].push(line)
  }
  const { data: links } = await db.from('ss_order_links').select('ss_order_number,erp_order_number')
  for (const l of (links || [])) {
    const parentKey = stripHash(l.erp_order_number || '')
    const childKey = stripHash(l.ss_order_number || '')
    if (childKey && !map[childKey] && map[parentKey]) map[childKey] = map[parentKey]
  }
  return map
}
// Resolves a set of SKU strings to canonical pn, honouring the pn/new_sku duality. Used where a
// ShipStation SKU has to be compared against an ERP sales line: the two sides frequently carry
// DIFFERENT aliases of the same item, and a plain or substring string match then misses the real
// match or grabs the wrong one. Anything with no assemblies/parts record resolves to itself.
async function buildCanonMap(skus: string[]): Promise<(raw: string) => string> {
  const norm = (x: string) => String(x || '').trim().toUpperCase()
  const list = [...new Set(skus.map((x) => String(x || '').trim()).filter(Boolean))]
  const m: Record<string, string> = {}
  if (list.length) {
    const { data: a1 } = await db.from('assemblies').select('pn').in('pn', list)
    ;(a1 || []).forEach((r: any) => { m[norm(r.pn)] = r.pn })
    const { data: a2 } = await db.from('assemblies').select('pn,new_sku').in('new_sku', list)
    ;(a2 || []).forEach((r: any) => { if (r.new_sku) m[norm(r.new_sku)] = r.pn })
    const { data: p1 } = await db.from('parts').select('pn').in('pn', list)
    ;(p1 || []).forEach((r: any) => { if (!(norm(r.pn) in m)) m[norm(r.pn)] = r.pn })
    const { data: p2 } = await db.from('parts').select('pn,new_sku').in('new_sku', list)
    ;(p2 || []).forEach((r: any) => { if (r.new_sku && !(norm(r.new_sku) in m)) m[norm(r.new_sku)] = r.pn })
  }
  return (raw: string) => { const n = norm(raw); return m[n] || n }
}

function ssAuth(): string {
  const k = Deno.env.get('SS_KEY') || '', s = Deno.env.get('SS_SECRET') || ''
  return btoa(k + ':' + s)
}

async function fetchSSOrder(orderId: number | string): Promise<any | null> {
  try {
    const r = await fetch('https://ssapi.shipstation.com/orders/' + orderId, {
      headers: { Authorization: 'Basic ' + ssAuth() }
    })
    if (!r.ok) { console.warn('[SS][split] GET /orders/' + orderId + ' -> ' + r.status); return null }
    return await r.json()
  } catch (e) { console.warn('[SS][split] GET /orders/' + orderId + ' threw:', e); return null }
}

async function erpOrderNumberFor(rawNum: string): Promise<string | null> {
  if (!rawNum) return null
  const { data: a } = await db.from('sales').select('id').eq('order_number', rawNum).limit(1)
  if (a?.length) return rawNum
  const { data: b } = await db.from('sales').select('id').eq('order_number', '#' + rawNum).limit(1)
  if (b?.length) return '#' + rawNum
  return null
}

async function linkSplitChild(order: any): Promise<string | null> {
  const childNum = stripHash(order?.orderNumber || '')
  if (!childNum) return null
  const { data: known } = await db.from('ss_order_links')
    .select('erp_order_number').eq('ss_order_number', childNum).limit(1)
  if (known?.[0]?.erp_order_number) return known[0].erp_order_number
  const adv = order?.advancedOptions || {}
  const parentId = adv.parentId ?? adv.parentOrderId ?? null
  if (!parentId) return null
  const parent = await fetchSSOrder(parentId)
  if (!parent?.orderNumber) return null
  const erpNum = await erpOrderNumberFor(stripHash(parent.orderNumber))
  if (!erpNum) { console.warn('[SS][split] child', childNum, 'parent', parent.orderNumber, 'not in ERP either'); return null }
  const childSkus = (order.items || [])
    .map((i: any) => String(i.sku || i.name || '').trim().toUpperCase()).filter(Boolean)
  await db.from('ss_order_links').upsert({
    ss_order_number: childNum,
    erp_order_number: erpNum,
    ss_order_id: order.orderId ?? null,
    parent_ss_order_id: parentId,
    child_skus: childSkus,
  }, { onConflict: 'ss_order_number' })
  await db.from('sales').update({ is_split_shipment: true }).eq('order_number', erpNum)
  console.log('[SS][split] linked', childNum, '-> ERP', erpNum, 'skus', JSON.stringify(childSkus))
  return erpNum
}

async function resolveShipmentOrder(salesNum: string, ship: any): Promise<{ num: string | null, viaSplit: boolean }> {
  const direct = await erpOrderNumberFor(salesNum)
  if (direct) return { num: direct, viaSplit: false }
  const { data: lk } = await db.from('ss_order_links')
    .select('erp_order_number').eq('ss_order_number', salesNum).limit(1)
  if (lk?.[0]?.erp_order_number) return { num: lk[0].erp_order_number, viaSplit: true }
  if (ship?.orderId) {
    const ssOrder = await fetchSSOrder(ship.orderId)
    if (ssOrder) { const n = await linkSplitChild(ssOrder); if (n) return { num: n, viaSplit: true } }
  }
  return { num: null, viaSplit: false }
}

function isHWPackServer(pn: string): boolean {
  return /^TGK-P\d/i.test(pn || '')
}
async function reconcileProductTemplate(gqlFn: any, prodId: string): Promise<any> {
  const out: {changed: boolean, from: string | null, to: string | null, skipped: string | null, errors: string[]} =
    {changed: false, from: null, to: null, skipped: null, errors: []}
  if (!prodId) return out
  try {
    const q = await gqlFn('{ product(id: "' + prodId + '") { templateSuffix variants(first: 100) { edges { node { id inventoryQuantity inventoryItem { tracked } } } } } }')
    const prod = q?.data?.product
    if (!prod) { out.errors.push('product lookup returned nothing'); return out }
    const vs = (prod.variants?.edges || []).map((e: any) => e.node)
    const n = vs.length
    if (!n) return out
    const boCount = vs.filter((v: any) => v?.inventoryItem?.tracked && (Number(v.inventoryQuantity) || 0) <= 0).length
    const shouldBO = (n <= 1) ? (boCount >= 1) : (boCount === n)
    const boTpl = Deno.env.get('SHOPIFY_BACKORDER_TEMPLATE') || 'backorder'
    const desired = shouldBO ? boTpl : ''
    const current = prod.templateSuffix || ''
    const cnorm = current.trim().toLowerCase()
    const isDefaultTpl = (cnorm === '' || cnorm === 'default' || cnorm === 'default product')
    const currentEff = isDefaultTpl ? '' : current
    out.from = current; out.to = desired
    if (currentEff !== '' && currentEff !== boTpl) { out.skipped = 'custom template "' + current + '" - not managed'; return out }
    if (currentEff === desired) return out
    let applied = false
    const tryUpdate = async (argName: string) => {
      const m = await gqlFn('mutation { productUpdate(' + argName + ': {id: "' + prodId + '", templateSuffix: "' + desired + '"}) { product { templateSuffix } userErrors { field message } } }')
      const ue = (m?.data?.productUpdate?.userErrors || []).map((u: any) => u.message)
      ue.forEach((x: string) => out.errors.push(x))
      if (m?.data?.productUpdate?.product) { applied = true; return true }
      return false
    }
    if (!(await tryUpdate('product'))) { await tryUpdate('input') }
    out.changed = applied
    if (applied) console.log('[template] product ' + prodId + ': "' + current + '" -> "' + desired + '" (' + boCount + '/' + n + ' variants backordered)')
    else console.warn('[template] product ' + prodId + ': could NOT set templateSuffix to "' + desired + '"' + (out.errors.length ? (' - ' + out.errors.join('; ')) : ''))
  } catch (e) {
    out.errors.push(String((e as any)?.message || e))
  }
  return out
}

// [FIX] The backorder automation was managing NON-TGK products - resale/vendor items such as
// BIK-ER10S (Brisk plugs) and DNP-* (Denso) showed up in shopify_sync_log having been tracked,
// zeroed and templated by it. Two separate holes caused that:
//   1. No prefix rule at all: nothing restricted the automation to TGK's own manufactured goods.
//   2. Every caller wrote `if (eligItem && !isEligibleForBackorderSync(eligItem))`, so a SKU that
//      exists in NEITHER assemblies nor parts produced no eligItem and skipped the gate entirely -
//      precisely the case for a pure resale item the ERP does not build or stock-manage.
// Checked against pn AND new_sku because of this catalog's legacy/new SKU duality: a TGK product
// may be keyed on either, and it should be managed if either one carries the prefix. The prefix is
// env-configurable rather than hardcoded so it can change without a code edit.
function isTgkManagedSku(pn: string | null | undefined, newSku?: string | null): boolean {
  const prefix = (Deno.env.get('BACKORDER_SKU_PREFIX') || 'TGK').trim().toUpperCase()
  if (!prefix) return true
  const a = String(pn || '').trim().toUpperCase()
  const b = String(newSku || '').trim().toUpperCase()
  return a.startsWith(prefix) || b.startsWith(prefix)
}
function isEligibleForBackorderSync(item: any): boolean {
  if (!item) return false
  if (!isTgkManagedSku(item.pn, item.new_sku)) return false
  if (item.discontinued || item.stage === 'dev') return false
  if (item.is_subassembly || isHWPackServer(item.pn)) return false
  if ((item.category || '') === 'Pre-Order') return false
  return true
}

async function bomMaxBuild(pn: string): Promise<{ hasBOM: boolean, maxBuild: number }> {
  const bomOf: Record<string, { child_pn: string, qty: number, item_type: string }[]> = {}
  const childPns = new Set<string>()
  let frontier: string[] = [pn]; let depth = 0; const fetched = new Set<string>()
  while (frontier.length && depth <= 6) {
    const toFetch = frontier.filter(p => !fetched.has(p)); toFetch.forEach(p => fetched.add(p))
    if (!toFetch.length) break
    const { data: rows } = await db.from('bom_items').select('parent_pn,child_pn,qty,item_type').in('parent_pn', toFetch)
    toFetch.forEach(p => { if (!bomOf[p]) bomOf[p] = [] })
    const next: string[] = []
    ;(rows || []).forEach((r: any) => {
      (bomOf[r.parent_pn] = bomOf[r.parent_pn] || []).push({ child_pn: r.child_pn, qty: Number(r.qty) || 1, item_type: r.item_type })
      childPns.add(r.child_pn)
      if (r.item_type === 'assembly' || r.item_type === 'subassembly') next.push(r.child_pn)
    })
    frontier = next; depth++
  }
  if (!(bomOf[pn] || []).length) return { hasBOM: false, maxBuild: 0 }
  const allChildren = [...childPns]
  const partRec: Record<string, { stock: number, cat: string, desc: string }> = {}
  const asmRec: Record<string, { oh: number }> = {}
  if (allChildren.length) {
    const { data: prows } = await db.from('parts').select('pn,total_unpckgd,category,description').in('pn', allChildren)
    ;(prows || []).forEach((p: any) => { partRec[p.pn] = { stock: Number(p.total_unpckgd) || 0, cat: (p.category || '').toLowerCase(), desc: (p.description || '').toLowerCase() } })
    const { data: arows } = await db.from('assemblies').select('pn,total_on_hand').in('pn', allChildren)
    ;(arows || []).forEach((a: any) => { asmRec[a.pn] = { oh: Number(a.total_on_hand) || 0 } })
  }
  // [FIX] Ported from the ERP's shared isNonRawSupplyItem (index.html) - this used to check only
  // SUPPLY (Shipping/Bulk Pieces) plus a raw substring scan for 'box'/'packaging'/'shipping'
  // across the WHOLE category string. That missed PACK_CATS entries like "Boxes"/"Cartons"/
  // "Labels"/"Packing" entirely (no substring overlap with the three words checked), and missed
  // marketing/sticker/rebate-card categories altogether - meaning a product could be marked
  // backordered on the live Shopify storefront because a shipping carton or a rebate card ran
  // out, not because an actual component was missing. Also matches the client's fix for the
  // opposite failure mode: a raw substring check on the full category path would wrongly treat a
  // real part like "Products/Drivetrain/DUMPBOXES" as packaging purely because of a name
  // collision - matching only the exact full category or its top-level "Category/Subcategory"
  // segment avoids that.
  const NONRAW_SUPPLY_CATS = ['box', 'boxes', 'packaging', 'packing', 'carton', 'cartons', 'label', 'labels', 'shipping', 'bulk pieces', 'sticker', 'stickers', 'decal', 'decals', 'rebate', 'rebate card', 'rebate cards', 'marketing', 'insert', 'inserts', 'literature', 'card', 'cards', 'flyer', 'flyers', 'brochure', 'brochures']
  const NONRAW_SUPPLY_KW = ['sticker', 'decal', 'rebate', 'flyer', 'brochure', 'mailer', 'pamphlet']
  const inc = (i: { child_pn: string, item_type: string }): boolean => {
    if (i.item_type === 'packaging') return false
    const pr = partRec[i.child_pn]
    if (pr) {
      const c = pr.cat
      if (c) {
        const top = c.split('/')[0].trim()
        if (NONRAW_SUPPLY_CATS.includes(c) || NONRAW_SUPPLY_CATS.includes(top)) return false
      }
      if (NONRAW_SUPPLY_KW.some(k => pr.desc.includes(k) || i.child_pn.toLowerCase().includes(k))) return false
    }
    return true
  }
  const isSub = (i: { child_pn: string, item_type: string }): boolean => (i.child_pn in asmRec) || i.item_type === 'assembly' || i.item_type === 'subassembly'
  const ub = (node: string, d: number): number => {
    if (d > 6) return 0
    const bom = bomOf[node] || []; const per: number[] = []
    for (const i of bom) {
      if (!inc(i)) continue
      let avail: number
      if (isSub(i)) { const oh = (asmRec[i.child_pn]?.oh) || 0; const cap = ub(i.child_pn, d + 1); avail = oh + (cap === Infinity ? 0 : cap) }
      else { avail = (partRec[i.child_pn]?.stock) || 0 }
      per.push(i.qty > 0 ? Math.floor(avail / i.qty) : Infinity)
    }
    if (!per.length) return Infinity
    return Math.max(0, Math.min(...per))
  }
  const UB = ub(pn, 0)
  if (UB === Infinity) return { hasBOM: true, maxBuild: 1 }
  if (UB <= 0) return { hasBOM: true, maxBuild: 0 }
  const feasible = (N: number): boolean => {
    const partUsed: Record<string, number> = {}, subLeft: Record<string, number> = {}; let ok = true
    const explode = (node: string, count: number, d: number): void => {
      if (!ok || count <= 0) return
      if (d > 8) { ok = false; return }
      const bom = bomOf[node] || []
      for (const i of bom) {
        if (!ok) break
        if (!inc(i)) continue
        const need = count * (i.qty || 1); if (need <= 0) continue
        if (isSub(i)) {
          if (subLeft[i.child_pn] === undefined) subLeft[i.child_pn] = (asmRec[i.child_pn]?.oh) || 0
          const fromStock = Math.min(need, subLeft[i.child_pn]); subLeft[i.child_pn] -= fromStock
          const toBuild = need - fromStock
          if (toBuild > 0) { if (!(bomOf[i.child_pn] || []).length) { ok = false; return } explode(i.child_pn, toBuild, d + 1) }
        } else {
          partUsed[i.child_pn] = (partUsed[i.child_pn] || 0) + need
          const stock = (partRec[i.child_pn]?.stock) || 0
          if (partUsed[i.child_pn] > stock) { ok = false; return }
        }
      }
    }
    explode(pn, N, 0)
    return ok
  }
  let lo = 0, hi = UB
  while (lo < hi) { const mid = lo + Math.ceil((hi - lo) / 2); if (feasible(mid)) lo = mid; else hi = mid - 1 }
  return { hasBOM: true, maxBuild: lo }
}

// [FIX] A product deliberately put on a PRE-ORDER template in Shopify was still being forced into
// backorder by this automation. The only guard that existed was isEligibleForBackorderSync, which
// checks the ERP's OWN category field for the literal string 'Pre-Order' - so a product merchandised
// as pre-order purely on the Shopify side (its template_suffix set there, which is how it's actually
// done) had nothing stopping it: the variant got tracked, zeroed and stamped with a backorder ETA,
// overwriting the pre-order presentation the customer was meant to see.
// reconcileProductTemplate already refuses to touch a bespoke template ("custom template - not
// managed"), but that only ever protected the PRODUCT's template field - not the variant-level
// inventory/metafield writes that happen before it, which are what actually break a pre-order.
// This applies the same rule one level earlier and to the whole operation: if the product is
// sitting on any template that isn't the default or the backorder template, it is intentional
// merchandising (pre-order or otherwise) and the backorder automation leaves it completely alone,
// in BOTH directions - "revert to available" would untrack a pre-order variant just as wrongly.
function isManagedBackorderTemplate(templateSuffix: string | null | undefined): boolean {
  const cur = String(templateSuffix || '').trim().toLowerCase()
  const boTpl = (Deno.env.get('SHOPIFY_BACKORDER_TEMPLATE') || 'backorder').trim().toLowerCase()
  if (cur === '' || cur === 'default' || cur === 'default product') return true
  return cur === boTpl
}

async function syncShopifyBackorder(pn: string, newOh: number): Promise<void> {
  const { data: toggleRow } = await db.from('settings').select('value').eq('key', 'shopify_backorder_sync_enabled').limit(1)
  const syncEnabled = toggleRow?.[0]?.value
  if (syncEnabled === false || syncEnabled === 'false') {
    console.log('[SS->Shopify] sync disabled via ERP toggle - skipped for', pn)
    return
  }
  let { data: asmCheck } = await db.from('assemblies').select('pn,new_sku,use_new_sku,discontinued,stage,is_subassembly,category,force_backorder').eq('pn', pn).limit(1)
  if (!asmCheck?.length) { const _r = await db.from('assemblies').select('pn,new_sku,use_new_sku,discontinued,stage,is_subassembly,category,force_backorder').eq('new_sku', pn).limit(1); asmCheck = _r.data }
  const { data: partCheck } = asmCheck?.length ? { data: null } : await db.from('parts').select('pn,new_sku,use_new_sku,discontinued,category').eq('pn', pn).limit(1)
  const eligItem = asmCheck?.[0] || partCheck?.[0]
  if (!eligItem) {
    // No assemblies/parts record at all - a resale or drop-ship SKU the ERP neither builds nor
    // stocks. Previously this bypassed the gate entirely (the check was guarded on eligItem being
    // truthy), which is how non-TGK vendor products ended up managed by this automation.
    if (!isTgkManagedSku(pn)) {
      console.log('[SS->Shopify] skipped - no ERP catalog record and not a managed prefix SKU:', pn)
      return
    }
  } else if (!isEligibleForBackorderSync(eligItem)) {
    console.log('[SS->Shopify] skipped - not eligible (non-managed prefix/subassembly/hardware pack/pre-order/discontinued/dev):', pn)
    return
  }
  const shopSkuBO = (eligItem && eligItem.use_new_sku && eligItem.new_sku) ? eligItem.new_sku : pn
  if (shopSkuBO !== pn) console.log('[SS->Shopify] resolved canonical', pn, '-> variant SKU', shopSkuBO)
  const store = (Deno.env.get('SHOPIFY_STORE') || '').replace('https://', '').replace('http://', '')
  const key = Deno.env.get('SHOPIFY_KEY') || ''
  if (!store || !key) return
  let template = ''
  let ssRestock = ''
  const forcedBO = !!(eligItem && eligItem.force_backorder)
  if (forcedBO) {
    template = Deno.env.get('SHOPIFY_BACKORDER_TEMPLATE') || 'backorder'
    console.log('[SS->Shopify]', pn, 'FORCED on backorder by manual override')
  } else if (newOh <= 0) {
    const { hasBOM, maxBuild } = await bomMaxBuild(pn)
    const isBackorder = !hasBOM || maxBuild <= 0
    if (isBackorder) {
      template = Deno.env.get('SHOPIFY_BACKORDER_TEMPLATE') || 'backorder'
      const { data: rdRow } = await db.from('settings').select('value').eq('key', 'shopify_restock_days').limit(1)
      const rdDays = Number(rdRow?.[0]?.value) || 30
      ssRestock = new Date(Date.now() + rdDays * 86400000).toISOString().slice(0, 10)
    }
    console.log('[SS->Shopify]', pn, 'newOh='+newOh, 'hasBOM='+hasBOM, 'maxBuild='+maxBuild, '->', template || '(revert)', ssRestock ? 'restock:'+ssRestock : '')
  }
  try {
    const isBO = template !== ''
    const gqlTopErrorsBO:string[] = []
    const gqlBO = async (q: string) => {
      const r = await fetch('https://' + store + '/admin/api/2024-01/graphql.json', {method:'POST', headers:{'X-Shopify-Access-Token':key,'Content-Type':'application/json'}, body: JSON.stringify({query:q})}).then(x => x.json())
      if (r && Array.isArray(r.errors) && r.errors.length) r.errors.forEach((e:any)=>gqlTopErrorsBO.push(e?.message || JSON.stringify(e)))
      return r
    }
    const safeBO = shopSkuBO.replace(/"/g, '')
    const findBO = await gqlBO('{ productVariants(first: 10, query: "sku:' + safeBO + '") { edges { node { id sku inventoryItem { id } product { id templateSuffix } metafield(namespace: "custom", key: "estimated_arrival_date") { value } } } } }')
    const edgesBO = findBO?.data?.productVariants?.edges || []
    const mBO = edgesBO.find((e:any) => (e.node.sku || '').trim().toUpperCase() === shopSkuBO.toUpperCase())
    if (!mBO) { console.warn('[SS->Shopify] no variant for SKU', shopSkuBO, '(from canonical ' + pn + ')'); return }
    // Pre-order (or any other bespoke template) is deliberate merchandising - never override it.
    if (!isManagedBackorderTemplate(mBO.node.product?.templateSuffix)) {
      console.log('[SS->Shopify] skipped', pn, '- product is on the "' + (mBO.node.product?.templateSuffix || '') + '" template (pre-order/custom), not managed by backorder automation')
      return
    }
    const vId = mBO.node.id
    const iId = mBO.node.inventoryItem?.id
    const pId = mBO.node.product?.id
    const existingEtaBO = String(mBO.node.metafield?.value || '').trim()
    if (isBO && existingEtaBO) ssRestock = existingEtaBO
    if (isBO) {
      if (iId) {
        await gqlBO('mutation { inventoryItemUpdate(id: "' + iId + '", input: {tracked: true}) { userErrors { message } } }')
        const locBO = await gqlBO('{ locations(first: 1) { edges { node { id } } } }')
        const lId = locBO?.data?.locations?.edges?.[0]?.node?.id
        if (lId) await gqlBO('mutation { inventorySetOnHandQuantities(input: {reason: "correction", setQuantities: [{inventoryItemId: "' + iId + '", locationId: "' + lId + '", quantity: 0}]}) { userErrors { message } } }')
      }
      const pBO = await gqlBO('mutation { productVariantsBulkUpdate(productId: "' + pId + '", variants: [{id: "' + vId + '", inventoryPolicy: CONTINUE}]) { productVariants { id inventoryPolicy } userErrors { field message } } }')
      const polBO = pBO?.data?.productVariantsBulkUpdate?.productVariants?.[0]?.inventoryPolicy || null
      const polErrsBO = (pBO?.data?.productVariantsBulkUpdate?.userErrors || []).map((u:any)=>u.message)
      if (polBO !== 'CONTINUE') {
        console.warn('[SS->Shopify] ' + pn + ': could NOT set inventoryPolicy CONTINUE (got ' + (polBO || 'null') + ')'
          + (polErrsBO.concat(gqlTopErrorsBO).length ? (' - Shopify said: ' + polErrsBO.concat(gqlTopErrorsBO).join(' | ')) : '')
          + ' -- untracking variant so it stays orderable. Check the write_products API scope.')
        if (iId) await gqlBO('mutation { inventoryItemUpdate(id: "' + iId + '", input: {tracked: false}) { userErrors { message } } }')
        template = ''
        ssRestock = ''
      } else if (ssRestock) {
        await gqlBO('mutation { metafieldsSet(metafields: [{ownerId: "' + vId + '", namespace: "custom", key: "estimated_arrival_date", value: "' + ssRestock + '", type: "single_line_text_field"}]) { userErrors { message } } }')
      }
    } else {
      if (iId) await gqlBO('mutation { inventoryItemUpdate(id: "' + iId + '", input: {tracked: false}) { userErrors { message } } }')
      await gqlBO('mutation { productVariantsBulkUpdate(productId: "' + pId + '", variants: [{id: "' + vId + '", inventoryPolicy: CONTINUE}]) { productVariants { id inventoryPolicy } userErrors { field message } } }')
      await gqlBO('mutation { metafieldsSet(metafields: [{ownerId: "' + vId + '", namespace: "custom", key: "estimated_arrival_date", value: " ", type: "single_line_text_field"}]) { userErrors { message } } }')
    }
    console.log('[SS->Shopify] variant', pn, isBO ? '-> backorder' : '-> available')
    if (pId) await reconcileProductTemplate(gqlBO, pId)
    const ssRestockDate = ssRestock || ''
    try {
      const { maxBuild: logMaxBuild } = await bomMaxBuild(pn)
      await db.from('shopify_sync_log').insert({ pn, action: isBO ? 'backorder' : 'reverted', trigger_source: 'shipstation_webhook', new_oh: newOh, max_build: logMaxBuild || null, restock_date: ssRestockDate || null })
    } catch (e) { console.warn('[SS->Shopify] log insert failed:', e) }
  } catch (e) {
    console.warn('[SS->Shopify] error for', pn, e)
  }
}

async function cascadeShopifyBackorder(childPn: string): Promise<void> {
  const { data: boms } = await db.from('bom_items').select('parent_pn').eq('child_pn', childPn)
  const parentPns = [...new Set((boms || []).map((b: any) => b.parent_pn))]
  if (!parentPns.length) return
  const { data: parents } = await db.from('assemblies').select('pn,new_sku,total_on_hand,discontinued,stage,is_subassembly,category').in('pn', parentPns)
  for (const parent of (parents || [])) {
    if (!isEligibleForBackorderSync(parent)) continue
    if ((parent.total_on_hand || 0) <= 0) await syncShopifyBackorder(parent.pn, parent.total_on_hand || 0)
  }
}

async function deductForShipment(pn: string, qty: number, tracking: string, orderRef: string): Promise<boolean> {
  const reason = 'Shipped via ShipStation ' + orderRef + ' ' + tracking
  // [AUDIT] Manual ERP orders created before ERP v23.62 had stock taken at creation. Don't take it twice.
  try {
    const { data: mc } = await db.from('inv_corrections').select('id').eq('source', 'manual').eq('pn', pn).eq('reason', 'Manual ERP order ' + orderRef).limit(1)
    if (mc?.length) {
      const { data: un } = await db.from('inv_corrections').select('id').eq('source', 'unship').eq('pn', pn).ilike('reason', '%order ' + orderRef + ' reverted%').limit(1)
      if (!un?.length) { console.log('[SS] skip deduct', pn, orderRef, '- manual ERP order, stock already taken at creation'); _lastDeduct = 'manual'; return false }
    }
  } catch (e) { console.warn('[SS] manual-order check failed', e) }
  if (tracking) {
    const dedupKey = 'shipment|' + pn + '|' + tracking
    try {
      const { data: rpcRes, error: rpcErr } = await db.rpc('apply_shipment_deduction', {
        p_pn: pn, p_qty: qty, p_dedup_key: dedupKey, p_reason: reason, p_source: 'shipment'
      })
      if (!rpcErr) {
        const row = Array.isArray(rpcRes) ? rpcRes[0] : rpcRes
        if (row && row.applied === false) {
          console.log('[SS]', pn, 'tracking', tracking, '-> not applied (' + (row.kind || 'duplicate') + ') - skipping')
          _lastDeduct = 'duplicate'
          return false
        }
        if (row && row.applied === true) {
          console.log('[SS] Deducted', qty, 'of', pn, 'on', orderRef, '| atomic |', row.kind, 'on_hand:', row.prev_qty, '->', row.new_qty)
          _lastDeduct = 'deducted' // stock is down - a Shopify sync error below must not mark this as a failed deduction
          try { await syncShopifyBackorder(pn, Number(row.new_qty)); if (row.kind === 'part') await cascadeShopifyBackorder(pn) } catch (e) { console.warn('[SS] Shopify sync after deduction failed', e) }
          return true
        }
      } else {
        console.warn('[SS] apply_shipment_deduction unavailable (' + rpcErr.message + ') - falling back to non-atomic path. Run migration-atomic-shipment-deduction.sql to close the concurrency gap.')
      }
    } catch (e) {
      console.warn('[SS] apply_shipment_deduction threw - falling back to non-atomic path:', e)
    }
  }
  if (tracking) {
    const { data: dup } = await db.from('inv_corrections')
      .select('id').eq('source', 'shipment').eq('pn', pn)
      .ilike('reason', '%' + tracking + '%').limit(1)
    if (dup?.length) {
      console.log('[SS] Already deducted', pn, 'for tracking', tracking, '- skipping (idempotent)')
      _lastDeduct = 'duplicate'
      return false
    }
  }
  let { data: asms } = await db.from('assemblies').select('id').eq('pn', pn).limit(1)
  if (!asms?.length) { const _r = await db.from('assemblies').select('id').eq('new_sku', pn).limit(1); asms = _r.data }
  const asm = asms?.[0]
  let prt: any = null
  if (!asm) {
    let { data: prts } = await db.from('parts').select('id').eq('pn', pn).limit(1)
    if (!prts?.length) { const _r = await db.from('parts').select('id').eq('new_sku', pn).limit(1); prts = _r.data }
    prt = prts?.[0] || null
  }
  if (!asm && !prt) {
    console.warn('[SS] SKU not found in parts or assemblies - no deduction:', pn)
    _lastDeduct = 'notfound'
    return false
  }
  const kind: 'assembly' | 'part' = asm ? 'assembly' : 'part'
  const res = await stockDelta(kind, String((asm || prt).id), -qty)
  if (!res) {
    console.error('[SS] stock update FAILED for', pn)
    _lastDeduct = 'failed'
    return false
  }
  await db.from('inv_corrections').insert({ pn, previous_qty: res.prev, new_qty: res.next, adjustment: -qty, reason, source: 'shipment' })
  console.log('[SS] Deducted', qty, 'of', pn, '(' + kind + ') on', orderRef, '| on_hand:', res.prev, '->', res.next)
  _lastDeduct = 'deducted' // stock is down - a Shopify sync error below must not mark this as a failed deduction
  try { await syncShopifyBackorder(pn, res.next); if (kind === 'part') await cascadeShopifyBackorder(pn) } catch (e) { console.warn('[SS] Shopify sync after deduction failed', e) }
  return true
}

// [v23.77 #1] Who may call this function's ACTIONS (webhooks are separate and never gated). Mode comes from
// the EDGE_AUTH_MODE secret: 'log' (default - allow, but record every call without an ERP login in error_log
// so you can see which tool still needs updating), 'enforce' (refuse them), 'off'.
const EDGE_BUILD = 'v23.77'
const _gateLogged: Record<string, number> = {}
async function authGate(req: Request, fn: string, action: string): Promise<Response | null> {
  const mode = (Deno.env.get('EDGE_AUTH_MODE') || 'log').toLowerCase()
  if (mode === 'off') return null
  const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  let ok = false
  if (tok) { try { const r = await db.auth.getUser(tok); ok = !!(r && r.data && r.data.user) } catch (_) { ok = false } }
  if (ok) return null
  const origin = req.headers.get('origin') || req.headers.get('referer') || 'no origin'
  const key = action + '|' + origin
  if (!_gateLogged[key] || Date.now() - _gateLogged[key] > 3600000) { // at most once an hour per action+caller
    _gateLogged[key] = Date.now()
    try { await db.from('error_log').insert({ page: fn, app_version: 'edge ' + fn + ' ' + EDGE_BUILD, message: (mode === 'enforce' ? 'Refused' : 'Allowed (log mode)') + ' call without an ERP login: action "' + action + '" from ' + origin }) } catch (_) { /* logging must never block */ }
  }
  if (mode === 'enforce') return new Response(JSON.stringify({ error: 'Not signed in to the ERP - request refused' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const body = await req.json().catch(() => ({})) as any
  if (req.method === 'GET' || body.ping) return new Response('pong', { headers: CORS })
  if (body.action === 'version') return json({ fn: 'shipstation-ship', build: EDGE_BUILD })
  if (body.action || body.check_secrets) { // ShipStation's own webhooks carry resource_url, never an action
    const _gate = await authGate(req, 'shipstation-ship', String(body.action || 'check_secrets'))
    if (_gate) return _gate
  }
  if (body.check_secrets) {
    const k = Deno.env.get('SS_KEY') || '', s = Deno.env.get('SS_SECRET') || ''
    return json({ ss_key_set: k.length > 0, ss_key_length: k.length, ss_key_preview: k.length > 4 ? k.slice(0,2)+'...'+k.slice(-2) : '(empty)', ss_secret_set: s.length > 0, ss_secret_length: s.length, ss_secret_preview: s.length > 4 ? s.slice(0,2)+'...'+s.slice(-2) : '(empty)', ss_v2_key_set: (Deno.env.get('SS_V2_KEY') || '').length > 0 })
  }
  if (body.action === 'retry_pending_deductions') {
    return json(await retryPendingDeductions(200))
  }
  if (body.action === 'bulk_sync') {
    const auth = ssAuth()
    if (!Deno.env.get('SS_KEY')) return json({ error: 'SS_KEY or SS_SECRET not set' }, 400)
    const since = body.since || new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10)
    const until = body.until || new Date().toISOString().slice(0,10)
    const orderMap = await buildOrderMap()
    const norm = (s: string) => s.trim().toUpperCase()
    const updateGroups: any = {}
    const deductQueue: any[] = []
    let page = 1, totalPages = 1, synced = 0, skipped = 0, notFound = 0
    while (page <= totalPages) {
      const url = 'https://ssapi.shipstation.com/shipments?shipDateStart=' + since + '&shipDateEnd=' + until + '&pageSize=500&page=' + page + '&includeShipmentItems=true'
      const res = await fetch(url, { headers: { Authorization: 'Basic ' + auth } })
      if (!res.ok) return json({ error: 'ShipStation error ' + res.status }, 502)
      const data = await res.json()
      totalPages = data.pages || 1
      for (const ship of (data.shipments || [])) {
        if (ship.voided || !ship.trackingNumber) { skipped++; continue }
        const rawNum = stripHash(ship.orderNumber || '')
        const lines = orderMap[rawNum] || []
        if (!lines.length) { notFound++; continue }
        const rawSkus = (ship.shipmentItems || []).flatMap((i: any) => [i.sku, i.name].filter(Boolean))
        const allPns = lines.map((l: any) => l.pn as string)
        // [AUDIT] Exact SKU match first. The substring test alone let a short SKU (TGK-0404-01) match a
        // longer one on the same order (TGK-0404-01-HW), marking an unshipped line Shipped and deducting it.
        // Substring stays only as a last resort when nothing matched exactly.
        const _exact = allPns.filter(p => rawSkus.some((s: string) => norm(p) === norm(s)))
        const matched = rawSkus.length > 0
          ? (_exact.length ? _exact : allPns.filter(p => rawSkus.some((s: string) => { const e=norm(p),k=norm(s); return e===k||e.includes(k)||k.includes(e) })))
          : allPns
        const tracking = ship.trackingNumber
        const carrier = (ship.carrierCode || '').toUpperCase()
        const shippedAt = ship.shipDate ? new Date(ship.shipDate).toISOString() : new Date().toISOString()
        const gKey = tracking + '|' + carrier + '|' + shippedAt.slice(0,10)
        if (!updateGroups[gKey]) updateGroups[gKey] = { ids: [], tracking, carrier, shippedAt }
        for (const pn of matched) {
          const line = lines.find((l: any) => l.pn === pn)
          if (line) {
            updateGroups[gKey].ids.push(line.id)
            deductQueue.push({ id: line.id, pn, qty: line.qty || 1, tracking, order: rawNum })
          }
        }
        synced++
      }
      page++
    }
    await markDeductPending([...new Set(deductQueue.map((d: any) => d.id))] as string[], true)
    let applied = 0
    for (const g of Object.values(updateGroups)) {
      const deduped = [...new Set((g as any).ids)]
      for (let i = 0; i < deduped.length; i += 200) {
        await db.from('sales').update({
          fulfillment_status: 'Shipped', tracking_number: (g as any).tracking,
          carrier: (g as any).carrier, shipped_at: (g as any).shippedAt
        }).in('id', deduped.slice(i, i+200))
        applied += Math.min(200, deduped.length - i)
      }
    }
    let deducted = 0
    const seenLineIds = new Set()
    for (const d of deductQueue) {
      if (seenLineIds.has(d.id)) continue
      seenLineIds.add(d.id)
      const did = await deductLine({ id: d.id, pn: d.pn, qty: d.qty }, d.tracking, d.order)
      if (did && _lastDeduct === 'deducted') deducted++
    }
    return json({ synced, skipped, notFound, applied, deducted, pages: totalPages, message: 'Synced ' + synced + ' shipments, applied ' + applied + ' line updates, deducted ' + deducted + ' line(s)' })
  }
  if (body.action === 'hold_sync') {
    const auth = ssAuth()
    if (!Deno.env.get('SS_KEY')) return json({ error: 'SS_KEY or SS_SECRET not set' }, 400)
    const orderMap = await buildOrderMap()
    const norm = (s: string) => (s || '').trim().toUpperCase()

    // Fetch every on_hold and awaiting_shipment order up front (same two calls as before, just
    // collected before processing instead of interleaved) so every SKU seen anywhere can be
    // canonicalized in one batch pass before any matching happens.
    let page = 1, totalPages = 1
    const onHoldOrders: any[] = []
    while (page <= totalPages) {
      const res = await fetch('https://ssapi.shipstation.com/orders?orderStatus=on_hold&pageSize=500&page=' + page, { headers: { Authorization: 'Basic ' + auth } })
      if (!res.ok) return json({ error: 'ShipStation error ' + res.status }, 502)
      const data = await res.json()
      totalPages = data.pages || 1
      onHoldOrders.push(...(data.orders || []))
      page++
    }
    let rPage = 1, rTotalPages = 1
    const awaitingOrders: any[] = []
    while (rPage <= rTotalPages) {
      const relRes = await fetch('https://ssapi.shipstation.com/orders?orderStatus=awaiting_shipment&pageSize=500&page=' + rPage, { headers: { Authorization: 'Basic ' + auth } })
      if (!relRes.ok) break
      const relData = await relRes.json()
      rTotalPages = relData.pages || 1
      awaitingOrders.push(...(relData.orders || []))
      rPage++
    }

    // [FIX] Root cause confirmed on order #10497 via a live comparison: ShipStation's item list
    // was NOT truncated or reordered between endpoints (ruled that out first) - the actual bug
    // was comparing ShipStation's reported SKU directly against the raw sales.pn string. This
    // ERP has a known, previously-documented legacy-pn/new_sku duality on its own TGK-numbered
    // catalog (9 SKUs already flagged with a mismatch between the two fields). A sales row's pn
    // was captured verbatim from Shopify at order-creation time under WHICHEVER alias was live
    // then; if the underlying variant's SKU has since been repointed to the other alias,
    // ShipStation can report that line under a different string than what sales.pn still holds.
    // The two vendor drop-ship SKUs that released correctly aren't part of this catalog at all
    // (no assemblies/parts record, so no duality) - which is exactly why only they matched a
    // plain string comparison. Resolving both sides to the assembly/part's canonical pn before
    // comparing - same alias-resolution pattern deductForShipment and shopify-orders.ts's
    // fulfillment-mirroring already use elsewhere - fixes this regardless of which alias either
    // side happens to report.
    const allOrders = [...onHoldOrders, ...awaitingOrders]
    const rawSkuSet = new Set<string>()
    for (const o of allOrders) for (const i of (o.items || [])) {
      const sk = (i.sku || i.name || '').trim()
      if (sk) rawSkuSet.add(sk)
    }
    const involvedOrderNums = new Set(allOrders.map((o: any) => stripHash(o.orderNumber || '')))
    for (const num of involvedOrderNums) for (const l of (orderMap[num] || [])) if (l.pn) rawSkuSet.add(l.pn)
    const skuList = [...rawSkuSet]
    const canonMap: Record<string, string> = {}
    const chunk = <T,>(arr: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out }
    for (const c of chunk(skuList, 200)) {
      const { data: a1 } = await db.from('assemblies').select('pn').in('pn', c)
      ;(a1 || []).forEach((r: any) => { canonMap[norm(r.pn)] = r.pn })
      const { data: a2 } = await db.from('assemblies').select('pn,new_sku').in('new_sku', c)
      ;(a2 || []).forEach((r: any) => { if (r.new_sku) canonMap[norm(r.new_sku)] = r.pn })
      const { data: p1 } = await db.from('parts').select('pn').in('pn', c)
      ;(p1 || []).forEach((r: any) => { if (!(norm(r.pn) in canonMap)) canonMap[norm(r.pn)] = r.pn })
      const { data: p2 } = await db.from('parts').select('pn,new_sku').in('new_sku', c)
      ;(p2 || []).forEach((r: any) => { if (r.new_sku && !(norm(r.new_sku) in canonMap)) canonMap[norm(r.new_sku)] = r.pn })
    }
    // Falls back to the normalized raw string itself when nothing matched (e.g. drop-ship SKUs
    // with no assemblies/parts record at all) - identical to today's behavior for those.
    const canon = (raw: string): string => { const n = norm(raw); return canonMap[n] || n }

    let markedHold = 0, markedOpen = 0
    const stillOnHoldLineIds = new Set<string>()
    for (const order of onHoldOrders) {
      const rawNum = stripHash(order.orderNumber || '')
      const lines = orderMap[rawNum] || []
      const heldCanonSkus = new Set((order.items || []).map((i: any) => canon((i.sku || i.name || '').trim())).filter(Boolean))
      // [FIX] The protection set used to be built from the same Open/Packed-filtered list as the
      // write below, so a line ALREADY On Hold was never protected. On the run after a line was
      // held, it fell outside the set, the release pass saw it matching a ready sibling record,
      // and released it - then the following run held it again. It alternated every 5 minutes.
      // Every line an on-hold record contains is protected, whatever its current status; only the
      // WRITE is limited to lines that are not already held.
      lines.filter((l: any) => heldCanonSkus.has(canon(l.pn || ''))).forEach((l: any) => stillOnHoldLineIds.add(l.id as string))
      const ids = lines.filter((l: any) => ['Open','Packed'].includes(l.fulfillment_status) && heldCanonSkus.has(canon(l.pn || ''))).map((l: any) => l.id as string)
      if (ids.length) {
        await db.from('sales').update({ fulfillment_status: 'On Hold' }).in('id', ids)
        markedHold += ids.length
      }
    }
    const { data: heldLines } = await db.from('sales').select('id,order_number,pn').eq('fulfillment_status', 'On Hold').limit(5000)
    if (heldLines?.length) {
      for (const order of awaitingOrders) {
        const rawNum = stripHash(order.orderNumber || '')
        const readyCanonSkus = new Set((order.items || []).map((i: any) => canon((i.sku || i.name || '').trim())).filter(Boolean))
        const toRelease = (heldLines || []).filter((l: any) =>
          stripHash(l.order_number || '') === rawNum
          && !stillOnHoldLineIds.has(l.id)
          && readyCanonSkus.has(canon(l.pn || ''))
        ).map((l: any) => l.id as string)
        if (toRelease.length) {
          await db.from('sales').update({ fulfillment_status: 'Open' }).in('id', toRelease)
          markedOpen += toRelease.length
        }
      }
    }
    return json({ markedHold, markedOpen, message: markedHold + ' marked On Hold, ' + markedOpen + ' released to Open' })
  }
  if (body.action === 'cancel_sync') {
    if (!Deno.env.get('SS_KEY')) return json({ error: 'SS_KEY not set' }, 400)
    const auth = ssAuth()
    const days = body.days || 30
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    let page = 1, totalPages = 1, markedCancelled = 0
    while (page <= totalPages) {
      const res = await fetch('https://ssapi.shipstation.com/orders?orderStatus=cancelled&pageSize=500&page=' + page + '&modifyDateStart=' + since, { headers: { Authorization: 'Basic ' + auth } })
      if (!res.ok) return json({ error: 'ShipStation error ' + res.status }, 502)
      const data = await res.json()
      totalPages = data.pages || 1
      for (const order of (data.orders || [])) {
        const rawNum = stripHash(order.orderNumber || '')
        if (!rawNum) continue
        const { data: ex1 } = await db.from('sales').select('id,fulfillment_status').eq('order_number', '#' + rawNum).in('fulfillment_status', ['Open','Packed','Partial','On Hold']).limit(1)
        const { data: ex2 } = await db.from('sales').select('id,fulfillment_status').eq('order_number', rawNum).in('fulfillment_status', ['Open','Packed','Partial','On Hold']).limit(1)
        const resolvedNum = ex1?.length ? '#' + rawNum : rawNum
        const found = (ex1?.length || 0) + (ex2?.length || 0)
        if (found) {
          await db.from('sales').update({ fulfillment_status: 'Cancelled', cancelled_at: new Date().toISOString() }).eq('order_number', resolvedNum).in('fulfillment_status', ['Open','Packed','Partial','On Hold'])
          markedCancelled += found
        }
      }
      page++
    }
    return json({ markedCancelled, message: markedCancelled + ' orders marked Cancelled' })
  }
  if (body.action === 'hold_sync_debug') {
    if (!Deno.env.get('SS_KEY')) return json({ error: 'SS_KEY not set' }, 400)
    const auth = ssAuth()
    const ssRes = await fetch('https://ssapi.shipstation.com/orders?orderStatus=on_hold&pageSize=50&page=1', { headers: { Authorization: 'Basic ' + auth } })
    if (!ssRes.ok) return json({ error: 'ShipStation error ' + ssRes.status }, 502)
    const ssData = await ssRes.json()
    const ssOrders = (ssData.orders || []).map((o: any) => ({
      raw: o.orderNumber,
      stripped: stripHash(o.orderNumber || ''),
      status: o.orderStatus,
      customer: o.shipTo?.name || '',
    }))
    const { data: erpSample } = await db.from('sales')
      .select('order_number,fulfillment_status')
      .in('fulfillment_status', ['Open','Packed','Partial','On Hold'])
      .limit(20)
    const erpSample2 = (erpSample || []).map((r: any) => ({
      raw: r.order_number,
      stripped: stripHash(r.order_number || ''),
      status: r.fulfillment_status
    }))
    const erpKeys = new Set((erpSample || []).map((r: any) => stripHash(r.order_number || '')))
    const matches = ssOrders.filter((o: any) => erpKeys.has(o.stripped))
    return json({
      ss_on_hold_count: ssData.total || ssOrders.length,
      ss_on_hold_sample: ssOrders.slice(0, 10),
      erp_open_sample: erpSample2.slice(0, 10),
      matches_found: matches.length,
      matched_orders: matches,
      diagnosis: ssOrders.length === 0
        ? 'ShipStation returned 0 on-hold orders - nothing to sync'
        : matches.length === 0
          ? 'SS has on-hold orders but NONE match ERP order numbers - likely a format mismatch. Compare ss_on_hold_sample vs erp_open_sample.'
          : matches.length + ' orders matched - hold_sync should work. Run normal hold_sync to apply.'
    })
  }
  if (body.action === 'inspect_order') {
    // [DEBUG] One-shot inspection tool, same purpose as hold_sync_debug above but for a
    // different failure: an order ShipStation has split into multiple shipments UNDER THE SAME
    // order number (Jon found #10497 showing this way - one shipment on_hold, one
    // awaiting_shipment, both labeled "Order #10497" in ShipStation's own UI). Neither hold_sync
    // nor the ORDER_NOTIFY webhook has ever looked past orderNumber to see which SKUs belong to
    // which shipment - both currently flip EVERY non-terminal sales row sharing that order
    // number to On Hold the moment ANY shipment for that order number reports on_hold. This is
    // a different case from the existing ss_order_links "split creates a new order number"
    // mechanism, which does not apply here since the order number is identical.
    //
    // This dumps the raw ShipStation response for both the /orders and /shipments endpoints for
    // one order number, unfiltered, so the actual field that distinguishes shipment membership
    // (a shipmentId, a per-item status, something else entirely) can be identified before
    // guessing at a fix. Deploy this, hit it once with the order number, paste the JSON back.
    if (!Deno.env.get('SS_KEY')) return json({ error: 'SS_KEY not set' }, 400)
    const auth = ssAuth()
    const orderNumber = String(body.orderNumber || body.order_number || '').trim()
    if (!orderNumber) return json({ error: 'orderNumber is required' }, 400)
    const results: any = { orderNumber }
    try {
      const ordersRes = await fetch('https://ssapi.shipstation.com/orders?orderNumber=' + encodeURIComponent(orderNumber) + '&pageSize=50', { headers: { Authorization: 'Basic ' + auth } })
      results.orders_endpoint_status = ordersRes.status
      results.orders = ordersRes.ok ? await ordersRes.json() : await ordersRes.text()
    } catch (e) { results.orders_error = String((e as any)?.message || e) }
    try {
      const shipRes = await fetch('https://ssapi.shipstation.com/shipments?orderNumber=' + encodeURIComponent(orderNumber) + '&pageSize=50&includeShipmentItems=true', { headers: { Authorization: 'Basic ' + auth } })
      results.shipments_endpoint_status = shipRes.status
      results.shipments = shipRes.ok ? await shipRes.json() : await shipRes.text()
    } catch (e) { results.shipments_error = String((e as any)?.message || e) }
    // [DEBUG] Second theory to test: hold_sync got 2 of 7 releasable lines right on #10497
    // (both drop-ship, no ERP stock record) and left 5 real-inventory SKUs stuck On Hold, even
    // though their SKUs are plainly present in the unfiltered /orders?orderNumber= response
    // above. hold_sync's release pass does NOT use that unfiltered call though - it walks
    // /orders?orderStatus=awaiting_shipment&pageSize=500 (the bulk LIST endpoint) and reads
    // order.items straight off each entry in that list. If ShipStation's list endpoint returns a
    // truncated or reordered items array compared to the single-order lookup, that would exactly
    // explain a partial release. This re-fetches using the SAME status+orderNumber combined
    // filter hold_sync's release loop effectively narrows down to (proven elsewhere in this file,
    // in the ORDER_NOTIFY on_hold recheck) and reports item counts side by side with the
    // unfiltered lookup above, per orderId, so the two can be compared directly instead of
    // guessed at.
    try {
      const directOrders = (results.orders && results.orders.orders) || []
      const compare: any[] = []
      for (const o of directOrders) {
        const statusFilteredRes = await fetch('https://ssapi.shipstation.com/orders?orderNumber=' + encodeURIComponent(orderNumber) + '&orderStatus=' + encodeURIComponent(o.orderStatus || '') + '&pageSize=50', { headers: { Authorization: 'Basic ' + auth } })
        const statusFilteredData = statusFilteredRes.ok ? await statusFilteredRes.json() : null
        const matchInFiltered = (statusFilteredData?.orders || []).find((x: any) => x.orderId === o.orderId)
        compare.push({
          orderId: o.orderId,
          orderStatus: o.orderStatus,
          direct_lookup_item_count: (o.items || []).length,
          direct_lookup_skus: (o.items || []).map((i: any) => i.sku || i.name),
          status_filtered_endpoint_status: statusFilteredRes.status,
          status_filtered_item_count: matchInFiltered ? (matchInFiltered.items || []).length : null,
          status_filtered_skus: matchInFiltered ? (matchInFiltered.items || []).map((i: any) => i.sku || i.name) : null,
          found_in_status_filtered_list: !!matchInFiltered
        })
      }
      results.item_count_comparison = compare
    } catch (e) { results.compare_error = String((e as any)?.message || e) }
    return json(results)
  }
  if (body.action === 'repair_split_order') {
    // [FIX] Repairs the concrete damage from the duplicate-row / wrong-tracking bug (order
    // #10497): a duplicate sales row per canonical SKU (created by the now-fixed alias mismatch
    // in shopify-orders.ts's orders/updated reconciliation), each possibly carrying a bogus
    // tracking number and a bogus inventory deduction from the now-fixed matchedPns fallback in
    // the webhook handler above. Ground truth is pulled fresh from ShipStation itself rather than
    // trusted from the ERP's own (corrupted) rows:
    //   - what ACTUALLY shipped -> /shipments (real, non-voided shipment records + their items)
    //   - what is genuinely still open/on-hold right now -> /orders (current order status)
    //   - what was actually deducted -> inv_corrections, tied to the specific tracking numbers
    // Everything is matched through the same canonical-pn resolution as the other fixes, so a
    // duplicate created under one SKU alias is still recognized as the same physical item as the
    // original row under the other alias.
    //
    // Two modes: apply:false (default) computes and RETURNS the full repair plan without writing
    // anything - review this before rerunning with apply:true. apply:true executes exactly that
    // plan: reverses any inventory wrongly deducted under a bogus tracking number, applies a
    // correct deduction if a genuine shipment's deduction never actually landed, updates ONE
    // surviving row per canonical SKU to the real ground-truth state (normalizing its pn to the
    // canonical form in the process), and deletes the other duplicate row(s).
    // Any group this can't confidently resolve (e.g. rows disagree on qty, or ShipStation has no
    // record at all for that SKU) is left completely untouched and flagged under "issues" for
    // manual review instead of being guessed at.
    if (!Deno.env.get('SS_KEY')) return json({ error: 'SS_KEY not set' }, 400)
    const auth = ssAuth()
    const orderNumber = String(body.orderNumber || body.order_number || '').trim()
    if (!orderNumber) return json({ error: 'orderNumber is required' }, 400)
    const apply = body.apply === true
    const norm = (s: string) => (s || '').trim().toUpperCase()

    const shipRes = await fetch('https://ssapi.shipstation.com/shipments?orderNumber=' + encodeURIComponent(orderNumber) + '&pageSize=50&includeShipmentItems=true', { headers: { Authorization: 'Basic ' + auth } })
    if (!shipRes.ok) return json({ error: 'ShipStation shipments lookup failed: ' + shipRes.status }, 502)
    const shipData = await shipRes.json()
    const realShipments = (shipData.shipments || []).filter((sh: any) => !sh.voided)

    const ordRes = await fetch('https://ssapi.shipstation.com/orders?orderNumber=' + encodeURIComponent(orderNumber) + '&pageSize=50', { headers: { Authorization: 'Basic ' + auth } })
    if (!ordRes.ok) return json({ error: 'ShipStation orders lookup failed: ' + ordRes.status }, 502)
    const ordData = await ordRes.json()
    const orderRecords = ordData.orders || []

    // [FIX] sales.order_number is stored exactly as Shopify's order.name, which normally includes
    // the leading '#' (e.g. '#10497') - every other place in this file that looks up a sales row
    // by order number already tries both forms (see erpOrderNumberFor, cancel_sync, etc.); this
    // action needs the same, or a bare-number lookup like the one just used above 404s even
    // though the rows are right there under the '#' form.
    const { data: erpRowsBare } = await db.from('sales')
      .select('id,pn,qty,fulfillment_status,tracking_number,carrier,shipped_at,created_at')
      .eq('order_number', orderNumber)
    const { data: erpRowsHash } = await db.from('sales')
      .select('id,pn,qty,fulfillment_status,tracking_number,carrier,shipped_at,created_at')
      .eq('order_number', '#' + orderNumber)
    const erpRows = (erpRowsBare?.length ? erpRowsBare : null) || erpRowsHash || []
    if (!erpRows.length) return json({ error: 'No sales rows found for order_number ' + orderNumber + ' (tried both "' + orderNumber + '" and "#' + orderNumber + '")' }, 404)

    const aliasCandidates = new Set<string>()
    erpRows.forEach((r: any) => { if (r.pn) aliasCandidates.add(r.pn) })
    realShipments.forEach((sh: any) => (sh.shipmentItems || []).forEach((i: any) => { const v = (i.sku || i.name || '').trim(); if (v) aliasCandidates.add(v) }))
    orderRecords.forEach((o: any) => (o.items || []).forEach((i: any) => { const v = (i.sku || i.name || '').trim(); if (v) aliasCandidates.add(v) }))
    const aliasList = [...aliasCandidates]
    const canonMap: Record<string, string> = {}
    if (aliasList.length) {
      const { data: a1 } = await db.from('assemblies').select('pn').in('pn', aliasList)
      ;(a1 || []).forEach((r: any) => { canonMap[norm(r.pn)] = r.pn })
      const { data: a2 } = await db.from('assemblies').select('pn,new_sku').in('new_sku', aliasList)
      ;(a2 || []).forEach((r: any) => { if (r.new_sku) canonMap[norm(r.new_sku)] = r.pn })
      const { data: p1 } = await db.from('parts').select('pn').in('pn', aliasList)
      ;(p1 || []).forEach((r: any) => { if (!(norm(r.pn) in canonMap)) canonMap[norm(r.pn)] = r.pn })
      const { data: p2 } = await db.from('parts').select('pn,new_sku').in('new_sku', aliasList)
      ;(p2 || []).forEach((r: any) => { if (r.new_sku && !(norm(r.new_sku) in canonMap)) canonMap[norm(r.new_sku)] = r.pn })
    }
    const canon = (raw: string): string => { const n = norm(raw); return canonMap[n] || n }

    const shippedTruth: Record<string, { trackingNumber: string, carrier: string, shippedAt: string }> = {}
    for (const sh of realShipments) {
      for (const item of (sh.shipmentItems || [])) {
        const c = canon((item.sku || item.name || '').trim())
        if (!c || shippedTruth[c]) continue
        shippedTruth[c] = { trackingNumber: sh.trackingNumber, carrier: (sh.carrierCode || '').toUpperCase(), shippedAt: sh.shipDate ? new Date(sh.shipDate).toISOString() : new Date().toISOString() }
      }
    }
    const distinctRealTrackings = new Set(Object.values(shippedTruth).map(v => v.trackingNumber))
    const currentStatusTruth: Record<string, string> = {}
    for (const ord of orderRecords) {
      for (const item of (ord.items || [])) {
        const c = canon((item.sku || item.name || '').trim())
        if (!c || (c in currentStatusTruth)) continue
        currentStatusTruth[c] = ord.orderStatus
      }
    }
    const fsMap: Record<string, string> = { awaiting_shipment: 'Open', on_hold: 'On Hold', pending_fulfillment: 'Open', awaiting_payment: 'Open' }

    const groupsBy: Record<string, any[]> = {}
    for (const r of erpRows) { const c = canon(r.pn || ''); (groupsBy[c] = groupsBy[c] || []).push(r) }

    const report: any[] = []
    for (const [c, rows] of Object.entries(groupsBy)) {
      if (rows.length < 2) continue
      const qtySet = new Set(rows.map((r: any) => r.qty || 1))
      const issues: string[] = []
      if (qtySet.size > 1) issues.push('rows in this group disagree on qty (' + [...qtySet].join(', ') + ') - skipped, needs manual review')
      const group: any = {
        canonicalSku: c,
        rows: rows.map((r: any) => ({ id: r.id, pn: r.pn, qty: r.qty, fulfillment_status: r.fulfillment_status, tracking_number: r.tracking_number, carrier: r.carrier })),
        issues
      }
      if (issues.length) { report.push(group); continue }

      const qty = rows[0].qty || 1
      const realShip = shippedTruth[c] || null
      const curStatus = currentStatusTruth[c] || null
      let target: any
      if (realShip) {
        target = { pn: c, fulfillment_status: 'Shipped', tracking_number: realShip.trackingNumber, carrier: realShip.carrier, shipped_at: realShip.shippedAt, is_split_shipment: distinctRealTrackings.size > 1 }
      } else if (curStatus && fsMap[curStatus]) {
        target = { pn: c, fulfillment_status: fsMap[curStatus], tracking_number: null, carrier: null, shipped_at: null }
      } else {
        group.issues.push('no ShipStation ground truth found for this SKU (not in any real shipment, not in a current order record) - skipped, needs manual review')
        report.push(group)
        continue
      }

      const sorted = rows.slice().sort((a: any, b: any) => String(a.created_at || a.id).localeCompare(String(b.created_at || b.id)))
      const keeper = rows.find((r: any) => target.tracking_number && r.tracking_number === target.tracking_number) || sorted[0]
      const toDelete = rows.filter((r: any) => r.id !== keeper.id)

      const groupAliases = [...new Set(rows.map((r: any) => r.pn))]
      const bogusTrackings = [...new Set(rows.map((r: any) => r.tracking_number).filter(Boolean).filter((t: string) => t !== (realShip?.trackingNumber || null)))]
      const inventoryOps: any[] = []
      for (const bt of bogusTrackings) {
        for (const alias of groupAliases) {
          const { data: badDeds } = await db.from('inv_corrections').select('id,adjustment').eq('source', 'shipment').eq('pn', alias).ilike('reason', '%' + bt + '%')
          for (const d of (badDeds || [])) {
            inventoryOps.push({ type: 'reverse', pn: c, qty: Math.abs(d.adjustment || 0), badTracking: bt })
          }
        }
      }
      if (realShip) {
        let realDeductionFound = false
        for (const alias of groupAliases) {
          const { data: goodDeds } = await db.from('inv_corrections').select('id').eq('source', 'shipment').eq('pn', alias).ilike('reason', '%' + realShip.trackingNumber + '%')
          if (goodDeds && goodDeds.length) realDeductionFound = true
        }
        if (!realDeductionFound) inventoryOps.push({ type: 'deduct', pn: c, qty, tracking: realShip.trackingNumber })
      }

      group.plan = { keepRowId: keeper.id, target, deleteRowIds: toDelete.map((r: any) => r.id), inventoryOps }
      report.push(group)

      if (apply) {
        for (const op of group.plan.inventoryOps) {
          if (op.type === 'reverse') {
            const { data: asm } = await db.from('assemblies').select('id,total_on_hand').eq('pn', c).limit(1)
            if (asm?.length) {
              const prev = asm[0].total_on_hand || 0, next = prev + op.qty
              await db.from('assemblies').update({ total_on_hand: next, updated_at: new Date().toISOString() }).eq('id', asm[0].id)
              await db.from('inv_corrections').insert({ pn: c, previous_qty: prev, new_qty: next, adjustment: op.qty, reason: 'Reversal of duplicate-row deduction (bogus tracking ' + op.badTracking + ') - order ' + orderNumber, source: 'correction' })
              op.applied = true
            } else {
              const { data: prt } = await db.from('parts').select('id,total_unpckgd').eq('pn', c).limit(1)
              if (prt?.length) {
                const prev = prt[0].total_unpckgd || 0, next = prev + op.qty
                await db.from('parts').update({ total_unpckgd: next, updated_at: new Date().toISOString() }).eq('id', prt[0].id)
                await db.from('inv_corrections').insert({ pn: c, previous_qty: prev, new_qty: next, adjustment: op.qty, reason: 'Reversal of duplicate-row deduction (bogus tracking ' + op.badTracking + ') - order ' + orderNumber, source: 'correction' })
                op.applied = true
              } else {
                // [FIX] Should not be reachable in practice - a group only gets here because its
                // canonical SKU already resolved to a real assemblies/parts row earlier - but a
                // silent no-op on an inventory correction is exactly the kind of thing that must
                // never happen invisibly. Surfaced in both the log and the returned report instead.
                console.warn('[repair_split_order] reversal skipped - canonical pn', c, 'matches neither assemblies nor parts')
                op.applied = false
                op.note = 'SKIPPED - canonical pn matches neither assemblies nor parts, nothing to correct against'
              }
            }
          } else if (op.type === 'deduct') {
            op.applied = await deductForShipment(c, op.qty, op.tracking, orderNumber)
          }
        }
        await db.from('sales').update(group.plan.target).eq('id', group.plan.keepRowId)
        for (const delId of group.plan.deleteRowIds) {
          await db.from('sales').delete().eq('id', delId)
        }
      }
    }

    return json({ orderNumber, apply, groupsWithDuplicates: report.length, report, note: apply ? 'Plan executed - check each group.plan.inventoryOps[].applied for per-op confirmation.' : 'Dry run only - nothing was written. Review "report", then rerun with apply:true to execute exactly this plan.' })
  }
  if (body.action === 'delivery_sync') {
    const auth = ssAuth()
    if (!Deno.env.get('SS_KEY')) return json({ error: 'SS_KEY or SS_SECRET not set' }, 400)
    const since = body.since || new Date(Date.now() - 45*24*60*60*1000).toISOString().slice(0,10)
    const { data: shipped } = await db.from('sales')
      .select('id,order_number,tracking_number')
      .eq('fulfillment_status', 'Shipped')
      .not('tracking_number', 'is', null)
      .limit(2000)
    if (!shipped?.length) return json({ delivered: 0, message: 'No shipped orders to check' })
    const trackMap: any = {}
    for (const s of (shipped || [])) trackMap[(s.tracking_number || '').toUpperCase()] = s.id
    const res = await fetch('https://ssapi.shipstation.com/shipments?shipDateStart=' + since + '&pageSize=500&includeShipmentItems=false', { headers: { Authorization: 'Basic ' + auth } })
    if (!res.ok) return json({ error: 'ShipStation error ' + res.status }, 502)
    const data = await res.json()
    const toDeliver: string[] = []
    for (const ship of (data.shipments || [])) {
      if (!ship.deliveryDate && ship.shipmentStatus !== 'delivered') continue
      const id = trackMap[(ship.trackingNumber || '').toUpperCase()]
      if (id) toDeliver.push(id)
    }
    let delivered = 0
    const now = new Date().toISOString()
    for (let i = 0; i < toDeliver.length; i += 200) {
      await db.from('sales').update({ fulfillment_status: 'Delivered', delivered_at: now }).in('id', toDeliver.slice(i, i+200))
      delivered += Math.min(200, toDeliver.length - i)
    }
    return json({ delivered, checked: shipped?.length || 0, message: delivered + ' orders marked Delivered' })
  }
  if (body.action === 'track_po') {
    const trackingNum = (body.tracking || '').trim()
    const rawCarrier = (body.carrier || '').trim()
    const poTrackingId = body.po_tracking_id || null
    if (!trackingNum) return json({ error: 'tracking number required' }, 400)

    const v2key = Deno.env.get('SS_V2_KEY') || ''
    if (!v2key) {
      return json({ error: 'Live ETA needs a ShipStation V2 API key. Set the SS_V2_KEY secret, or use the Carrier link on the PO line.' }, 501)
    }

    const cu = rawCarrier.toUpperCase()
    const carrierCode =
        cu.includes('FEDEX') || cu.includes('FED') ? 'fedex'
      : cu.includes('UPS') ? 'ups'
      : cu.includes('USPS') || cu.includes('STAMPS') || cu.includes('ENDICIA') ? 'stamps_com'
      : cu.includes('DHL') ? 'dhl_express'
      : cu.includes('ONTRAC') ? 'ontrac'
      : cu.toLowerCase()

    const trackUrl = 'https://api.shipstation.com/v2/tracking'
      + '?carrier_code=' + encodeURIComponent(carrierCode)
      + '&tracking_number=' + encodeURIComponent(trackingNum)

    const res = await fetch(trackUrl, { headers: { 'API-Key': v2key } })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.warn('[track_po] V2 tracking', res.status, carrierCode, trackingNum, detail.slice(0, 300))
      return json({
        error: 'ShipStation V2 tracking ' + res.status
          + (res.status === 404 ? ' - carrier/tracking pair not recognised (is this carrier connected in ShipStation?)' : '')
          + (res.status === 401 || res.status === 403 ? ' - SS_V2_KEY rejected' : '')
          + (detail ? ' - ' + detail.slice(0, 180) : '')
      }, res.status)
    }
    const data = await res.json()
    const estimatedDelivery = data.estimated_delivery_date ? String(data.estimated_delivery_date).slice(0, 10) : null
    const statusDesc = data.status_description || data.carrier_status_description || data.status_code || null
    if (poTrackingId && (estimatedDelivery || statusDesc)) {
      const patch: any = { updated_at: new Date().toISOString() }
      if (estimatedDelivery) patch.estimated_delivery = estimatedDelivery
      if (statusDesc) patch.carrier_status = statusDesc
      await db.from('po_tracking').update(patch).eq('id', poTrackingId)
    }
    return json({ estimatedDelivery, statusDesc, events: (data.events || []).slice(0, 5) })
  }
  if (body.action === 'ss_order_audit') {
    if (!Deno.env.get('SS_KEY')) return json({ error: 'SS_KEY not set' }, 400)
    const auth = ssAuth()
    const days = body.days || 90
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const doImport = body.import === true
    const stripH = (s: string) => (s || '').replace(/^#/, '')
    const allSSOrders: any[] = []
    for (const status of ['awaiting_shipment', 'on_hold', 'awaiting_payment', 'pending_fulfillment', 'shipped']) {
      let p = 1, pages = 1
      while (p <= pages && p <= 5) {
        const r = await fetch(
          'https://ssapi.shipstation.com/orders?orderStatus=' + status + '&pageSize=500&page=' + p + '&modifyDateStart=' + since,
          { headers: { Authorization: 'Basic ' + auth } }
        )
        if (!r.ok) break
        const d = await r.json()
        pages = d.pages || 1
        allSSOrders.push(...(d.orders || []))
        p++
      }
    }
    const seenNums = new Set()
    const uniqueSSOrders = allSSOrders.filter((o: any) => {
      const k = stripH(o.orderNumber || '')
      if (!k || seenNums.has(k)) return false
      seenNums.add(k)
      return true
    })
    const erpFound = new Set()
    const ssNums = uniqueSSOrders.map((o: any) => stripH(o.orderNumber || ''))
    for (let i = 0; i < ssNums.length; i += 100) {
      const chunk = ssNums.slice(i, i + 100)
      const bothForms = [...chunk, ...chunk.map((n: string) => '#' + n)]
      const { data: rows } = await db.from('sales').select('order_number').in('order_number', bothForms).limit(bothForms.length)
      for (const r of (rows || [])) erpFound.add(stripH(r.order_number || ''))
    }
    const { data: knownLinks } = await db.from('ss_order_links').select('ss_order_number')
    const linkedChildren = new Set((knownLinks || []).map((l: any) => stripH(l.ss_order_number || '')))
    const splitChildren = uniqueSSOrders.filter((o: any) =>
      linkedChildren.has(stripH(o.orderNumber || '')) || o?.advancedOptions?.parentId || o?.advancedOptions?.parentOrderId)
    const splitChildNums = new Set(splitChildren.map((o: any) => stripH(o.orderNumber || '')))
    const missing = uniqueSSOrders.filter((o: any) =>
      !erpFound.has(stripH(o.orderNumber || '')) && !splitChildNums.has(stripH(o.orderNumber || '')))
    let imported = 0
    if (doImport) {
      const fsMap: any = { awaiting_shipment: 'Open', on_hold: 'On Hold', shipped: 'Shipped', cancelled: 'Cancelled', awaiting_payment: 'Open', pending_fulfillment: 'Open' }
      for (const order of missing) {
        const fs = fsMap[order.orderStatus] || 'Open'
        for (const item of (order.items || [])) {
          const pn = item.sku ? item.sku.trim().toUpperCase() : (item.name || '').trim()
          if (!pn) continue
          const _auditQty = ssItemQty(item)
          if (_auditQty <= 0) { console.log('[SS] ss_order_audit: skipping zero-quantity line', order.orderNumber, pn); continue }
          const { data: ex } = await db.from('sales').select('id').in('order_number', [order.orderNumber, '#' + order.orderNumber]).eq('pn', pn).limit(1)
          if (ex?.length) continue
          await db.from('sales').insert({
            order_number: order.orderNumber, pn,
            qty: _auditQty, fulfillment_status: fs,
            source: 'ShipStation Import',
            sale_date: centralDateOnly(order.orderDate),
            customer_name: order.shipTo?.name || null,
            customer_email: order.customerEmail || null,
            created_at: order.orderDate
              ? new Date(order.orderDate.slice(0, 10) + 'T12:00:00.000Z').toISOString()
              : new Date().toISOString(),
          })
          imported++
        }
      }
    }
    return json({
      ssTotal: uniqueSSOrders.length,
      erpFound: erpFound.size,
      missingCount: missing.length,
      splitChildCount: splitChildren.length,
      splitChildren: splitChildren.map((o: any) => ({ orderNumber: o.orderNumber, parentId: o?.advancedOptions?.parentId ?? o?.advancedOptions?.parentOrderId ?? null })),
      imported,
      missing: missing.map((o: any) => ({
        orderNumber: o.orderNumber,
        date: (o.orderDate || '').slice(0, 10),
        customer: o.shipTo?.name || '',
        status: o.orderStatus,
        tracking: o.trackingNumber || '',
        carrier: (o.carrierCode || '').toUpperCase(),
        items: (o.items || []).map((i: any) => ({ sku: i.sku || i.name, qty: ssItemQty(i) }))
      }))
    })
  }
  if (body.action === 'ss_import_batch') {
    const orders = body.orders || []
    const fsMap: any = { awaiting_shipment: 'Open', on_hold: 'On Hold', shipped: 'Shipped', cancelled: 'Cancelled', awaiting_payment: 'Open', pending_fulfillment: 'Open' }
    let imported = 0
    for (const order of orders) {
      const fs = fsMap[order.status] || 'Open'
      for (const item of (order.items || [])) {
        const pn = (item.sku || '').trim().toUpperCase()
        if (!pn) continue
        // This path receives items already mapped by the caller (ss_order_audit's report shape),
        // so the field is `qty` rather than ShipStation's raw `quantity` - same zero handling.
        const _batchQty = (item.qty === undefined || item.qty === null) ? 1 : Number(item.qty)
        if (_batchQty <= 0) { console.log('[SS] ss_import_batch: skipping zero-quantity line', order.orderNumber, pn); continue }
        const { data: ex } = await db.from('sales').select('id')
          .in('order_number', [order.orderNumber, '#' + order.orderNumber])
          .eq('pn', pn).limit(1)
        if (ex?.length) continue
        await db.from('sales').insert({
          order_number: order.orderNumber, pn,
          qty: _batchQty, fulfillment_status: fs,
          source: 'ShipStation Import',
          sale_date: order.date || centralDateOnly(),
          customer_name: order.customer || null,
          tracking_number: order.tracking || null,
          carrier: order.carrier || null,
          created_at: order.date ? new Date(order.date + 'T12:00:00.000Z').toISOString() : new Date().toISOString(),
        })
        imported++
      }
    }
    return json({ imported })
  }
  const { resource_url, resource_type } = body
  console.log('[SS]', resource_type, resource_url)
  if (body.action === 'create_order') {
    if (!Deno.env.get('SS_KEY')) return json({ error: 'SS_KEY not set' }, 400)
    const auth = ssAuth()
    const { orderNumber, customerName, customerEmail, pn, description, qty, shipTo, internalNotes, ssItems } = body
    if (!orderNumber || !pn) return json({ error: 'orderNumber and pn are required' }, 400)
    const items = (Array.isArray(ssItems) && ssItems.length)
      ? ssItems.map((it: any, i: number) => ({ lineItemKey: String(i + 1), sku: it.sku || it.pn || pn, name: it.name || it.description || it.sku || pn, quantity: it.quantity || it.qty || 1, unitPrice: 0 }))
      : [{ lineItemKey: '1', sku: pn, name: description || pn, quantity: qty || 1, unitPrice: 0 }]
    const safe = shipTo || {}
    const addrName = safe.name || customerName || 'Customer'
    const billToObj = { name: addrName, street1: safe.street1 || '', city: safe.city || '', state: safe.state || '', postalCode: safe.postal_code || '', country: safe.country || 'US' }
    const shipToObj = { ...billToObj, ...(safe.street2 ? { street2: safe.street2 } : {}) }
    const ssPayload = {
      orderNumber,
      orderDate: new Date().toISOString(),
      orderStatus: 'awaiting_shipment',
      customerUsername: customerEmail || undefined,
      customerEmail: customerEmail || undefined,
      billTo: billToObj,
      shipTo: shipToObj,
      items,
      internalNotes: internalNotes || ('TGK ERP order - ' + orderNumber),
      advancedOptions: { source: 'TGK ERP' }
    }
    const ssRes2 = await fetch('https://ssapi.shipstation.com/orders/createorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + auth },
      body: JSON.stringify(ssPayload)
    })
    const ssRaw2 = await ssRes2.text()
    let ssData2: any = {}
    try { ssData2 = JSON.parse(ssRaw2) } catch (_) {}
    if (!ssRes2.ok) return json({ error: 'ShipStation ' + ssRes2.status + ': ' + (ssData2.ExceptionMessage || ssData2.message || ssRaw2.slice(0, 300)) }, 502)
    return json({ orderId: ssData2.orderId, orderNumber: ssData2.orderNumber, status: ssData2.orderStatus })
  }
  if (body.action === 'check_tracking') {
    if (!Deno.env.get('SS_KEY')) return json({ error: 'SS_KEY not set' }, 400)
    const auth = ssAuth()
    const orders = body.orders || []
    const results = []
    for (const ord of orders) {
      try {
        const res = await fetch('https://ssapi.shipstation.com/shipments?orderNumber=' + encodeURIComponent(ord.orderNumber) + '&pageSize=10', {
          headers: { Authorization: 'Basic ' + auth }
        })
        if (!res.ok) continue
        const payload = await res.json()
        const ship = (payload.shipments || [])[0]
        if (!ship?.trackingNumber) continue
        const tracking = ship.trackingNumber
        const carrier = (ship.carrierCode || '').toUpperCase()
        const shippedAt = ship.shipDate || new Date().toISOString()
        if (ord.type === 'warranty') {
          await db.from('warranty_claims').update({ tracking_number: tracking, carrier, shipped_at: shippedAt, status: 'Shipped' }).eq('id', ord.id)
        } else {
          await db.from('shipment_errors').update({ tracking_number: tracking, carrier, shipped_at: shippedAt }).eq('id', ord.id)
        }
        results.push({ id: ord.id, type: ord.type, tracking, carrier })
      } catch (_) {  }
    }
    return json({ updated: results.length, results })
  }
  if (body.action === 'get_box_dimensions') {
    if (!Deno.env.get('SS_KEY')) return json({ error: 'SS_KEY not set' }, 400)
    const orderNumber = String(body.orderNumber || '')
    if (!orderNumber) return json({ error: 'orderNumber is required' }, 400)
    const auth = ssAuth()
    try {
      const res = await fetch('https://ssapi.shipstation.com/shipments?orderNumber=' + encodeURIComponent(orderNumber) + '&pageSize=5', {
        headers: { Authorization: 'Basic ' + auth }
      })
      if (!res.ok) return json({ error: 'ShipStation request failed (' + res.status + ')' }, 502)
      const payload = await res.json()
      const ship = (payload.shipments || [])[0]
      if (!ship) return json({ ok: true, found: false, note: 'No shipment on file yet for this order' })
      const dims = ship.dimensions
      // [FEATURE] 0" x 0" x 0" is NOT the same as "nobody entered dimensions". ShipStation records
      // an explicit all-zero size when a shipment went out in something with no rigid box
      // dimensions to speak of - in practice, a bubble mailer. Both cases previously collapsed to
      // the same hasDimensions:false result (0 is falsy, so the old check could not tell them
      // apart), which meant the ERP could only ever say "no dimensions on file, pick manually".
      // Flagging the all-zero case separately lets the Log Box modal suggest the mailer directly.
      const _dl = Number(dims?.length) || 0, _dw = Number(dims?.width) || 0, _dh = Number(dims?.height) || 0
      if (dims && _dl === 0 && _dw === 0 && _dh === 0) {
        return json({ ok: true, found: true, hasDimensions: false, zeroDimensions: true,
          units: dims.units || 'inches',
          note: 'ShipStation recorded this shipment as 0 x 0 x 0 - no rigid box' })
      }
      if (!dims || !dims.length || !dims.width || !dims.height) {
        return json({ ok: true, found: true, hasDimensions: false, note: 'ShipStation has this shipment but no dimensions were entered for it' })
      }
      return json({
        ok: true, found: true, hasDimensions: true,
        length: Number(dims.length), width: Number(dims.width), height: Number(dims.height),
        units: dims.units || 'inches'
      })
    } catch (e) {
      return json({ error: 'ShipStation lookup failed: ' + String((e as any)?.message || e) }, 500)
    }
  }
  if (body.action === 'create_return_label') {
    if (!Deno.env.get('SS_KEY')) return json({ error: 'SS_KEY not set' }, 400)
    const auth = ssAuth()
    const { orderNumber, trackingNumber, weightOz, carrierCode, serviceCode } = body
    let shipFrom: any = null, shipTo: any = null
    const searchUrl = trackingNumber
      ? 'https://ssapi.shipstation.com/shipments?trackingNumber=' + encodeURIComponent(trackingNumber) + '&pageSize=10'
      : 'https://ssapi.shipstation.com/shipments?orderNumber=' + encodeURIComponent(orderNumber||'') + '&pageSize=10'
    const ssSearch = await fetch(searchUrl, { headers: { Authorization: 'Basic ' + auth } })
    if (ssSearch.ok) {
      const sd = await ssSearch.json()
      const shipment = sd.shipments?.[0]
      if (shipment?.shipTo) { shipFrom = shipment.shipTo; shipTo = shipment.shipFrom }
    }
    if (!shipFrom && orderNumber) {
      const ordRes = await fetch('https://ssapi.shipstation.com/orders?orderNumber=' + encodeURIComponent(orderNumber) + '&pageSize=5', { headers: { Authorization: 'Basic ' + auth } })
      if (ordRes.ok) { const od = await ordRes.json(); const ord = od.orders?.[0]; if (ord?.shipTo) shipFrom = ord.shipTo }
    }
    if (!shipFrom) return json({ error: 'Original shipment not found in ShipStation - ensure the order was fulfilled through ShipStation' }, 404)
    if (!shipTo) shipTo = { name: 'TGK Motorsport', company: 'TGK Motorsport', street1: '123 Warehouse Dr', city: 'Your City', state: 'CA', postalCode: '90210', country: 'US', residential: false }
    const labelPayload = {
      carrierCode: carrierCode || 'stamps_com',
      serviceCode: serviceCode || 'usps_priority_mail',
      packageCode: 'package',
      confirmation: 'none',
      shipDate: new Date().toISOString().slice(0, 10),
      weight: { value: weightOz || 16, units: 'ounces' },
      shipFrom, shipTo,
      isReturnLabel: true,
      testLabel: false
    }
    const labelRes = await fetch('https://ssapi.shipstation.com/shipments/createlabel', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + auth },
      body: JSON.stringify(labelPayload)
    })
    const labelData = await labelRes.json()
    if (!labelRes.ok) return json({ error: labelData.ExceptionMessage || labelData.message || 'Label creation failed' }, 502)
    return json({ labelUrl: labelData.labelDownload?.pdf || null, trackingNumber: labelData.trackingNumber, carrier: labelData.carrierCode })
  }
  if (!resource_url) return new Response('no resource_url', { status: 400, headers: CORS })
  const ssKey = Deno.env.get('SS_KEY')!, ssSec = Deno.env.get('SS_SECRET')!
  const auth = btoa(ssKey + ':' + ssSec)
  const fetchUrl = resource_url.includes('includeShipmentItems') ? resource_url : resource_url + '&includeShipmentItems=true'
  const ssRes = await fetch(fetchUrl, { headers: { Authorization: 'Basic ' + auth } })
  if (!ssRes.ok) return new Response('SS fetch failed: ' + ssRes.status, { status: 502, headers: CORS })
  const data = await ssRes.json()
  // [AUDIT] Every ShipStation delivery first finishes any deduction an earlier delivery left pending.
  if (resource_type === 'SHIP_NOTIFY' || resource_type === 'ORDER_SHIPPED') {
    try { const r = await retryPendingDeductions(25); if (r.tried) console.log('[SS] pending deductions retried:', JSON.stringify(r)) } catch (e) { console.warn('[SS] pending retry failed', e) }
  }
  if (resource_type === 'SHIP_NOTIFY' || resource_type === 'ORDER_SHIPPED'
      || resource_type === 'ITEM_SHIPPED' || resource_type === 'FULFILLMENT_SHIPPED') {
    const shipments = data.shipments ?? [data]
    for (const ship of shipments) {
      const orderNum = ship.orderNumber
      const tracking = ship.trackingNumber
      const carrier = ship.carrierCode?.toUpperCase() || ''
      const shippedAt = new Date().toISOString()
      const rawSkus = (ship.shipmentItems ?? []).flatMap((i: any) => [i.sku, i.name, i.lineItemKey].filter(Boolean))
      console.log('[SS] order', orderNum, 'tracking', tracking, 'rawSkus', JSON.stringify(rawSkus))
      if (orderNum?.startsWith('SHERROR-')) {
        const errorId = orderNum.replace('SHERROR-', '')
        const { data: seRow } = await db.from('shipment_errors')
          .select('expected_pn,expected_qty,line_items,resolution,status').eq('id', errorId).maybeSingle()
        await db.from('shipment_errors').update({
          tracking_number: tracking, carrier, shipped_at: shippedAt,
          status: 'Resolved', resolved_at: shippedAt
        }).eq('id', errorId)
        const seRes = String(seRow?.resolution || '').toLowerCase()
        const seShipsNothing = (seRes === 'refund' || seRes === 'refunded' || seRes === 'write_off' || seRes === 'no_action')
        if (!seShipsNothing) {
          const seItems = (Array.isArray(seRow?.line_items) && seRow.line_items.length)
            ? seRow.line_items
            : (seRow?.expected_pn ? [{ pn: seRow.expected_pn, qty: seRow.expected_qty }] : [])
          for (const it of seItems) {
            if (!it || !it.pn) continue
            await deductForShipment(it.pn, Number(it.qty) || 1, tracking, 'SHERROR-' + errorId)
          }
        }
        console.log('[SS] SHERROR', errorId, 'resolved + deducted, tracking', tracking)
        continue
      }
      if (orderNum?.startsWith('WARRANTY-')) {
        const claimId = orderNum.replace('WARRANTY-', '')
        const { data: wRow } = await db.from('warranty_claims')
          .select('pn,claim_items,resolution_type,status').eq('id', claimId).maybeSingle()
        await db.from('warranty_claims').update({
          tracking_number: tracking, carrier, shipped_at: shippedAt,
          status: 'Resolved', resolved_at: shippedAt
        }).eq('id', claimId)
        const wRes = String(wRow?.resolution_type || '').toLowerCase()
        const wShips = (wRes === 'replacement' || wRes === 'repair' || wRes === '')
        if (wRow && wShips) {
          const items = (Array.isArray(wRow.claim_items) && wRow.claim_items.length)
            ? wRow.claim_items
            : (wRow.pn ? [{ pn: wRow.pn, qty: 1 }] : [])
          for (const it of items) {
            if (!it || !it.pn) continue
            await deductForShipment(it.pn, Number(it.qty) || 1, tracking, 'WARRANTY-' + claimId)
          }
        }
        console.log('[SS] WARRANTY', claimId, 'resolved + deducted, tracking', tracking)
        continue
      }
      const salesNum = (orderNum || '').replace(/^Manual_/i, '')
      const { num: resolvedOrderNumOrNull, viaSplit } = await resolveShipmentOrder(salesNum, ship)
      if (!resolvedOrderNumOrNull) {
        console.warn('[SS] order not in ERP and not a known split child:', salesNum, '- skipping')
        continue
      }
      const resolvedOrderNum = resolvedOrderNumOrNull
      let { data: erpLinesRaw, error: _elErr } = await db.from('sales')
        .select('id,pn,fulfillment_status,qty,deduct_pending').eq('order_number', resolvedOrderNum)
      if (_elErr) ({ data: erpLinesRaw } = await db.from('sales').select('id,pn,fulfillment_status,qty').eq('order_number', resolvedOrderNum))
      const erpLines = erpLinesRaw ?? []
      const allErpPns = erpLines.map((l: any) => l.pn as string)
      const norm = (s: string) => s.trim().toUpperCase()
      // [FIX] Root cause of "shipped 2 of 4, but tracking landed on all 4 including the on-hold
      // ones, and lines got duplicated": this SKU match used to be a plain string comparison, no
      // alias resolution. This ERP has a known, previously-documented legacy-pn/new_sku duality
      // on its own TGK-numbered catalog; when ShipStation reports a shipped SKU under the OTHER
      // alias than sales.pn holds, matchedPns came up EMPTY, which fell into the "no SKU match"
      // branch below - a blanket update that used to include On Hold in its status list AND
      // deduct inventory for every line on the order, genuinely-held lines included. The vendor
      // drop-ship SKUs on the same orders never hit this (no assemblies/parts record, no
      // duality possible) - consistent with only the TGK-catalog lines being affected in
      // practice. Same canonical-alias resolution now used in hold_sync and shopify-orders.ts's
      // orders/updated reconciliation, kept small here since one shipment event only ever
      // involves a handful of SKUs.
      const _aliasList = [...new Set([...allErpPns, ...rawSkus])].filter(Boolean)
      const _canonMap: Record<string, string> = {}
      if (_aliasList.length) {
        const { data: a1 } = await db.from('assemblies').select('pn').in('pn', _aliasList)
        ;(a1 || []).forEach((r: any) => { _canonMap[norm(r.pn)] = r.pn })
        const { data: a2 } = await db.from('assemblies').select('pn,new_sku').in('new_sku', _aliasList)
        ;(a2 || []).forEach((r: any) => { if (r.new_sku) _canonMap[norm(r.new_sku)] = r.pn })
        const { data: p1 } = await db.from('parts').select('pn').in('pn', _aliasList)
        ;(p1 || []).forEach((r: any) => { if (!(norm(r.pn) in _canonMap)) _canonMap[norm(r.pn)] = r.pn })
        const { data: p2 } = await db.from('parts').select('pn,new_sku').in('new_sku', _aliasList)
        ;(p2 || []).forEach((r: any) => { if (r.new_sku && !(norm(r.new_sku) in _canonMap)) _canonMap[norm(r.new_sku)] = r.pn })
      }
      const canon = (raw: string): string => { const n = norm(raw); return _canonMap[n] || n }
      // [AUDIT] Exact (canonical) match first; substring only if nothing on the order matched exactly.
      // See bulk_sync - the substring test alone marks and deducts the wrong line on split shipments.
      const _exactPns = allErpPns.filter(erpPn => { const ce = canon(erpPn); return rawSkus.some((ssSku: string) => ce === canon(ssSku) || norm(erpPn) === norm(ssSku)) })
      const matchedPns = _exactPns.length ? _exactPns : allErpPns.filter(erpPn => {
        const ce = canon(erpPn)
        return rawSkus.some((ssSku: string) => {
          if (ce === canon(ssSku)) return true
          const e = norm(erpPn), s = norm(ssSku)
          return e === s || e.includes(s) || s.includes(e)
        })
      })
      console.log('[SS] matchedPns', JSON.stringify(matchedPns), 'of', JSON.stringify(allErpPns), viaSplit ? '(via split link)' : '')
      const isSplit = matchedPns.length > 0 && matchedPns.length < allErpPns.length

      // [AUDIT v23.65] Replaces the old whole-shipment skip ("this tracking number already has a deduction, so
      // ignore the delivery"). If an earlier delivery died half-way, that skip meant the remaining lines were
      // marked Shipped but never deducted - permanently. Now each line is flagged deduct_pending BEFORE it is
      // marked Shipped and cleared only once its stock is deducted (or found already deducted), so a retry or
      // the automatic pending sweep finishes exactly the lines that are still owed. Lines already terminal and
      // not pending were shipped some other way (ERP Ship button, bulk ship) and are left alone.
      // [FIX] Same defense in depth for inventory: the blanket allErpPns fallback (used only when
      // matchedPns is empty and this isn't a split child) must never deduct stock for a line that
      // is currently On Hold - genuine matches (matchedPns.length>0) are left unrestricted, since
      // those are confirmed real shipped items regardless of prior status.
      const _TERMINAL = ['shipped', 'delivered', 'cancelled', 'canceled', 'refunded', 'returned', 'fulfilled']
      const pnsToDeduct = (matchedPns.length > 0 ? matchedPns : (viaSplit ? [] : allErpPns.filter((p: string) => {
        const line = erpLines.find((l: any) => l.pn === p)
        return !line || line.fulfillment_status !== 'On Hold'
      })))
      const deductLines: any[] = []
      for (const pn of pnsToDeduct) {
        const line: any = erpLines.find((l: any) => l.pn === pn)
        if (!line) continue
        if (_TERMINAL.includes(String(line.fulfillment_status || '').toLowerCase())) {
          if (line.deduct_pending === true) deductLines.push(line) // an earlier delivery shipped it but never finished the deduction
          else console.log('[SS] skip deduct for', pn, '- terminal status', line.fulfillment_status)
          continue
        }
        deductLines.push(line)
      }
      await markDeductPending(deductLines.filter((l: any) => l.deduct_pending !== true).map((l: any) => l.id), true)

      if (matchedPns.length > 0) {
        for (const pn of matchedPns) {
          await db.from('sales').update({ fulfillment_status: 'Shipped', tracking_number: tracking, carrier, shipped_at: shippedAt, is_split_shipment: isSplit }).eq('order_number', resolvedOrderNum).eq('pn', pn)
        }
        if (isSplit) {
          const unshippedPns = allErpPns.filter((p: string) => !matchedPns.includes(p))
          for (const pn of unshippedPns) {
            const line = erpLines.find((l: any) => l.pn === pn)
            if (line && ['Open', 'Packed'].includes(line.fulfillment_status)) {
              await db.from('sales').update({ fulfillment_status: 'Partial', is_split_shipment: true }).eq('order_number', resolvedOrderNum).eq('pn', pn)
            }
          }
        }
      } else if (viaSplit) {
        console.warn('[SS] split child', salesNum, 'matched no SKU on parent', resolvedOrderNum, '- refusing blanket update, no lines touched')
      } else {
        // [FIX] Defense in depth on top of the alias fix above: even if a match still somehow
        // fails for some unforeseen reason, this blanket fallback must never sweep an On Hold
        // line into Shipped - if ShipStation just reported a real shipment, it is implausible a
        // genuinely-held line was actually part of it. Dropped from this status list.
        console.warn('[SS] WARNING: no SKU match for order', resolvedOrderNum, '- updating all non-terminal, non-held lines')
        await db.from('sales').update({ fulfillment_status: 'Shipped', tracking_number: tracking, carrier, shipped_at: shippedAt }).eq('order_number', resolvedOrderNum).in('fulfillment_status', ['Open', 'Packed', 'Partial', 'partial', 'Pre-Order', 'Pre-order'])
      }
      for (const line of deductLines) await deductLine(line, tracking, resolvedOrderNum)
    }
  }
  if (resource_type === 'NEW_ORDER') {
    const order = data
    const orderNum = order.orderNumber
    const source = (order.orderSource || order.advancedOptions?.source || '').toLowerCase()
    const isShopify = source.includes('shopify') || source.includes('api')
    if (order?.advancedOptions?.parentId || order?.advancedOptions?.parentOrderId) {
      await linkSplitChild(order)
      console.log('[SS] NEW_ORDER: split child', orderNum, '- linked to parent, not imported')
      return ok('ok')
    }
    if (!isShopify && orderNum) {
      const salesNum = (orderNum || '').replace(/^Manual_/i, '')
      const { data: existing } = await db.from('sales').select('id').eq('order_number', salesNum).limit(1)
      if (!existing?.length) {
        for (const item of (order.items || [])) {
          const _newOrderQty = ssItemQty(item)
          if (_newOrderQty <= 0) { console.log('[SS] NEW_ORDER: skipping zero-quantity line', salesNum, item.sku || item.name); continue }
          await db.from('sales').insert({
            order_number: salesNum,
            pn: item.sku ? item.sku.trim().toUpperCase() : (item.name || '').trim(),
            qty: _newOrderQty,
            fulfillment_status: 'Open',
            source: 'ShipStation Manual',
            customer_name: order.shipTo?.name || null,
            customer_email: order.customerEmail || null,
            sale_date: centralDateOnly(order.orderDate)
          })
        }
        console.log('[SS] NEW_ORDER: created', orderNum, 'from ShipStation (source:', source || 'manual', ')')
      }
    }
  }
  if (resource_type === 'ORDER_NOTIFY') {
    const orders = Array.isArray(data?.orders) ? data.orders : (data?.orderNumber ? [data] : [])
    for (const order of orders) {
      if (!order.orderNumber) continue
      const rawNum = stripHash(order.orderNumber)
      let resolvedNum = await erpOrderNumberFor(rawNum)
      if (!resolvedNum) resolvedNum = await linkSplitChild(order)
      if (!resolvedNum) continue
      // [FIX] Same root cause as hold_sync above, confirmed on order #10497: a single order
      // number can have MULTIPLE ShipStation order records (one per split shipment), each with
      // its own orderId, orderStatus, and item list. Selecting pn alongside id/fulfillment_status
      // so both branches below can match against THIS webhook's specific order.items instead of
      // touching every ERP line sharing the order number.
      const { data: erpLinesRaw } = await db.from('sales')
        .select('id,pn,fulfillment_status').eq('order_number', resolvedNum)
      const erpLines = erpLinesRaw ?? []
      if (!erpLines.length) continue
      const rawSkus = (order.items || []).map((i: any) => (i.sku || i.name || '').trim()).filter(Boolean)
      // [FIX] Was a raw substring match (e === k || e.includes(k) || k.includes(e)). That both
      // missed real matches when the ERP line and ShipStation carried different aliases of the
      // same item, and made false ones - a short SKU is a substring of plenty of longer ones.
      // Canonical resolution, same as hold_sync, so the two paths agree on which line is which.
      const canon = await buildCanonMap([...rawSkus, ...erpLines.map((l: any) => l.pn || '')])
      const recCanon = new Set(rawSkus.map((x: string) => canon(x)))
      const matchesThisRecord = (l: any) => recCanon.has(canon(l.pn || ''))
      if (order.orderStatus === 'cancelled') {
        await db.from('sales').update({ fulfillment_status: 'Cancelled', cancelled_at: new Date().toISOString() }).eq('order_number', resolvedNum).in('fulfillment_status', ['Open', 'Packed', 'Partial', 'partial', 'On Hold', 'Pre-Order', 'Pre-order'])
        console.log('[SS] ORDER_NOTIFY -> Cancelled:', resolvedNum)
      } else if (order.orderStatus === 'on_hold') {
        // matchesThisRecord scopes the hold to the SKUs actually on THIS ShipStation record -
        // rawSkus falls back to "match everything" only if ShipStation's payload carried no
        // items at all, same fallback philosophy the SHIP_NOTIFY handler already uses elsewhere
        // in this file rather than silently doing nothing.
        // An item-less payload still holds the whole order: over-holding is safe and recoverable,
        // whereas guessing which lines to leave open is not.
        const ids = erpLines.filter((l: any) => ['Open','Packed','Partial'].includes(l.fulfillment_status) && (!rawSkus.length || matchesThisRecord(l))).map((l: any) => l.id)
        if (ids.length) await db.from('sales').update({ fulfillment_status: 'On Hold' }).in('id', ids)
        console.log('[SS] ORDER_NOTIFY -> On Hold:', resolvedNum, ids.length, 'of', erpLines.length, 'line(s) matched')
      } else if (order.orderStatus === 'awaiting_shipment') {
        // [FIX] Root cause of lines flip-flopping Open <-> On Hold (and the dashboard alert that
        // depends on Open lines blinking with them). A split order has several ShipStation records
        // under ONE order number, and the same SKU can sit in more than one of them - qty 2 with
        // one unit ready and one held. This released any line matching the READY record, without
        // looking at the siblings; the next hold_sync then saw the sibling still on_hold and
        // re-held it; the next ORDER_NOTIFY (ShipStation sends one on nearly any edit) released it
        // again, indefinitely. A line is now released only if NO on-hold sibling still contains it.
        // An item-less payload releases nothing: releasing on a guess is the unsafe direction.
        let ids: string[] = []
        if (rawSkus.length) {
          const heldBySibling = new Set<string>()
          let siblingsOk = false
          try {
            const sr = await fetch('https://ssapi.shipstation.com/orders?orderNumber=' + encodeURIComponent(rawNum) + '&pageSize=50', { headers: { Authorization: 'Basic ' + ssAuth() } })
            if (sr.ok) {
              const sd = await sr.json()
              const sibs = (sd.orders || []).filter((o: any) => stripHash(o.orderNumber || '') === rawNum && o.orderId !== order.orderId)
              const sibSkus: string[] = []
              sibs.forEach((o: any) => (o.items || []).forEach((i: any) => { const v = (i.sku || i.name || '').trim(); if (v) sibSkus.push(v) }))
              const sibCanon = await buildCanonMap(sibSkus)
              sibs.filter((o: any) => o.orderStatus === 'on_hold').forEach((o: any) =>
                (o.items || []).forEach((i: any) => { const v = (i.sku || i.name || '').trim(); if (v) heldBySibling.add(sibCanon(v)) }))
              siblingsOk = true
            }
          } catch (_e) { /* siblingsOk stays false - handled below */ }
          if (!siblingsOk) {
            // Could not see the siblings, so cannot rule out a flip-flop. Leave it for hold_sync,
            // which evaluates every record at once and so cannot disagree with itself.
            console.log('[SS] ORDER_NOTIFY -> could not read sibling records for', resolvedNum, '- release deferred to hold_sync')
          } else {
            ids = erpLines.filter((l: any) => l.fulfillment_status === 'On Hold' && matchesThisRecord(l) && !heldBySibling.has(canon(l.pn || ''))).map((l: any) => l.id)
            const blocked = erpLines.filter((l: any) => l.fulfillment_status === 'On Hold' && matchesThisRecord(l) && heldBySibling.has(canon(l.pn || ''))).length
            if (blocked) console.log('[SS] ORDER_NOTIFY ->', blocked, 'line(s) on', resolvedNum, 'kept On Hold - an on-hold sibling record still holds that SKU')
          }
        }
        if (ids.length) {
          // Re-check THIS SPECIFIC ShipStation order record's live status by orderId rather than
          // searching the on-hold list by order number - a search by number would find a
          // DIFFERENT still-held sibling record sharing the same order number and wrongly refuse
          // to release lines that belong to the shipment this webhook is actually about.
          let stillOnHold = false, checkSucceeded = false
          if (order.orderId) {
            const live = await fetchSSOrder(order.orderId)
            if (live) { stillOnHold = (live.orderStatus === 'on_hold'); checkSucceeded = true }
          }
          if (checkSucceeded && !stillOnHold) {
            await db.from('sales').update({ fulfillment_status: 'Open' }).in('id', ids)
            console.log('[SS] ORDER_NOTIFY -> Released hold:', resolvedNum, ids.length, 'line(s)')
          } else if (!checkSucceeded) {
            console.log('[SS] ORDER_NOTIFY -> could not verify hold status for', resolvedNum, '(orderId', order.orderId, ') - release skipped this time, hold_sync will catch it on the next pass if appropriate')
          } else {
            console.log('[SS] ORDER_NOTIFY -> awaiting_shipment received for', resolvedNum, 'but this specific ShipStation record still reports on_hold - release skipped')
          }
        }
      }
    }
  }
  if (resource_type === 'ORDER_CANCELLED') {
    const rawNum = stripHash(data?.orderNumber || '')
    if (rawNum) {
      const { data: ex1 } = await db.from('sales').select('id').eq('order_number', '#' + rawNum).limit(1)
      const resolvedNum = ex1?.length ? '#' + rawNum : rawNum
      await db.from('sales').update({ fulfillment_status: 'Cancelled', cancelled_at: new Date().toISOString() }).eq('order_number', resolvedNum).in('fulfillment_status', ['Open', 'Packed', 'Partial', 'partial', 'On Hold', 'Pre-Order', 'Pre-order'])
    }
  }
  return ok('ok')
})
