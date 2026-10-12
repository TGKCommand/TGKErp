import { createClient } from 'npm:@supabase/supabase-js@2'
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
// [FIX] Root cause of "sales orders show the wrong date, we're in Central time": sale_date was
// computed by slicing the first 10 characters off order.created_at -- (order.created_at ||
// new Date().toISOString()).slice(0, 10) -- which only gives the correct calendar day if that
// timestamp happens to already be expressed in Central time. Shopify's created_at isn't
// guaranteed to be, and new Date().toISOString() is always UTC regardless, so any order landing
// after roughly 6-7pm Central (whenever UTC has already rolled to the next calendar day) got
// stamped with the wrong date at the moment it was written, not just displayed wrong later.
// Parses the timestamp as an absolute instant (respecting whatever offset it carries, or none)
// and reads the calendar date as OBSERVED in America/Chicago -- correct across the DST boundary
// too, unlike a fixed UTC offset would be. Mirrors the identical fix applied client-side in the
// ERP's own sync/import paths.
function centralDateOnly(input?: string | null): string {
  const d = input ? new Date(input) : new Date()
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

// [FIX] Root cause of a brand-new single-line order showing up TWICE in the ERP (order #10516):
// both the orders/create insert loop and the orders/updated "new line" insert (added earlier this
// session) follow a check-then-insert pattern with no atomicity - read whether a row already
// exists, then insert if not. Shopify commonly REDELIVERS orders/create itself if a response is
// slow or non-2xx (the same behavior ShipStation's webhooks already have a documented guard for
// elsewhere in this file), and if the second delivery's existence check runs before the first
// delivery's insert has committed, both slip through and both insert. No amount of narrowing that
// check-then-insert window in application code can fully close a true race - a database-level
// unique constraint would be the airtight fix, but adding one requires first cleaning up whatever
// duplicates already exist from this bug, which is a deliberate step for Jon to take with eyes
// open, not something to do silently mid-webhook. Until that constraint exists, this closes the
// loop defensively instead: right after any insert that could have raced, re-check for siblings
// sharing the same order and the same CANONICAL item (matching pn OR new_sku on assemblies/parts,
// same resolution used elsewhere in this file) and collapse back down to one, keeping whichever
// row is oldest. Both concurrent invocations doing this converges to the same correct end state
// regardless of which one gets there first or whether both run it - deleting a row that is already
// gone is a no-op, not a new race.
async function _canonicalPnFor(pn: string): Promise<string> {
  const n = pn.trim().toUpperCase()
  let { data: a } = await db.from('assemblies').select('pn').eq('pn', pn).limit(1)
  if (a?.length) return a[0].pn
  ;({ data: a } = await db.from('assemblies').select('pn').eq('new_sku', pn).limit(1))
  if (a?.length) return a[0].pn
  let { data: p } = await db.from('parts').select('pn').eq('pn', pn).limit(1)
  if (p?.length) return p[0].pn
  ;({ data: p } = await db.from('parts').select('pn').eq('new_sku', pn).limit(1))
  if (p?.length) return p[0].pn
  return n
}
async function dedupeSalesLine(orderName: string, pn: string): Promise<void> {
  try {
    const canon = await _canonicalPnFor(pn)
    const { data: rows } = await db.from('sales').select('id,pn,created_at').eq('order_number', orderName)
    if (!rows || rows.length < 2) return
    const matching: any[] = []
    for (const r of rows) {
      if (!r.pn) continue
      const rc = await _canonicalPnFor(r.pn)
      if (rc === canon) matching.push(r)
    }
    if (matching.length < 2) return
    matching.sort((x: any, y: any) => String(x.created_at || x.id).localeCompare(String(y.created_at || y.id)))
    const dupes = matching.slice(1)
    for (const d of dupes) {
      await db.from('sales').delete().eq('id', d.id)
      console.warn('[shopify-orders] dedupe: removed race-duplicate sales row', d.id, 'for', orderName, pn, '- kept', matching[0].id)
    }
  } catch (e) { console.warn('[shopify-orders] dedupeSalesLine failed:', e) }
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-shopify-topic, x-shopify-hmac-sha256',
}
// Recompute a PRODUCT's template_suffix from the live state of ALL its variants.
// Rule (must match the ERP's Theme Audit exactly):
//   * single-variant product  -> backorder template if that variant is backordered
//   * multi-variant product   -> backorder template ONLY if EVERY variant is backordered;
//                                if even one is buyable the product stays on default.
// A variant counts as backordered when it is tracked and its quantity is <= 0.
// Returns {changed, from, to, errors} and never throws -- template drift must never break
// the inventory write that triggered it.
// Flag + notify on a high-risk Shopify order, per Jon: visual flag + notification only, does
// NOT touch fulfillment_status (no auto-hold). Still needs: `sales` needs risk_flagged AND
// risk_level columns - migration at the bottom of this file. The wiki_notifications insert
// below matches the REAL schema (recipient/actor/page_id/block_id/kind/message), taken from
// TGK Notes' own notify() function - not a guess.
// [FIX] The GraphQL `order.risk.recommendation` field (PENDING/ACCEPT/INVESTIGATE/CANCEL) is a
// coarser, different signal than the Low/Medium/High risk level Shopify's own order page shows
// you - this was hardcoding every flagged order as "High Risk" regardless of which one Shopify
// actually assigned, which is almost certainly why a Shopify-labeled "Medium" order showed up
// in the ERP as "High Risk". Now stores and surfaces the raw recommendation value Shopify
// returned instead of inventing a High/Medium translation I can't verify is correct.
const HIGH_RISK_TAG = Deno.env.get('SHOPIFY_HIGH_RISK_TAG') || 'high-risk'
// Comma-separated list of who gets notified - defaults to just Jon since that's the only
// confirmed address; add Christian's (or anyone else's) once you have it.
const RISK_ALERT_RECIPIENTS = (Deno.env.get('SHOPIFY_RISK_ALERT_RECIPIENTS') || 'jon@tgkmotorsport.com')
  .split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean)
async function checkOrderRisk(shopifyOrderId: string | number, orderName: string) {
  try {
    const store = (Deno.env.get('SHOPIFY_STORE') || '').replace('https://', '').replace('http://', '')
    const key = Deno.env.get('SHOPIFY_KEY') || ''
    if (!store || !key || !shopifyOrderId || !orderName) return

    // Idempotent: orders/create and a later orders/updated (if risk was assessed slightly
    // after creation, e.g. by a third-party fraud app) can both fire for the same order -
    // don't re-tag or re-notify one already flagged.
    const { data: already } = await db.from('sales').select('id').eq('order_number', orderName).eq('risk_flagged', true).limit(1)
    if (already?.length) return

    const gid = 'gid://shopify/Order/' + shopifyOrderId
    const H = { 'X-Shopify-Access-Token': key, 'Content-Type': 'application/json' }
    const resp = await fetch('https://' + store + '/admin/api/2024-01/graphql.json', {
      method: 'POST', headers: H,
      body: JSON.stringify({ query: '{ order(id: "' + gid + '") { id tags risk { recommendation } } }' }),
    }).then(r => r.json())
    const order = resp?.data?.order
    if (!order) { console.warn('[risk] order lookup failed for', shopifyOrderId, JSON.stringify(resp?.errors || resp)); return }

    // Shopify's recommendation is one of PENDING / ACCEPT / INVESTIGATE / CANCEL. Treating
    // INVESTIGATE and CANCEL both as high risk errs toward catching more than missing one -
    // narrow to CANCEL only if that turns out too broad in practice.
    const recommendation = order.risk?.recommendation || 'ACCEPT'
    if (recommendation !== 'CANCEL' && recommendation !== 'INVESTIGATE') return

    // 1) Tag the order in Shopify so a ShipStation automation rule matching this tag holds it.
    const existingTags: string[] = (order.tags || []).filter(Boolean)
    if (!existingTags.some((t: string) => t.toLowerCase() === HIGH_RISK_TAG.toLowerCase())) {
      const tagResp = await fetch('https://' + store + '/admin/api/2024-01/graphql.json', {
        method: 'POST', headers: H,
        body: JSON.stringify({ query: 'mutation { tagsAdd(id: "' + order.id + '", tags: ["' + HIGH_RISK_TAG + '"]) { userErrors { field message } } }' }),
      }).then(r => r.json())
      const tagErrors = tagResp?.data?.tagsAdd?.userErrors || []
      if (tagErrors.length) console.warn('[risk] tagsAdd errors for', orderName, JSON.stringify(tagErrors))
    }

    // 2) Flag the matching sales row(s). Visual flag ONLY - fulfillment_status untouched.
    // risk_level stores Shopify's own raw recommendation string, not a translated High/Medium
    // label, so the ERP always shows exactly what Shopify actually said.
    await db.from('sales').update({ risk_flagged: true, risk_level: recommendation }).eq('order_number', orderName)

    // 3) Notify via wiki_notifications - same table and shape TGK Notes' notify() writes:
    // recipient/actor/page_id/block_id/kind/message. page_id and block_id are null here since
    // this alert isn't tied to a wiki page. actor is a synthetic address (not a real team
    // member) purely so it renders sensibly wherever teamName(actor) is displayed - it'll show
    // as "automation" since that won't match anyone on the team roster.
    const alertMessage = 'Order ' + orderName + ' flagged by Shopify as ' + recommendation
      + '. Tagged in Shopify (for any ShipStation rule matching that tag); visible in the ERP.'
    for (const recipient of RISK_ALERT_RECIPIENTS) {
      try {
        await db.from('wiki_notifications').insert({
          recipient, actor: 'automation@tgkmotorsport.com',
          page_id: null, block_id: null,
          kind: 'automation_alert', message: alertMessage,
        })
      } catch (e) { console.warn('[risk] wiki_notifications insert failed for', recipient, ':', e) }
    }

    console.log('[risk] flagged', orderName, 'as', recommendation)
  } catch (e) {
    console.warn('[risk] checkOrderRisk error for', orderName, e)
  }
}

// [FIX] See the matching note in shipstation-ship.ts. A product deliberately merchandised on a
// PRE-ORDER template in Shopify was still being pushed into backorder by this automation: the only
// guard was the ERP's own category field literally equalling 'Pre-Order', so a product set up as
// pre-order on the Shopify side alone had nothing protecting it. reconcileProductTemplate below
// already refuses to overwrite a bespoke template, but that runs AFTER the variant-level inventory
// and metafield writes that are what actually break the pre-order presentation. This is the same
// rule applied earlier and to the whole operation, in both directions - reverting would untrack a
// pre-order variant just as wrongly as backordering it.
// [FIX] See the matching note in shipstation-ship.ts. This action is called DIRECTLY by the ERP's
// manual and bulk backorder sync, so gating only the webhook path would leave the biggest caller
// unprotected - a bulk sync would happily keep pushing non-TGK resale items into backorder.
function isTgkManagedSku(pn: string | null | undefined, newSku?: string | null): boolean {
  const prefix = (Deno.env.get('BACKORDER_SKU_PREFIX') || 'TGK').trim().toUpperCase()
  if (!prefix) return true
  const a = String(pn || '').trim().toUpperCase()
  const b = String(newSku || '').trim().toUpperCase()
  return a.startsWith(prefix) || b.startsWith(prefix)
}
function isManagedBackorderTemplate(templateSuffix: string | null | undefined): boolean {
  const cur = String(templateSuffix || '').trim().toLowerCase()
  const boTpl = (Deno.env.get('SHOPIFY_BACKORDER_TEMPLATE') || 'backorder').trim().toLowerCase()
  if (cur === '' || cur === 'default' || cur === 'default product') return true
  return cur === boTpl
}

// [FIX] Clearing the restock date used to be metafieldsSet with a blank value (" "). Shopify rejects
// a blank value on this metafield (the same reason repair_preorder_variants below deletes instead),
// and the userErrors were never read - so the old date silently STAYED on the variant and product
// after an item came off backorder. The next time that SKU went on backorder, the "keep whatever
// date Shopify already has" rule then revived that stale date instead of starting a fresh one.
// metafieldsDelete is type-agnostic and a no-op when the metafield is already gone.
async function clearEtaMetafield(gqlFn: any, ownerId: string | null | undefined): Promise<void> {
  if (!ownerId) return
  try {
    const m = await gqlFn('mutation { metafieldsDelete(metafields: [{ownerId: "' + ownerId + '", namespace: "custom", key: "estimated_arrival_date"}]) { deletedMetafields { key } userErrors { field message } } }')
    const ue = m?.data?.metafieldsDelete?.userErrors || []
    if (ue.length) console.warn('[clearEtaMetafield] userErrors for', ownerId, JSON.stringify(ue))
  } catch (e) { console.warn('[clearEtaMetafield] failed for', ownerId, e) }
}

async function reconcileProductTemplate(gqlFn: any, prodId: string): Promise<any> {
  // Typed explicitly: inferring from/to/skipped as the null type makes every later string
  // assignment a type error, which fails the Edge Function deploy outright.
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
    // This store's main template is literally named "Default product", so treat that (and
    // a plain "default") as the default template rather than a bespoke one.
    const cnorm = current.trim().toLowerCase()
    const isDefaultTpl = (cnorm === '' || cnorm === 'default' || cnorm === 'default product')
    const currentEff = isDefaultTpl ? '' : current
    out.from = current; out.to = desired
    // Only ever manage the default <-> backorder transition. Any other suffix (preorder,
    // or any bespoke template) is intentional merchandising - overwriting it would destroy
    // a deliberate setup, so leave those products completely alone.
    if (currentEff !== '' && currentEff !== boTpl) { out.skipped = 'custom template "' + current + '" - not managed'; return out }
    if (currentEff === desired) return out
    // productUpdate changed argument name across API versions (input: -> product:). We were
    // already bitten once by a mutation shape disappearing, so try the modern form first and
    // fall back, rather than assuming either one.
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
  if (req.method === 'GET') return new Response('pong', { headers: CORS })
  let body: any = {}
  let _rawBody = ''
  try { _rawBody = await req.text(); body = _rawBody ? JSON.parse(_rawBody) : {} } catch (_) {}
  if (body.ping) return new Response('pong', { headers: CORS })
  if (body.action === 'version') return new Response(JSON.stringify({ fn: 'shopify-orders', build: EDGE_BUILD }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  if (body.action && !req.headers.get('x-shopify-topic')) {
    const _gate = await authGate(req, 'shopify-orders', String(body.action))
    if (_gate) return _gate
  }
  if (body.action === 'oauth_exchange') {
    const clientId = Deno.env.get('SHOPIFY_CLIENT_ID') || ''
    const clientSecret = Deno.env.get('SHOPIFY_CLIENT_SECRET') || ''
    if (!clientId || !clientSecret) return new Response(JSON.stringify({error:'SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET not set in edge function secrets'}), {status:400, headers:{...CORS,'Content-Type':'application/json'}})
    const shop = (body.shop || '').replace('https://','').replace('http://','')
    const code = body.code || ''
    if (!shop || !code) return new Response(JSON.stringify({error:'Missing shop or code'}), {status:400, headers:{...CORS,'Content-Type':'application/json'}})
    const tokenRes = await fetch('https://'+shop+'/admin/oauth/access_token', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({client_id: clientId, client_secret: clientSecret, code})
    })
    const tokenData = await tokenRes.json()
    if (!tokenRes.ok || !tokenData.access_token) {
      return new Response(JSON.stringify({error: tokenData.error_description || tokenData.error || 'Token exchange failed'}), {status:400, headers:{...CORS,'Content-Type':'application/json'}})
    }
    return new Response(JSON.stringify({access_token: tokenData.access_token, scope: tokenData.scope}), {headers:{...CORS,'Content-Type':'application/json'}})
  }
  if (body.action === 'sync') {
    const store = (body.store || Deno.env.get('SHOPIFY_STORE') || '').replace('https://', '').replace('http://', '')
    const key = body.key || Deno.env.get('SHOPIFY_KEY') || ''
    if (!store || !key) {
      return new Response(JSON.stringify({error:'Missing credentials'}), {status:400, headers:{...CORS,'Content-Type':'application/json'}})
    }
    const since = body.since || new Date(Date.now() - 30*24*60*60*1000).toISOString()
    const page_info = body.page_info || ''
    const url = page_info
      ? 'https://' + store + '/admin/api/2024-01/orders.json?limit=250&page_info=' + page_info
      : 'https://' + store + '/admin/api/2024-01/orders.json?status=any&limit=250&updated_at_min=' + encodeURIComponent(since) + (body.created_min ? '&created_at_min=' + encodeURIComponent(body.created_min) : '') + (body.created_max ? '&created_at_max=' + encodeURIComponent(body.created_max) : '')
    const shopRes = await fetch(url, {headers:{'X-Shopify-Access-Token': key}})
    if (!shopRes.ok) {
      return new Response(JSON.stringify({error:'Shopify ' + shopRes.status}), {status:shopRes.status, headers:{...CORS,'Content-Type':'application/json'}})
    }
    const link = shopRes.headers.get('link') || ''
    let next_page_info = ''
    for (const part of link.split(',')) {
      if (part.includes('rel="next"')) {
        const m = part.match(/page_info=([^&>"]+)/)
        if (m) { next_page_info = m[1]; break }
      }
    }
    const payload = await shopRes.json()
    return new Response(JSON.stringify({...payload, next_page_info}), {headers:{...CORS,'Content-Type':'application/json'}})
  }
  if (body.action === 'update_template') {
    const store = (body.store || Deno.env.get('SHOPIFY_STORE') || '').replace('https://', '').replace('http://', '')
    const key = body.key || Deno.env.get('SHOPIFY_KEY') || ''
    const sku = (body.pn || '').trim()
    const templateSuffix = body.template || ''
    if (!store || !key || !sku) return new Response(JSON.stringify({error:'Missing store, key or pn'}), {status:400, headers:{...CORS,'Content-Type':'application/json'}})
    const shopHeaders = {'X-Shopify-Access-Token': key, 'Content-Type': 'application/json'}
    const safeSku = sku.replace(/"/g, '')
    // [FIX] Unquoted sku:VALUE search tokenizes on hyphens (Shopify splits "TGK-0308-15" into
    // "TGK"/"0308"/"15" and matches fuzzily), so a SKU family with many numbered siblings (this
    // one has 17+) can easily crowd the exact match out of the first 10 results -- reported as
    // "No Shopify variant found" for a SKU that genuinely exists. Quoting the value inside the
    // search string forces Shopify to treat it as an exact phrase instead.
    const gqlQuery = '{ productVariants(first: 10, query: "sku:\\"' + safeSku + '\\"") { edges { node { id sku product { id legacyResourceId title } } } } }'
    const gqlRes = await fetch('https://' + store + '/admin/api/2024-01/graphql.json', {
      method: 'POST',
      headers: shopHeaders,
      body: JSON.stringify({ query: gqlQuery })
    })
    if (!gqlRes.ok) return new Response(JSON.stringify({error:'GraphQL request failed: ' + gqlRes.status}), {status:gqlRes.status, headers:{...CORS,'Content-Type':'application/json'}})
    const gqlData = await gqlRes.json()
    console.log('[shopify update_template] GraphQL result for SKU', sku, ':', JSON.stringify(gqlData?.data?.productVariants?.edges?.map((e:any)=>({sku:e.node.sku,productId:e.node.product?.legacyResourceId}))))
    const edges = gqlData?.data?.productVariants?.edges || []
    const match = edges.find((e: any) => (e.node.sku || '').trim().toUpperCase() === sku.toUpperCase())
    if (!match) {
      console.warn('[shopify update_template] GraphQL found no exact SKU match for', sku, '— edges:', JSON.stringify(edges.map((e:any)=>e.node.sku)))
      return new Response(JSON.stringify({error:'No Shopify product found for SKU: ' + sku, debug: edges.map((e:any)=>({sku:e.node.sku,productId:e.node.product?.legacyResourceId}))}), {status:404, headers:{...CORS,'Content-Type':'application/json'}})
    }
    const productId = match.node.product.legacyResourceId
    // REST product writes have been retired by Shopify (same version drift that removed
    // productVariantUpdate), so the old PUT silently no-opped and Fix could never stick.
    // Use GraphQL productUpdate, trying both argument shapes across API versions.
    const prodGid = 'gid://shopify/Product/' + productId
    const tplErrs: string[] = []
    let tplApplied = false
    for (const argName of ['product', 'input']) {
      const mres = await fetch('https://' + store + '/admin/api/2024-01/graphql.json', {
        method: 'POST', headers: shopHeaders,
        body: JSON.stringify({query: 'mutation { productUpdate(' + argName + ': {id: "' + prodGid + '", templateSuffix: "' + templateSuffix + '"}) { product { id templateSuffix } userErrors { field message } } }'})
      }).then(r => r.json()).catch((e:any) => ({errors:[{message:String(e)}]}))
      ;(mres?.errors || []).forEach((e:any)=>tplErrs.push(e?.message || JSON.stringify(e)))
      ;(mres?.data?.productUpdate?.userErrors || []).forEach((u:any)=>tplErrs.push(u.message))
      if (mres?.data?.productUpdate?.product) { tplApplied = true; break }
    }
    if (!tplApplied) return new Response(JSON.stringify({error:'Product template update failed' + (tplErrs.length ? (': ' + tplErrs.join('; ')) : ''), errors: tplErrs}), {status:502, headers:{...CORS,'Content-Type':'application/json'}})
    console.log('[shopify update_template] set', sku, 'product', productId, 'template_suffix ->', templateSuffix || '(default)')
    try {
      await db.from('shopify_sync_log').insert({
        pn: sku,
        action: templateSuffix ? 'backorder' : 'reverted',
        trigger_source: body.trigger_source || 'erp_manual',
        restock_date: body.restock_date || null
      })
    } catch (e) { console.warn('[shopify update_template] log insert failed:', e) }
    // Two independent callers can put a restock date on Shopify: this action (product-level
    // metafield) and set_variant_backorder (variant-level metafield). Theme Audit calls THIS
    // action with no restock_date at all, which used to leave the product metafield stale or
    // empty while the variant one showed the real date - two different ETAs on one page.
    // Falling back to the variant's own metafield when the caller did not supply one keeps
    // both in agreement regardless of which path ran.
    let restockDate = body.restock_date || ''
    if (!restockDate && templateSuffix) {
      try {
        const vfRes = await fetch('https://' + store + '/admin/api/2024-01/graphql.json', {
          method: 'POST', headers: shopHeaders,
          body: JSON.stringify({query: '{ productVariant(id: "' + match.node.id + '") '
            + '{ metafield(namespace: "custom", key: "estimated_arrival_date") { value } } }'})
        })
        const vfData = await vfRes.json()
        restockDate = vfData?.data?.productVariant?.metafield?.value || ''
      } catch (e) { console.warn('[shopify update_template] variant date lookup failed:', e) }
    }
    if (templateSuffix && restockDate) {
      try {
        const gid = 'gid://shopify/Product/' + productId
        const metaMutation = 'mutation { metafieldsSet(metafields: [{ownerId: "' + gid + '", namespace: "custom", key: "estimated_arrival_date", value: "' + restockDate + '", type: "single_line_text_field"}]) { metafields { id key value } userErrors { field message } } }'
        const metaRes = await fetch('https://' + store + '/admin/api/2024-01/graphql.json', {
          method: 'POST',
          headers: shopHeaders,
          body: JSON.stringify({ query: metaMutation })
        })
        const metaData = await metaRes.json()
        const metaErrors = metaData?.data?.metafieldsSet?.userErrors || []
        if (metaErrors.length) console.warn('[shopify update_template] metafield errors:', JSON.stringify(metaErrors))
        else console.log('[shopify update_template] estimated_arrival_date metafield set to', restockDate, 'for product', productId)
      } catch (e) {
        console.warn('[shopify update_template] metafield write failed:', e)
      }
    }
    return new Response(JSON.stringify({success: true, productId, template_suffix: templateSuffix, restock_date: restockDate||null}), {headers:{...CORS,'Content-Type':'application/json'}})
  }
  if (body.action === 'sync_images' || body.action === 'sync_images_page') {
    const store = (body.store || Deno.env.get('SHOPIFY_STORE') || '').replace('https://', '').replace('http://', '')
    const key = body.key || Deno.env.get('SHOPIFY_KEY') || ''
    if (!store || !key) return new Response(JSON.stringify({error:'Missing Shopify credentials'}), {status:400, headers:{...CORS,'Content-Type':'application/json'}})
    const page_info = body.page_info || ''
    const url = page_info
      ? 'https://' + store + '/admin/api/2024-01/products.json?limit=250&page_info=' + page_info
      : 'https://' + store + '/admin/api/2024-01/products.json?limit=250&fields=id,title,variants,images'
    const res = await fetch(url, {headers:{'X-Shopify-Access-Token': key}})
    if (!res.ok) return new Response(JSON.stringify({error:'Shopify ' + res.status + ' - check API key has read_products scope'}), {status:res.status, headers:{...CORS,'Content-Type':'application/json'}})
    const data = await res.json()
    const products = data.products || []
    const skuMap: any = {}
    for (const product of products) {
      const imgById: any = {}
      for (const img of (product.images || [])) {
        if (img.id && img.src) imgById[img.id] = img.src
      }
      const defaultImg = product.images?.[0]?.src || ''
      for (const variant of (product.variants || [])) {
        const sku = (variant.sku || '').trim()
        if (!sku) continue
        const img = (variant.image_id && imgById[variant.image_id]) ? imgById[variant.image_id] : defaultImg
        if (img) {
          skuMap[sku] = img
          skuMap[sku.toUpperCase()] = img
          skuMap[sku.toLowerCase()] = img
        }
      }
    }
    const link = res.headers.get('link') || ''
    let next_page_info = ''
    const linkParts = link.split(',')
    for (const part of linkParts) {
      if (part.includes('rel="next"')) {
        const m = part.match(/page_info=([^&>"]+)/)
        if (m) { next_page_info = m[1]; break }
      }
    }
    return new Response(JSON.stringify({skuMap, count: products.length, next_page_info}), {headers:{...CORS,'Content-Type':'application/json'}})
  }
  if (body.action === 'list_products') {
    const store = (body.store || Deno.env.get('SHOPIFY_STORE') || '').replace('https://', '').replace('http://', '')
    const key = body.key || Deno.env.get('SHOPIFY_KEY') || ''
    if (!store || !key) return new Response(JSON.stringify({error:'Missing Shopify credentials'}), {status:400, headers:{...CORS,'Content-Type':'application/json'}})
    const page_info = body.page_info || ''
    const url = page_info
      ? 'https://' + store + '/admin/api/2024-01/products.json?limit=250&page_info=' + page_info
      : 'https://' + store + '/admin/api/2024-01/products.json?limit=250&published_status=any&fields=id,title,handle,status,published_at,variants'
    const res = await fetch(url, {headers:{'X-Shopify-Access-Token': key}})
    if (!res.ok) return new Response(JSON.stringify({error:'Shopify ' + res.status + ' - check API key has read_products scope'}), {status:res.status, headers:{...CORS,'Content-Type':'application/json'}})
    const data = await res.json()
    const products = data.products || []
    const skus: any[] = []
    for (const product of products) {
      for (const variant of (product.variants || [])) {
        const sku = (variant.sku || '').trim()
        if (!sku) continue
        skus.push({sku, status: product.status || '', published: !!product.published_at, title: product.title || '', handle: product.handle || '', tracked: !!variant.inventory_management, policy: variant.inventory_policy || '', qty: (typeof variant.inventory_quantity === 'number' ? variant.inventory_quantity : null)})
      }
    }
    const link = res.headers.get('link') || ''
    let next_page_info = ''
    for (const part of link.split(',')) {
      if (part.includes('rel="next"')) { const m = part.match(/page_info=([^&>"]+)/); if (m) { next_page_info = m[1]; break } }
    }
    return new Response(JSON.stringify({skus, count: products.length, next_page_info}), {headers:{...CORS,'Content-Type':'application/json'}})
  }
  if (body.action === 'list_sku_variants') {
    // Every Shopify variant carrying this SKU, with the product (chassis page) it belongs to,
    // so the ERP can offer a per-chassis choice instead of a single SKU-wide switch.
    const store = (body.store || Deno.env.get('SHOPIFY_STORE') || '').replace('https://', '').replace('http://', '')
    const key = body.key || Deno.env.get('SHOPIFY_KEY') || ''
    const sku = (body.sku || '').trim()
    if (!store || !key || !sku) return new Response(JSON.stringify({error:'Missing store, key or sku'}), {status:400, headers:{...CORS,'Content-Type':'application/json'}})
    const H = {'X-Shopify-Access-Token': key, 'Content-Type': 'application/json'}
    const gq = (q) => fetch('https://' + store + '/admin/api/2024-01/graphql.json', {method:'POST', headers:H, body: JSON.stringify({query:q})}).then(r=>r.json())
    const safe = sku.replace(/"/g, '')
    const r = await gq('{ productVariants(first: 50, query: "sku:\\"' + safe + '\\"") { edges { node { id sku title inventoryPolicy inventoryQuantity inventoryItem { id tracked } product { id title handle status } } } } }')
    const rows = (r?.data?.productVariants?.edges || [])
      .map((e:any) => e.node)
      .filter((n:any) => (n.sku || '').trim().toUpperCase() === sku.toUpperCase())
      .map((n:any) => ({
        variant_id: n.id, variant_title: n.title, sku: n.sku,
        product_id: n.product?.id, product_title: n.product?.title,
        handle: n.product?.handle, status: n.product?.status,
        tracked: !!n.inventoryItem?.tracked, policy: n.inventoryPolicy,
        qty: n.inventoryQuantity
      }))
    let held: any[] = []
    try {
      const h = await db.from('variant_holds').select('shopify_variant_id,reason').eq('sku', sku).eq('active', true)
      held = h.data || []
    } catch (e) {}
    const heldSet = new Set(held.map((x:any) => x.shopify_variant_id))
    rows.forEach((x:any) => { x.held = heldSet.has(x.variant_id)
      x.hold_reason = (held.find((h:any)=>h.shopify_variant_id===x.variant_id)||{}).reason || '' })
    return new Response(JSON.stringify({variants: rows, errors: r?.errors || null}), {headers:{...CORS,'Content-Type':'application/json'}})
  }

  if (body.action === 'set_variant_hold') {
    // Hard sold-out for ONE variant: tracked + zero + DENY. Backorder keeps a variant buyable;
    // a hold must not be purchasable at all, which is the point of stopping a chassis.
    const store = (body.store || Deno.env.get('SHOPIFY_STORE') || '').replace('https://', '').replace('http://', '')
    const key = body.key || Deno.env.get('SHOPIFY_KEY') || ''
    const variantId = (body.variant_id || '').trim()
    const hold = !!body.hold
    if (!store || !key || !variantId) return new Response(JSON.stringify({error:'Missing store, key or variant_id'}), {status:400, headers:{...CORS,'Content-Type':'application/json'}})
    const H = {'X-Shopify-Access-Token': key, 'Content-Type': 'application/json'}
    const errs: string[] = []
    const gq = async (q) => {
      const r = await fetch('https://' + store + '/admin/api/2024-01/graphql.json', {method:'POST', headers:H, body: JSON.stringify({query:q})}).then(x=>x.json())
      ;(r?.errors || []).forEach((e:any)=>errs.push(e?.message || JSON.stringify(e)))
      return r
    }
    const info = await gq('{ productVariant(id: "' + variantId + '") { id sku title inventoryItem { id } product { id title } } }')
    const v = info?.data?.productVariant
    if (!v) return new Response(JSON.stringify({error:'Variant not found: ' + variantId, errors: errs}), {status:404, headers:{...CORS,'Content-Type':'application/json'}})
    const invId = v.inventoryItem?.id
    const prodId = v.product?.id

    if (hold) {
      if (invId) {
        await gq('mutation { inventoryItemUpdate(id: "' + invId + '", input: {tracked: true}) { userErrors { message } } }')
        const loc = await gq('{ locations(first: 1) { edges { node { id } } } }')
        const lId = loc?.data?.locations?.edges?.[0]?.node?.id
        if (lId) await gq('mutation { inventorySetOnHandQuantities(input: {reason: "correction", setQuantities: [{inventoryItemId: "' + invId + '", locationId: "' + lId + '", quantity: 0}]}) { userErrors { message } } }')
      }
      const p = await gq('mutation { productVariantsBulkUpdate(productId: "' + prodId + '", variants: [{id: "' + variantId + '", inventoryPolicy: DENY}]) { productVariants { id inventoryPolicy } userErrors { field message } } }')
      const pol = p?.data?.productVariantsBulkUpdate?.productVariants?.[0]?.inventoryPolicy
      try {
        await db.from('variant_holds').upsert({
          sku: v.sku, shopify_variant_id: variantId, shopify_product_id: prodId,
          product_title: v.product?.title, variant_title: v.title,
          reason: body.reason || null, active: true, released_at: null,
          created_by: body.user || null
        }, { onConflict: 'shopify_variant_id' })
      } catch (e) { errs.push('hold record failed: ' + String(e)) }
      return new Response(JSON.stringify({ok: pol === 'DENY', held: true, policy: pol, errors: errs}), {headers:{...CORS,'Content-Type':'application/json'}})
    }

    // Release: back to the store default (untracked, always available). The next normal sync
    // will re-apply backorder state if buildability calls for it.
    if (invId) await gq('mutation { inventoryItemUpdate(id: "' + invId + '", input: {tracked: false}) { userErrors { message } } }')
    await gq('mutation { productVariantsBulkUpdate(productId: "' + prodId + '", variants: [{id: "' + variantId + '", inventoryPolicy: CONTINUE}]) { productVariants { id inventoryPolicy } userErrors { field message } } }')
    try {
      await db.from('variant_holds').update({active: false, released_at: new Date().toISOString()}).eq('shopify_variant_id', variantId)
    } catch (e) { errs.push('release record failed: ' + String(e)) }
    return new Response(JSON.stringify({ok: true, held: false, errors: errs}), {headers:{...CORS,'Content-Type':'application/json'}})
  }

    if (body.action === 'set_variant_backorder') {
    const store = (body.store || Deno.env.get('SHOPIFY_STORE') || '').replace('https://', '').replace('http://', '')
    const key = body.key || Deno.env.get('SHOPIFY_KEY') || ''
    const sku = (body.sku || body.pn || '').trim()
    const backorder = !!body.backorder
    const restockDate = body.restock_date || ''
    if (!store || !key || !sku) return new Response(JSON.stringify({error:'Missing store, key or sku'}), {status:400, headers:{...CORS,'Content-Type':'application/json'}})
    // Resolve the ERP record first so the prefix rule can consider BOTH pn and new_sku - the sku
    // arriving here is whichever alias the caller had, and a TGK product may be keyed on either.
    // A sku with no catalog record at all is a resale/drop-ship item and is judged on the sku
    // string alone, which is what stops non-TGK vendor products being managed.
    {
      let rec: any = null
      const { data: a1 } = await db.from('assemblies').select('pn,new_sku').eq('pn', sku).limit(1)
      if (a1?.length) rec = a1[0]
      if (!rec) { const { data: a2 } = await db.from('assemblies').select('pn,new_sku').eq('new_sku', sku).limit(1); if (a2?.length) rec = a2[0] }
      if (!rec) { const { data: p1 } = await db.from('parts').select('pn,new_sku').eq('pn', sku).limit(1); if (p1?.length) rec = p1[0] }
      if (!rec) { const { data: p2 } = await db.from('parts').select('pn,new_sku').eq('new_sku', sku).limit(1); if (p2?.length) rec = p2[0] }
      const managed = rec ? isTgkManagedSku(rec.pn, rec.new_sku) : isTgkManagedSku(sku)
      if (!managed) {
        console.log('[set_variant_backorder] skipped', sku, '- not a managed-prefix SKU (non-TGK resale/vendor product)')
        return new Response(JSON.stringify({ok:false, skipped_not_managed:true,
          note:'SKU is not a managed-prefix (TGK) product; backorder automation does not manage resale/vendor items'}), {headers:{...CORS,'Content-Type':'application/json'}})
      }
    }
    const H = {'X-Shopify-Access-Token': key, 'Content-Type': 'application/json'}
    const gqlTopErrors:string[] = []
    const gql = async (q) => {
      const r = await fetch('https://' + store + '/admin/api/2024-01/graphql.json', {method:'POST', headers:H, body: JSON.stringify({query:q})}).then(x=>x.json())
      if (r && Array.isArray(r.errors) && r.errors.length) {
        r.errors.forEach((e:any)=>gqlTopErrors.push(e?.message || JSON.stringify(e)))
      }
      return r
    }
    const safe = sku.replace(/"/g, '')
    // [FIX] Same exact-phrase fix as update_template/list_sku_variants above - this is the search
    // that was actually producing "No Shopify variant found" for real SKUs in a large numbered
    // family (TGK-0308-15/16/17, TGK-0409-10/13/15, etc.) whenever the true match fell outside
    // the first 10 fuzzy-tokenized results.
    const find = await gql('{ productVariants(first: 10, query: "sku:\\"' + safe + '\\"") { edges { node { id sku inventoryItem { id } product { id templateSuffix } metafield(namespace: \"custom\", key: \"estimated_arrival_date\") { value } } } } }')
    const edges = find?.data?.productVariants?.edges || []
    const allMatches = edges.filter((e:any) => (e.node.sku || '').trim().toUpperCase() === sku.toUpperCase())
    if (!allMatches.length) return new Response(JSON.stringify({error:'No Shopify variant found for SKU: ' + sku, debug: edges.map((e:any)=>e.node.sku)}), {status:404, headers:{...CORS,'Content-Type':'application/json'}})
    let heldIds = new Set()
    try {
      const hq = await db.from('variant_holds').select('shopify_variant_id').eq('sku', sku).eq('active', true)
      heldIds = new Set((hq.data || []).map((r:any) => r.shopify_variant_id))
    } catch (e) { console.warn('[set_variant_backorder] hold lookup failed:', e) }
    const notHeld = allMatches.filter((e:any) => !heldIds.has(e.node.id))
    const skippedHeld = allMatches.length - notHeld.length
    // Pre-order / bespoke-template products are intentional merchandising - excluded before any
    // write happens, not merely left out of the template reconciliation at the end.
    const targets = notHeld.filter((e:any) => isManagedBackorderTemplate(e.node.product?.templateSuffix))
    const skippedTemplates = notHeld
      .filter((e:any) => !isManagedBackorderTemplate(e.node.product?.templateSuffix))
      .map((e:any) => ({ variant: e.node.id, product: e.node.product?.id, template: e.node.product?.templateSuffix || '' }))
    if (skippedTemplates.length) console.log('[set_variant_backorder]', sku, '- skipped', skippedTemplates.length, 'variant(s) on a pre-order/custom template:', JSON.stringify(skippedTemplates.map((x:any)=>x.template)))
    if (!targets.length && skippedTemplates.length) {
      // Same honesty rule as the all-held case below: nothing was actually changed on Shopify, so
      // this must not be logged or counted as a successful backorder sync.
      return new Response(JSON.stringify({ok:false, skipped_all_preorder:true, skipped_templates:skippedTemplates,
        note:'every variant for this SKU is on a pre-order/custom template; backorder automation does not manage those'}), {headers:{...CORS,'Content-Type':'application/json'}})
    }
    if (!targets.length) {
      // [FIX] ok was true here, which caused BOTH ERP callers to treat a fully-held SKU as a
      // successful backorder sync -- the single-SKU caller's _logSync() wrote a 'backorder' row
      // to shopify_sync_log for a SKU that was never actually touched on Shopify (every matching
      // variant was on hold), and the bulk sync counted it toward backorderCount as if it had
      // succeeded. skipped_all_held still tells the caller nothing went WRONG; ok:false just
      // stops it from being recorded as if it went right.
      return new Response(JSON.stringify({ok:false, skipped_all_held:true, held_count:skippedHeld,
        note:'every variant for this SKU is on hold; nothing to sync'}), {headers:{...CORS,'Content-Type':'application/json'}})
    }

    // FIX: this used to take only targets[0] and silently leave every other variant sharing
    // the SKU untouched - the exact bug behind a SKU showing correctly backordered on one
    // chassis product page while a sibling page kept selling normally. A SKU sold across
    // several chassis pages shares one inventory pool, so every page has to reflect the same
    // stock reality - looping over every target is the actual fix, not an optimization.
    const perVariant: any[] = []
    const reconciledProducts = new Set()
    for (const match of targets) {
      const variantId = match.node.id
      const invItemId = match.node.inventoryItem?.id
      const prodId = match.node.product?.id
      const errs:string[] = []
      let actual_policy = null, actual_tracked = null

      // [FIX] An existing date normally wins over the one the ERP sends (so a hand-typed date such as
      // "Middle / end of July" is never overwritten). But a strict YYYY-MM-DD date that is ALREADY IN
      // THE PAST is a stale leftover, not a promise - keeping it is exactly how a product ended up
      // showing a lapsed restock date while still on backorder. Free-text ETAs are untouched.
      const _existingEtaRaw = String(match.node.metafield?.value || '').trim()
      const existingEta = (/^\d{4}-\d{2}-\d{2}$/.test(_existingEtaRaw) && _existingEtaRaw < centralDateOnly()) ? '' : _existingEtaRaw
      const effRestockDate = (backorder && existingEta && !body.force_restock_date) ? existingEta : restockDate
      const eta_preserved = !!(backorder && existingEta && !body.force_restock_date && existingEta !== restockDate)

      if (backorder) {
        if (invItemId) {
          const t = await gql('mutation { inventoryItemUpdate(id: "' + invItemId + '", input: {tracked: true}) { inventoryItem { tracked } userErrors { message } } }')
          ;(t?.data?.inventoryItemUpdate?.userErrors || []).forEach((u:any)=>errs.push(u.message))
          actual_tracked = t?.data?.inventoryItemUpdate?.inventoryItem?.tracked ?? actual_tracked
          const loc = await gql('{ locations(first: 1) { edges { node { id } } } }')
          const locId = loc?.data?.locations?.edges?.[0]?.node?.id
          if (locId) {
            const z = await gql('mutation { inventorySetOnHandQuantities(input: {reason: "correction", setQuantities: [{inventoryItemId: "' + invItemId + '", locationId: "' + locId + '", quantity: 0}]}) { userErrors { message } } }')
            ;(z?.data?.inventorySetOnHandQuantities?.userErrors || []).forEach((u:any)=>errs.push(u.message))
          }
        }
        const p = await gql('mutation { productVariantsBulkUpdate(productId: "' + prodId + '", variants: [{id: "' + variantId + '", inventoryPolicy: CONTINUE}]) { productVariants { id inventoryPolicy } userErrors { field message } } }')
        ;(p?.data?.productVariantsBulkUpdate?.userErrors || []).forEach((u:any)=>errs.push(u.message))
        actual_policy = p?.data?.productVariantsBulkUpdate?.productVariants?.[0]?.inventoryPolicy ?? actual_policy
        if (effRestockDate) {
          const m = await gql('mutation { metafieldsSet(metafields: [{ownerId: "' + variantId + '", namespace: "custom", key: "estimated_arrival_date", value: "' + effRestockDate + '", type: "single_line_text_field"}]) { userErrors { message } } }')
          ;(m?.data?.metafieldsSet?.userErrors || []).forEach((u:any)=>errs.push(u.message))
          // The storefront theme reads this date from TWO places: the variant's own metafield
          // (updated above) and the PRODUCT's own copy of the same field, used by a separate
          // block on the page. reconcileProductTemplate only ever handles which template
          // renders the page, never this value - so without this, the variant shows the fresh
          // date while the product-level block keeps showing whatever was last set (often
          // manually, often stale), on every single product this runs for, not just this one.
          if (prodId) {
            const pm = await gql('mutation { metafieldsSet(metafields: [{ownerId: "' + prodId + '", namespace: "custom", key: "estimated_arrival_date", value: "' + effRestockDate + '", type: "single_line_text_field"}]) { userErrors { message } } }')
            ;(pm?.data?.metafieldsSet?.userErrors || []).forEach((u:any)=>errs.push(u.message))
          }
        }
      } else {
        if (invItemId) {
          const t = await gql('mutation { inventoryItemUpdate(id: "' + invItemId + '", input: {tracked: false}) { inventoryItem { tracked } userErrors { message } } }')
          ;(t?.data?.inventoryItemUpdate?.userErrors || []).forEach((u:any)=>errs.push(u.message))
          actual_tracked = t?.data?.inventoryItemUpdate?.inventoryItem?.tracked ?? actual_tracked
        }
        const p = await gql('mutation { productVariantsBulkUpdate(productId: "' + prodId + '", variants: [{id: "' + variantId + '", inventoryPolicy: CONTINUE}]) { productVariants { id inventoryPolicy } userErrors { field message } } }')
        ;(p?.data?.productVariantsBulkUpdate?.userErrors || []).forEach((u:any)=>errs.push(u.message))
        actual_policy = p?.data?.productVariantsBulkUpdate?.productVariants?.[0]?.inventoryPolicy ?? actual_policy
        await clearEtaMetafield(gql, variantId)
        // Clear the product-level copy too, for the same reason it gets written above when
        // backordering - a restocked item must not leave a stale date on the block of the page
        // that reads the product's own metafield instead of the variant's.
        await clearEtaMetafield(gql, prodId)
      }

      const expected_policy = 'CONTINUE'
      const policy_ok = actual_policy === expected_policy
      let reason = ''
      let failsafe_applied = false
      if (backorder && !policy_ok) {
        try {
          if (invItemId) {
            const rb = await gql('mutation { inventoryItemUpdate(id: "' + invItemId + '", input: {tracked: false}) { inventoryItem { tracked } userErrors { message } } }')
            actual_tracked = rb?.data?.inventoryItemUpdate?.inventoryItem?.tracked ?? actual_tracked
            failsafe_applied = true
          }
          await clearEtaMetafield(gql, variantId)
          // Clear the product-level copy too - a variant that just got reverted (never
          // actually went into backorder) must not leave a promised date on the block of the
          // page that reads the product's own metafield instead of the variant's.
          await clearEtaMetafield(gql, prodId)
        } catch (e) { console.warn('[set_variant_backorder] failsafe untrack failed:', e) }
        const allErrTxt = errs.concat(gqlTopErrors)
        reason = 'Could not set inventoryPolicy to CONTINUE' + (actual_policy ? (' (Shopify reports ' + actual_policy + ')') : '') + '. '
          + (allErrTxt.length ? ('SHOPIFY SAID: ' + allErrTxt.join(' | ') + '. ') : 'Shopify returned no error text. ')
          + 'If it mentions a field not existing, the pinned Shopify API version has dropped that mutation - '
          + 'the edge function needs updating. If it mentions access denied, regenerate the Admin API token. '
          + (failsafe_applied ? 'Left the variant UNTRACKED so it stays orderable (no backorder badge).' : 'WARNING: variant may be unorderable - check it manually.')
      }

      let template_result = null
      if (policy_ok && prodId && !reconciledProducts.has(prodId)) {
        reconciledProducts.add(prodId)
        template_result = await reconcileProductTemplate(gql, prodId)
      }

      perVariant.push({
        variant: variantId, product: prodId, ok: backorder ? policy_ok : true, errors: errs,
        reason, actual_policy, actual_tracked, policy_ok, failsafe_applied,
        restock_date: effRestockDate || null, eta_preserved, template: template_result,
        orderable: (actual_tracked === false) || policy_ok
      })
    }

    const ok = perVariant.every((r:any) => r.ok)
    // [FIX] This used to log 'backorder' whenever ANY matching Shopify variant instance
    // succeeded (anySucceeded), even if another instance for the SAME sku (e.g. the same SKU
    // listed on a second chassis page) failed and was silently failsafe-reverted to normal/
    // available. That's how a SKU could show "backordered" in the ERP and the sync log while
    // one specific Shopify product page still sold it normally with no visible sign anything
    // was wrong. 'partial' is now a distinct, honest third state: some but not all instances
    // actually went into backorder, so the SKU needs a manual look, not a clean checkmark.
    const allSucceeded = ok
    const anySucceeded = perVariant.some((r:any) => r.ok)
    const effective_action = backorder ? (allSucceeded ? 'backorder' : (anySucceeded ? 'partial' : 'reverted')) : 'reverted'
    try { await db.from('shopify_sync_log').insert({ pn: sku, action: effective_action, trigger_source: body.trigger_source || 'erp_manual', restock_date: ((effective_action === 'backorder' || effective_action === 'partial') ? (perVariant[0]?.restock_date || restockDate || null) : null) }) } catch (e) { console.warn('[set_variant_backorder] log failed:', e) }
    // Existing callers read this action's OLD single-variant response shape directly at the
    // TOP level (d.template, d.reason, d.actual_policy, d.actual_tracked, d.failsafe_applied,
    // d.errors) - one caller's own error-reporting depends on d.reason specifically, and its
    // comment notes that was already fixed once before from exactly this kind of field going
    // missing. Rather than risk quietly breaking that again, the first variant's own outcome is
    // still spread at the top level (identical to today for the common single-variant case,
    // since results[0] IS the only result there), with the FULL per-variant breakdown
    // additionally available under variants_updated/results for anything that wants it.
    const primary = perVariant[0] || {}
    const flatErrors = perVariant.reduce((acc:string[], r:any) => acc.concat(r.errors || []), [])
    return new Response(JSON.stringify({
      ok, variant: primary.variant, backorder,
      logged_action: effective_action, // 'backorder' | 'partial' | 'reverted' -- exactly what was written to shopify_sync_log above, so callers don't have to re-derive it from results[]
      errors: flatErrors, graphql_errors: gqlTopErrors,
      reason: primary.reason || '', actual_policy: primary.actual_policy, actual_tracked: primary.actual_tracked,
      expected_policy: 'CONTINUE', policy_ok: primary.policy_ok, failsafe_applied: primary.failsafe_applied,
      restock_date: primary.restock_date, eta_preserved: primary.eta_preserved, template: primary.template,
      orderable: primary.orderable,
      variants_updated: perVariant.length, held_skipped: skippedHeld,
      preorder_skipped: skippedTemplates.length, skipped_templates: skippedTemplates, results: perVariant
    }), {headers:{...CORS,'Content-Type':'application/json'}})
  }
  // [AUDIT] Read-only. Reports the CURRENT live Shopify state of every SKU the backorder
  // automation has ever written to, so the damage from the pre-order bug (backorder automation
  // overriding products deliberately merchandised as pre-order) can be seen precisely instead of
  // guessed at. shopify_sync_log is the authoritative record of which SKUs were touched, so that
  // is the input rather than a hand-built list. Writes NOTHING - safe to run at any time.
  // Paginated by offset with deliberate pacing, same shape as backfill_sale_dates, because this
  // is one Shopify call per SKU and the rate limit is real.
  // [REPAIR] Undoes what the backorder automation did to products deliberately merchandised on a
  // pre-order template. Scope is deliberately minimal: it sets tracked:false on the affected
  // variants (an untracked variant is always purchasable, which is what a pre-order needs and what
  // the known-good variants in this store already look like) and optionally clears the ETA
  // metafield. It does NOT touch templateSuffix - the audit confirmed every affected product kept
  // its product-preorder template, so there is nothing to restore there and writing one would risk
  // breaking a product that is currently fine.
  //
  // clear_eta controls the metafield, because the data cannot tell an ERP-written date from one a
  // human set: the automation only ever writes an ETA when the variant has none, so a present date
  // may be either. Options:
  //   'none' (default) - leave every ETA exactly as-is; untrack only.
  //   'iso'            - clear only strict YYYY-MM-DD values, which is the ONLY shape this
  //                      automation ever writes. Free-text like "Middle / end of July" is
  //                      unambiguously human and is preserved.
  //   'all'            - clear every ETA on the affected variants and their products.
  // Dry run unless apply:true, and it reports the exact per-variant plan either way.
  if (body.action === 'repair_preorder_variants') {
    const store = (body.store || Deno.env.get('SHOPIFY_STORE') || '').replace('https://', '').replace('http://', '')
    const key = body.key || Deno.env.get('SHOPIFY_KEY') || ''
    if (!store || !key) return new Response(JSON.stringify({error:'Missing Shopify credentials'}), {status:400, headers:{...CORS,'Content-Type':'application/json'}})
    const applyIt = body.apply === true
    const clearEta = ['none','iso','all'].includes(String(body.clear_eta || 'none')) ? String(body.clear_eta || 'none') : 'none'
    const skus: string[] = Array.isArray(body.skus) && body.skus.length ? body.skus.map((x: any) => String(x).trim()).filter(Boolean) : []
    if (!skus.length) return new Response(JSON.stringify({error:'skus array is required (the pre-order SKUs from audit_backorder_state)'}), {status:400, headers:{...CORS,'Content-Type':'application/json'}})

    const H = {'X-Shopify-Access-Token': key, 'Content-Type': 'application/json'}
    const errs: string[] = []
    // [FIX] This used to collect only top-level GraphQL `errors` and ignore the per-mutation
    // `userErrors` payload - so a metafield write that Shopify REJECTED still reported
    // graphql_errors:[] and looked like a clean success, which is exactly how the first repair run
    // reported "cleared" while every date was still sitting on the product.
    const gq = async (q: string) => {
      const r = await fetch('https://' + store + '/admin/api/2024-01/graphql.json', {method:'POST', headers:H, body: JSON.stringify({query:q})}).then(x => x.json())
      ;(r?.errors || []).forEach((e: any) => errs.push(e?.message || JSON.stringify(e)))
      const d = r?.data || {}
      for (const k of Object.keys(d)) {
        const ue = d[k]?.userErrors
        if (Array.isArray(ue)) ue.forEach((u: any) => errs.push(k + ': ' + (u?.message || JSON.stringify(u))))
      }
      return r
    }
    // Clearing by DELETING the metafield rather than writing a blank value. Writing '' or ' ' with
    // type single_line_text_field fails outright when the metafield is defined as a date type (the
    // likely reason the first run's clears were rejected), and a blank string is a worse end state
    // than absence anyway. metafieldsDelete is type-agnostic and idempotent - deleting one that is
    // already gone is a no-op, not an error.
    const clearMetafield = async (ownerId: string) => {
      const m = await gq('mutation { metafieldsDelete(metafields: [{ownerId: "' + ownerId + '", namespace: "custom", key: "estimated_arrival_date"}]) { deletedMetafields { key } userErrors { field message } } }')
      return Array.isArray(m?.data?.metafieldsDelete?.deletedMetafields)
    }
    const isIsoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim())
    const plan: any[] = []

    for (const sku of skus) {
      const safe = sku.replace(/"/g, '')
      const q = '{ productVariants(first: 10, query: "sku:\\"' + safe + '\\"") { edges { node { '
        + 'id sku inventoryItem { id tracked } '
        + 'metafield(namespace: "custom", key: "estimated_arrival_date") { value } '
        + 'product { id title templateSuffix metafield(namespace: "custom", key: "estimated_arrival_date") { value } } '
        + '} } } }'
      const r = await gq(q)
      const matches = (r?.data?.productVariants?.edges || [])
        .map((e: any) => e.node)
        .filter((n: any) => (n.sku || '').trim().toUpperCase() === sku.toUpperCase())
      if (!matches.length) { plan.push({ sku, skipped: 'no Shopify variant with this SKU' }); continue }
      for (const n of matches) {
        const tpl = n.product?.templateSuffix || ''
        // Hard safety rail: only ever touch a variant that is genuinely on a pre-order template.
        // Passing a wrong SKU in the list therefore cannot damage a normal product.
        if (!/pre[-_ ]?order/i.test(tpl)) {
          plan.push({ sku, variant: n.id, product_title: n.product?.title, template_suffix: tpl, skipped: 'not on a pre-order template - left untouched' })
          continue
        }
        const vEta = String(n.metafield?.value || '').trim()
        const pEta = String(n.product?.metafield?.value || '').trim()
        const willUntrack = !!n.inventoryItem?.tracked
        const clearV = clearEta === 'all' ? !!vEta : (clearEta === 'iso' ? isIsoDate(vEta) : false)
        const clearP = clearEta === 'all' ? !!pEta : (clearEta === 'iso' ? isIsoDate(pEta) : false)
        const row: any = { sku, variant: n.id, product: n.product?.id, product_title: n.product?.title,
          template_suffix: tpl, currently_tracked: !!n.inventoryItem?.tracked,
          will_untrack: willUntrack, variant_eta: vEta, product_eta: pEta,
          will_clear_variant_eta: clearV, will_clear_product_eta: clearP }
        if (applyIt) {
          if (willUntrack && n.inventoryItem?.id) {
            const t = await gq('mutation { inventoryItemUpdate(id: "' + n.inventoryItem.id + '", input: {tracked: false}) { inventoryItem { tracked } userErrors { message } } }')
            row.untracked_ok = t?.data?.inventoryItemUpdate?.inventoryItem?.tracked === false
          }
          if (clearV) row.cleared_variant_eta_ok = await clearMetafield(n.id)
          if (clearP && n.product?.id) row.cleared_product_eta_ok = await clearMetafield(n.product.id)
          await new Promise(r2 => setTimeout(r2, 400))
        }
        plan.push(row)
      }
    }
    const toUntrack = plan.filter((x: any) => x.will_untrack).length
    return new Response(JSON.stringify({
      ok: true, apply: applyIt, clear_eta: clearEta,
      summary: { variants_seen: plan.length, will_untrack: toUntrack,
        will_clear_variant_eta: plan.filter((x: any) => x.will_clear_variant_eta).length,
        will_clear_product_eta: plan.filter((x: any) => x.will_clear_product_eta).length,
        skipped: plan.filter((x: any) => x.skipped).length },
      graphql_errors: errs, plan,
      note: applyIt ? 'Applied.' : 'Dry run - nothing written. Re-send with apply:true to execute exactly this plan.'
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  if (body.action === 'audit_backorder_state') {
    const store = (body.store || Deno.env.get('SHOPIFY_STORE') || '').replace('https://', '').replace('http://', '')
    const key = body.key || Deno.env.get('SHOPIFY_KEY') || ''
    if (!store || !key) return new Response(JSON.stringify({error:'Missing Shopify credentials'}), {status:400, headers:{...CORS,'Content-Type':'application/json'}})
    const limit = Math.min(Math.max(parseInt(body.limit) || 25, 1), 60)
    const offset = Math.max(parseInt(body.offset) || 0, 0)
    const sinceDays = Math.max(parseInt(body.since_days) || 180, 1)
    const sinceIso = new Date(Date.now() - sinceDays * 86400000).toISOString()

    let skus: string[] = []
    try {
      if (Array.isArray(body.skus) && body.skus.length) {
        skus = body.skus.map((x: any) => String(x).trim()).filter(Boolean)
      } else {
        const seen = new Set<string>()
        let from = 0
        const pageSize = 1000
        while (true) {
          const { data, error } = await db.from('shopify_sync_log')
            .select('pn,created_at,action')
            .gte('created_at', sinceIso)
            .order('pn', { ascending: true })
            .range(from, from + pageSize - 1)
          if (error) throw error
          for (const r of (data || [])) {
            // Only SKUs the automation actually pushed INTO backorder can have overridden a
            // pre-order presentation; 'reverted' rows are the automation undoing itself.
            if (r.pn && (r.action === 'backorder' || r.action === 'partial')) seen.add(r.pn)
          }
          if (!data || data.length < pageSize) break
          from += pageSize
        }
        skus = [...seen].sort()
      }
    } catch (e) {
      return new Response(JSON.stringify({error:'Failed to read shopify_sync_log: ' + String((e as any)?.message || e)}), {status:500, headers:{...CORS,'Content-Type':'application/json'}})
    }

    const page = skus.slice(offset, offset + limit)
    const H = {'X-Shopify-Access-Token': key, 'Content-Type': 'application/json'}
    const rows: any[] = []
    for (const sku of page) {
      try {
        const safe = sku.replace(/"/g, '')
        const q = '{ productVariants(first: 10, query: "sku:\\"' + safe + '\\"") { edges { node { '
          + 'id sku inventoryPolicy inventoryQuantity inventoryItem { tracked } '
          + 'metafield(namespace: "custom", key: "estimated_arrival_date") { value } '
          + 'product { id title handle templateSuffix metafield(namespace: "custom", key: "estimated_arrival_date") { value } } '
          + '} } } }'
        const r = await fetch('https://' + store + '/admin/api/2024-01/graphql.json', {method:'POST', headers:H, body: JSON.stringify({query:q})}).then(x => x.json())
        const matches = (r?.data?.productVariants?.edges || [])
          .map((e: any) => e.node)
          .filter((n: any) => (n.sku || '').trim().toUpperCase() === sku.toUpperCase())
        if (!matches.length) { rows.push({ sku, found: false, note: 'no Shopify variant with this SKU' }); continue }
        for (const n of matches) {
          const tpl = n.product?.templateSuffix || ''
          rows.push({
            sku,
            found: true,
            variant_id: n.id,
            product_id: n.product?.id,
            product_title: n.product?.title,
            handle: n.product?.handle,
            template_suffix: tpl,
            looks_preorder: /pre[-_ ]?order/i.test(tpl),
            tracked: !!n.inventoryItem?.tracked,
            inventory_policy: n.inventoryPolicy,
            inventory_quantity: n.inventoryQuantity,
            variant_eta: (n.metafield?.value || '').trim(),
            product_eta: (n.product?.metafield?.value || '').trim()
          })
        }
        await new Promise(r2 => setTimeout(r2, 550))
      } catch (e) {
        rows.push({ sku, found: false, error: String((e as any)?.message || e) })
      }
    }

    // Grouped so the answer to "what did this break" is readable without scanning every row.
    const onPreorderTpl = rows.filter((r: any) => r.found && r.looks_preorder)
    const backorderLooking = rows.filter((r: any) => r.found && !r.looks_preorder && r.tracked && (r.inventory_quantity || 0) <= 0)
    return new Response(JSON.stringify({
      ok: true,
      total_skus_in_log: skus.length,
      processed_this_batch: page.length,
      next_offset: offset + page.length,
      done: (offset + page.length) >= skus.length,
      summary: {
        still_on_preorder_template: onPreorderTpl.length,
        preorder_but_tracked_or_zeroed: onPreorderTpl.filter((r: any) => r.tracked || r.variant_eta || r.product_eta).length,
        currently_backorder_looking: backorderLooking.length
      },
      rows
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

if (body.action === 'list_product_templates') {
    const store = (body.store || Deno.env.get('SHOPIFY_STORE') || '').replace('https://', '').replace('http://', '')
    const key = body.key || Deno.env.get('SHOPIFY_KEY') || ''
    if (!store || !key) return new Response(JSON.stringify({error:'Missing Shopify credentials'}), {status:400, headers:{...CORS,'Content-Type':'application/json'}})
    const page_info = body.page_info || ''
    const url = page_info
      ? 'https://' + store + '/admin/api/2024-01/products.json?limit=250&page_info=' + page_info
      : 'https://' + store + '/admin/api/2024-01/products.json?limit=250&published_status=any&fields=id,title,handle,template_suffix,variants'
    const res = await fetch(url, {headers:{'X-Shopify-Access-Token': key}})
    if (!res.ok) return new Response(JSON.stringify({error:'Shopify ' + res.status + ' - check API key has read_products scope'}), {status:res.status, headers:{...CORS,'Content-Type':'application/json'}})
    const data = await res.json()
    const products = data.products || []
    const items: any[] = []
    for (const product of products) {
      const variants = (product.variants || []).filter((v:any) => (v.sku || '').trim() !== '').map((v:any) => ({
        sku: (v.sku || '').trim(),
        tracked: !!v.inventory_management,
        policy: v.inventory_policy || '',
        qty: (typeof v.inventory_quantity === 'number' ? v.inventory_quantity : null)
      }))
      if (!variants.length) continue
      items.push({id: product.id, title: product.title || '', handle: product.handle || '', template_suffix: product.template_suffix || '', variants})
    }
    const link = res.headers.get('link') || ''
    let next_page_info = ''
    for (const part of link.split(',')) {
      if (part.includes('rel="next"')) { const m = part.match(/page_info=([^&>"]+)/); if (m) { next_page_info = m[1]; break } }
    }
    return new Response(JSON.stringify({products: items, count: products.length, next_page_info}), {headers:{...CORS,'Content-Type':'application/json'}})
  }

  // [FEATURE] One-time backfill for orders written before centralDateOnly() existed. The raw
  // Shopify order timestamp was never stored anywhere -- only the already-computed (and buggy)
  // sale_date was -- so there's no way to recompute the correct date from what's already in the
  // sales table. This re-fetches each distinct Shopify order directly from Shopify (the one place
  // the real timestamp still exists), recomputes sale_date the same correct way the live webhook
  // now does, and updates every sales row sharing that order. Paginated by offset (not a new
  // tracking column) so repeated calls with an incrementing offset cover every order exactly
  // once; the id lookup itself is page-fetched in 1000-row chunks rather than a single unbounded
  // select, since Supabase/PostgREST caps an unbounded request at 1000 rows by default and this
  // table can easily exceed that.
  if (body.action === 'backfill_sale_dates') {
    const store = (body.store || Deno.env.get('SHOPIFY_STORE') || '').replace('https://', '').replace('http://', '')
    const key = body.key || Deno.env.get('SHOPIFY_KEY') || ''
    if (!store || !key) return new Response(JSON.stringify({error:'Missing Shopify credentials'}), {status:400, headers:{...CORS,'Content-Type':'application/json'}})
    const limit = Math.min(Math.max(parseInt(body.limit) || 20, 1), 50)
    const offset = Math.max(parseInt(body.offset) || 0, 0)

    let allIds: string[] = []
    try {
      const seen = new Set<string>()
      let from = 0
      const pageSize = 1000
      while (true) {
        const { data, error } = await db.from('sales')
          .select('shopify_order_id')
          .not('shopify_order_id', 'is', null)
          .order('shopify_order_id', { ascending: true })
          .range(from, from + pageSize - 1)
        if (error) throw error
        for (const r of (data || [])) if (r.shopify_order_id) seen.add(r.shopify_order_id)
        if (!data || data.length < pageSize) break
        from += pageSize
      }
      allIds = [...seen].sort()
    } catch (e) {
      return new Response(JSON.stringify({error: 'Failed to list orders: ' + String((e as any)?.message || e)}), {status:500, headers:{...CORS,'Content-Type':'application/json'}})
    }

    const pageIds = allIds.slice(offset, offset + limit)
    let updated = 0, unchanged = 0
    const errors: string[] = []

    for (const oid of pageIds) {
      try {
        const res = await fetch('https://' + store + '/admin/api/2024-01/orders/' + oid + '.json?fields=id,created_at', { headers: { 'X-Shopify-Access-Token': key } })
        if (!res.ok) { errors.push(oid + ': Shopify ' + res.status); continue }
        const j = await res.json()
        const createdAt = j?.order?.created_at
        if (!createdAt) { errors.push(oid + ': no created_at returned'); continue }
        const correctDate = centralDateOnly(createdAt)
        const { data: matchRows, error: selErr } = await db.from('sales').select('id, sale_date').eq('shopify_order_id', oid)
        if (selErr) { errors.push(oid + ': ' + selErr.message); continue }
        for (const row of (matchRows || [])) {
          if (row.sale_date !== correctDate) {
            const { error: upErr } = await db.from('sales').update({ sale_date: correctDate }).eq('id', row.id)
            if (upErr) errors.push(oid + ' (row ' + row.id + '): ' + upErr.message)
            else updated++
          } else {
            unchanged++
          }
        }
        // Gentle pacing to stay well within Shopify's standard rate-limit bucket.
        await new Promise(r => setTimeout(r, 550))
      } catch (e) {
        errors.push(oid + ': ' + String((e as any)?.message || e))
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      total_orders: allIds.length,
      processed_this_batch: pageIds.length,
      next_offset: offset + pageIds.length,
      done: (offset + pageIds.length) >= allIds.length,
      updated, unchanged, errors
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // [FEATURE] Drop-ship "Mark Shipped" needs to actually fulfill the real Shopify order -- today
  // that flow only updates the ERP's own sales table, so the customer never gets Shopify's
  // shipping-confirmation email and the order sits open in Shopify indefinitely even though it
  // genuinely shipped. Creates a PARTIAL fulfillment covering only the given line item(s) (an
  // order can have other, non-drop-ship lines that ship separately), with tracking attached and
  // notifyCustomer:true so Shopify sends its normal "your order has shipped" email. Accepts an
  // array of {sku, qty} so a multi-line drop-ship-all action can fulfill everything in ONE call --
  // one email for the shipment, not one per SKU.
  if (body.action === 'create_fulfillment') {
    const store = (body.store || Deno.env.get('SHOPIFY_STORE') || '').replace('https://', '').replace('http://', '')
    const key = body.key || Deno.env.get('SHOPIFY_KEY') || ''
    if (!store || !key) return new Response(JSON.stringify({error:'Missing Shopify credentials'}), {status:400, headers:{...CORS,'Content-Type':'application/json'}})
    const shopifyOrderId = String(body.shopify_order_id || '').trim()
    const items: {sku:string, qty:number}[] = Array.isArray(body.items)
      ? body.items.map((i: any) => ({ sku: String(i.sku || '').trim(), qty: Math.max(1, parseInt(i.qty) || 1) })).filter((i: any) => i.sku)
      : []
    const trackingNumber = String(body.tracking_number || '').trim()
    const carrier = String(body.carrier || '').trim()
    if (!shopifyOrderId || !items.length) {
      return new Response(JSON.stringify({error:'shopify_order_id and at least one item (sku, qty) are required'}), {status:400, headers:{...CORS,'Content-Type':'application/json'}})
    }

    const H = {'X-Shopify-Access-Token': key, 'Content-Type': 'application/json'}
    const gqlErrs: string[] = []
    const gql = async (q: string, vars?: any) => {
      const r = await fetch('https://' + store + '/admin/api/2024-10/graphql.json', {
        method: 'POST', headers: H, body: JSON.stringify(vars ? {query: q, variables: vars} : {query: q})
      }).then(x => x.json())
      if (r && Array.isArray(r.errors) && r.errors.length) r.errors.forEach((e: any) => gqlErrs.push(e?.message || JSON.stringify(e)))
      return r
    }

    const orderGid = shopifyOrderId.startsWith('gid://') ? shopifyOrderId : ('gid://shopify/Order/' + shopifyOrderId)
    const foRes = await gql(
      `query($id: ID!) { order(id: $id) { id fulfillmentOrders(first: 10) { edges { node {
         id status lineItems(first: 50) { edges { node { id remainingQuantity lineItem { sku } } } }
       } } } } }`,
      { id: orderGid }
    )
    const order = foRes?.data?.order
    if (!order) {
      return new Response(JSON.stringify({error: 'Shopify order not found for id ' + shopifyOrderId, graphql_errors: gqlErrs}), {status:404, headers:{...CORS,'Content-Type':'application/json'}})
    }

    // Match each requested SKU to its open FulfillmentOrderLineItem, grouped by which
    // FulfillmentOrder it belongs to (normally all one order's lines share a single fulfillment
    // order, but Shopify can split them -- e.g. across locations -- so this handles either case).
    const byFO: Record<string, {id: string, quantity: number}[]> = {}
    const notFoundSkus: string[] = []
    for (const item of items) {
      let found = false
      for (const foEdge of (order.fulfillmentOrders?.edges || [])) {
        const fo = foEdge.node
        if (fo.status !== 'OPEN' && fo.status !== 'IN_PROGRESS') continue
        for (const liEdge of (fo.lineItems?.edges || [])) {
          const li = liEdge.node
          const liSku = (li.lineItem?.sku || '').trim().toUpperCase()
          if (liSku === item.sku.toUpperCase() && (li.remainingQuantity || 0) > 0) {
            const q = Math.min(item.qty, li.remainingQuantity)
            if (!byFO[fo.id]) byFO[fo.id] = []
            byFO[fo.id].push({ id: li.id, quantity: q })
            found = true
            break
          }
        }
        if (found) break
      }
      if (!found) notFoundSkus.push(item.sku)
    }
    const foGroups = Object.keys(byFO)
    if (!foGroups.length) {
      return new Response(JSON.stringify({error: 'No open fulfillment-order line item found for any of: ' + items.map(i => i.sku).join(', ') + ' (already fulfilled, or SKU mismatch)', graphql_errors: gqlErrs}), {status:404, headers:{...CORS,'Content-Type':'application/json'}})
    }

    const fulfillmentInput: any = {
      notifyCustomer: true,
      lineItemsByFulfillmentOrder: foGroups.map(foId => ({ fulfillmentOrderId: foId, fulfillmentOrderLineItems: byFO[foId] }))
    }
    if (trackingNumber) fulfillmentInput.trackingInfo = { number: trackingNumber, company: carrier || undefined }

    const fRes = await gql(
      `mutation($fulfillment: FulfillmentV2Input!) { fulfillmentCreateV2(fulfillment: $fulfillment) { fulfillment { id status } userErrors { field message } } }`,
      { fulfillment: fulfillmentInput }
    )
    const userErrors = fRes?.data?.fulfillmentCreateV2?.userErrors || []
    if (userErrors.length) {
      return new Response(JSON.stringify({error: userErrors.map((e: any) => e.message).join('; '), graphql_errors: gqlErrs}), {status:502, headers:{...CORS,'Content-Type':'application/json'}})
    }
    const fulfillment = fRes?.data?.fulfillmentCreateV2?.fulfillment
    return new Response(JSON.stringify({
      ok: true,
      fulfillment_id: fulfillment?.id || null,
      status: fulfillment?.status || null,
      fulfilled_items: items.length - notFoundSkus.length,
      not_found_skus: notFoundSkus
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  let topic = req.headers.get('x-shopify-topic')
    || req.headers.get('X-Shopify-Topic')
    || ''
  if (!topic) {
    if (body.line_items && body.id && body.order_number) {
      topic = body.cancelled_at ? 'orders/cancelled' : 'orders/create'
    } else if (body.cancel_reason !== undefined) {
      topic = 'orders/cancelled'
    }
  }
  // [AUDIT] create_refund carries no Shopify topic, so it used to stop here with a plain 'ok' and never
  // reach its handler below - the ERP then failed to parse that as JSON and reported a Shopify error.
  if (!topic && body.action !== 'create_refund') return new Response('ok', { headers: CORS })
  // [AUDIT] Shopify webhook signature check (opt-in). Set SHOPIFY_WEBHOOK_SECRET in this function's secrets
  // to the webhook signing secret (Shopify admin > Settings > Notifications > Webhooks). Until it is set,
  // behaviour is unchanged. Once set, an order webhook without a valid signature is refused.
  const _whSecret = Deno.env.get('SHOPIFY_WEBHOOK_SECRET') || ''
  if (_whSecret && topic) {
    const _sig = req.headers.get('x-shopify-hmac-sha256') || ''
    const _key = await crypto.subtle.importKey('raw', new TextEncoder().encode(_whSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const _mac = new Uint8Array(await crypto.subtle.sign('HMAC', _key, new TextEncoder().encode(_rawBody)))
    let _bin = ''
    for (let i = 0; i < _mac.length; i++) _bin += String.fromCharCode(_mac[i])
    const _exp = btoa(_bin)
    let _diff = _sig.length === _exp.length ? 0 : 1
    for (let i = 0; i < _exp.length && i < _sig.length; i++) _diff |= _sig.charCodeAt(i) ^ _exp.charCodeAt(i)
    if (_diff !== 0) {
      console.warn('[shopify-orders] rejected webhook with missing/invalid signature, topic', topic)
      return new Response('invalid signature', { status: 401, headers: CORS })
    }
  }
  try {
    const order = body
    const fin = (order.financial_status || '').toLowerCase()
    if (topic === 'orders/create') {
      const custName = (order.shipping_address?.name || order.billing_address?.name || (order.customer ? (order.customer.first_name||'')+' '+(order.customer.last_name||'') : '')).trim()
      const custEmail = order.email || order.customer?.email || ''
      for (const li of (order.line_items || [])) {
        const pn = li.sku ? li.sku.trim().toUpperCase() : (li.title || '').trim()
        if (!pn) continue
        // [FIX] Same falsy-zero trap as the orders/updated reconciliation below - a line that
        // arrives already zeroed out is not part of the order and must not be inserted as qty 1.
        const _createQty = (li.current_quantity !== undefined && li.current_quantity !== null)
          ? Number(li.current_quantity)
          : ((li.quantity === undefined || li.quantity === null) ? 1 : Number(li.quantity))
        if (_createQty <= 0) { console.log('[shopify-orders] orders/create: skipping zero-quantity line', order.name, pn); continue }
        const { data: existing } = await db.from('sales').select('id').eq('order_number', order.name).eq('pn', pn).limit(1)
        if (existing?.length) { console.log('[shopify-orders] skipping duplicate', order.name, pn); continue }
        const shipAddr = order.shipping_address || {}
        const { error: insErr } = await db.from('sales').insert({
          order_number: order.name,
          pn,
          qty: _createQty,
          source: 'Shopify',
          fulfillment_status: 'Open',
          financial_status: order.financial_status || 'pending',
          sale_date: centralDateOnly(order.created_at),
          customer_name: custName || null,
          customer_email: custEmail || null,
          customer_phone: shipAddr.phone || order.customer?.phone || null,
          shipping_address1: shipAddr.address1 || null,
          shipping_address2: shipAddr.address2 || null,
          shipping_city: shipAddr.city || null,
          shipping_province: shipAddr.province_code || shipAddr.province || null,
          shipping_zip: shipAddr.zip || null,
          shipping_country: shipAddr.country_code || shipAddr.country || null,
          discount_code: (order.discount_codes && order.discount_codes.length ? order.discount_codes[0].code : null),
          shopify_order_id: String(order.id),
          shopify_line_item_id: String(li.id),
        })
        if (insErr) console.error('[shopify-orders] insert error:', insErr.message, insErr.details)
        else await dedupeSalesLine(order.name, pn)
      }
      // Runs after the insert loop so it flags rows that already exist, rather than racing them.
      await checkOrderRisk(order.id, order.name)

      // [FIX] Closes the Support Center <-> Shopify loop: if this order came from a Support
      // Center draft, create-draft-order attached email_id as a custom attribute on the draft,
      // which Shopify copies verbatim into the completed order's note_attributes. Reading it
      // back here and writing emails.shopify_order_id means the ERP flips from "Sent to
      // Shopify" to "Shopify order" automatically the moment the customer pays the invoice (or
      // staff completes the draft manually) - same field completeShopifyDraft() sets by hand,
      // just no longer dependent on someone remembering to click it. Orders that did NOT come
      // from a draft (no email_id attribute) simply skip this block, unaffected.
      const emailIdAttr = (order.note_attributes || []).find((a: any) => a?.name === 'email_id')
      if (emailIdAttr?.value) {
        try {
          const { error: linkErr } = await db.from('emails')
            .update({ shopify_order_id: order.name, updated_at: new Date().toISOString() })
            .eq('id', emailIdAttr.value)
          if (linkErr) console.error('[shopify-orders] emails link-back error:', linkErr.message)
        } catch (e) { console.warn('[shopify-orders] emails link-back failed:', e) }
      }
    } else if (topic === 'orders/cancelled') {
      // Only cancel lines that have NOT shipped. Flipping a shipped line to Cancelled leaves its
      // stock deducted while erasing the sale that explains it, and drops real revenue.
      await db.from('sales')
        .update({ fulfillment_status: 'Cancelled', cancelled_at: order.cancelled_at })
        .eq('order_number', order.name)
        .in('fulfillment_status', ['Open', 'Packed', 'Partial', 'partial', 'On Hold', 'Pre-Order', 'Pre-order'])
    } else if (topic === 'orders/updated') {
      const updFields: Record<string, any> = {}
      // [AUDIT] A PARTIAL refund (one returned item, a shipping refund, a goodwill credit - including the
      // refund the ERP's own Returns screen creates) used to flip EVERY line on the order to Refunded. Lines
      // still waiting to ship dropped out of open demand, and when they did ship the ShipStation webhook saw
      // a terminal status and never deducted their stock. Partial refunds now only record financial_status:
      // Shopify lowers the refunded line's current_quantity and the reconciliation below handles exactly that
      // line. A FULL refund or void still marks lines Refunded, but never overwrites a Returned/Cancelled line.
      if (fin === 'refunded' || fin === 'voided' || fin === 'partially_refunded') {
        updFields.financial_status = fin
      }
      const ua = order.shipping_address || {}
      if (ua.address1) {
        updFields.shipping_address1 = ua.address1 || null
        updFields.shipping_address2 = ua.address2 || null
        updFields.shipping_city = ua.city || null
        updFields.shipping_province = ua.province_code || ua.province || null
        updFields.shipping_zip = ua.zip || null
        updFields.shipping_country = ua.country_code || ua.country || null
        updFields.customer_phone = ua.phone || order.customer?.phone || null
      }
      if (Object.keys(updFields).length) {
        await db.from('sales').update(updFields).eq('order_number', order.name)
      }
      if (fin === 'refunded' || fin === 'voided') {
        await db.from('sales').update({ fulfillment_status: 'Refunded' }).eq('order_number', order.name)
          .or('fulfillment_status.is.null,fulfillment_status.not.in.(Returned,Cancelled,Refunded)')
      }

      // [FIX] Root cause of a removed/edited line item never updating in the ERP: this handler
      // previously never looked at order.line_items again after the order was first created, so
      // deleting a SKU from an existing multi-SKU order (in Shopify admin) or changing its
      // quantity had NO code path reacting to it at all - the sales row just sat there forever
      // with stale data. orders/updated fires on exactly this kind of edit (in addition to the
      // more specific orders/edited topic, which carries an edit-delta payload instead of the
      // full order - reconciling against this handler's full current snapshot is simpler and
      // reuses the exact matching/insert logic orders/create already relies on, rather than
      // hand-parsing Shopify's separate addition/removal delta shape).
      //
      // Three cases, each mirroring an existing convention elsewhere in this file:
      //   - SKU present before but missing now -> cancel that line (same convention
      //     orders/cancelled already uses for a whole-order cancellation), but ONLY if it is
      //     still in a non-terminal status. A line that already shipped keeps its record
      //     untouched - the stock already left, and cancelling it would misrepresent a real
      //     shipment as though it never happened.
      //   - SKU present both before and now, with a different quantity -> update qty on that
      //     row (only while non-terminal - a shipped line's qty reflects what actually left).
      //   - SKU present now but not before -> insert it, same shape orders/create uses.
      // Known limitation: matching is by SKU (falling back to title), same as orders/create -
      // if one order genuinely has two separate line items sharing the same SKU, this cannot
      // tell them apart. That is an existing limitation of the matching scheme, not new here.
      const _TERMINAL_LINE_STATUSES = ['shipped', 'delivered', 'cancelled', 'canceled', 'refunded', 'returned', 'fulfilled']
      const currentLineItems = order.line_items || []
      const _normU = (x: string) => (x || '').trim().toUpperCase()
      // [FIX] Root cause of duplicated sales rows on split/multi-shipment orders: this reconciliation
      // originally matched Shopify's line-item SKU against existing sales.pn as plain, un-resolved
      // strings. This ERP has a known, previously-documented legacy-pn/new_sku duality on its own
      // TGK-numbered catalog - if a later orders/updated webhook ever reports a line under the OTHER
      // alias than what sales.pn already holds (a rename since the order was created, or simply which
      // alias Shopify happens to echo back on a given webhook), the old row looked "removed" (wrong
      // alias not found -> cancelled) AND the same line looked "new" (that alias not seen before ->
      // inserted) IN THE SAME PASS - producing a duplicate row for one physical item. The vendor
      // drop-ship SKUs on the same orders never hit this because they have no assemblies/parts record
      // at all, so no duality is possible for them - consistent with only the TGK-catalog lines
      // duplicating in practice. Resolving every SKU string (both Shopify's current line items and the
      // existing sales.pn values) to the assembly/part's canonical pn before comparing - same pattern
      // now used in shipstation-ship.ts's hold_sync - closes this for good.
      const _aliasCandidates = new Set<string>()
      for (const li of currentLineItems) { const pn = li.sku ? li.sku.trim() : (li.title || '').trim(); if (pn) _aliasCandidates.add(pn) }
      const { data: existingLineRows } = await db.from('sales').select('id,pn,qty,fulfillment_status').eq('order_number', order.name)
      for (const row of (existingLineRows || [])) if (row.pn) _aliasCandidates.add(row.pn)
      const _aliasList = [..._aliasCandidates]
      const _canonMap: Record<string, string> = {}
      if (_aliasList.length) {
        const { data: a1 } = await db.from('assemblies').select('pn').in('pn', _aliasList)
        ;(a1 || []).forEach((r: any) => { _canonMap[_normU(r.pn)] = r.pn })
        const { data: a2 } = await db.from('assemblies').select('pn,new_sku').in('new_sku', _aliasList)
        ;(a2 || []).forEach((r: any) => { if (r.new_sku) _canonMap[_normU(r.new_sku)] = r.pn })
        const { data: p1 } = await db.from('parts').select('pn').in('pn', _aliasList)
        ;(p1 || []).forEach((r: any) => { if (!(_normU(r.pn) in _canonMap)) _canonMap[_normU(r.pn)] = r.pn })
        const { data: p2 } = await db.from('parts').select('pn,new_sku').in('new_sku', _aliasList)
        ;(p2 || []).forEach((r: any) => { if (r.new_sku && !(_normU(r.new_sku) in _canonMap)) _canonMap[_normU(r.new_sku)] = r.pn })
      }
      // Falls back to the normalized raw string when nothing matched (e.g. drop-ship SKUs with no
      // assemblies/parts record at all) - identical to today's behavior for those.
      const _canon = (raw: string): string => { const n = _normU(raw); return _canonMap[n] || n }
      // [FIX] Root cause of "the ERP keeps re-adding a SKU I zeroed out in Shopify, and tells me
      // to order 1 of it": this read the incoming quantity as `li.quantity || 1`, and 0 is falsy
      // in JS - so a line explicitly zeroed out in Shopify (the normal way to remove an item from
      // an order that is already in fulfillment) was read as a quantity of ONE. That made the
      // reconciliation treat a removed line as a live line: it stayed out of the "cancel" branch,
      // and once the row was deleted by hand it came back as a "new" line on the very next
      // webhook, at qty 1, forever. Shopify keeps sending zeroed lines in line_items rather than
      // dropping them from the array, so the quantity is the ONLY signal that it's gone. Now: a
      // missing/undefined quantity still defaults to 1 (unchanged for normal orders), but an
      // explicit 0 or negative is treated as removed - excluded from the current-lines map so the
      // existing row gets cancelled, and excluded from the insert list so it is never re-added.
      // [FIX] Shopify's ORDER EDITING feature (removing an item from an already-placed order -
      // it shows under a "Removed" heading with a refund owed) does NOT zero line_items[].quantity;
      // that keeps its ORIGINAL value, and the post-edit amount lands in a SEPARATE field,
      // current_quantity, which drops to 0. Guarding only on quantity therefore missed exactly the
      // case this reconciliation exists to handle, and the removed line kept being re-inserted.
      // current_quantity is authoritative post-edit and post-refund; quantity is the fallback for
      // older payloads predating the field.
      const _liQty = (li: any): number => {
        if (li.current_quantity !== undefined && li.current_quantity !== null) return Number(li.current_quantity)
        return (li.quantity === undefined || li.quantity === null) ? 1 : Number(li.quantity)
      }
      const currentPnQty: Record<string, number> = {}
      for (const li of currentLineItems) {
        const pn = li.sku ? li.sku.trim().toUpperCase() : (li.title || '').trim()
        if (!pn) continue
        const q = _liQty(li)
        if (q <= 0) { console.log('[shopify-orders] orders/updated: line zeroed out in Shopify ->', order.name, pn, '- treating as removed'); continue }
        currentPnQty[_canon(pn)] = q
      }
      for (const row of (existingLineRows || [])) {
        const rowPn = _canon(row.pn || '')
        const isTerminal = _TERMINAL_LINE_STATUSES.includes(String(row.fulfillment_status || '').toLowerCase())
        if (isTerminal) continue
        if (!(rowPn in currentPnQty)) {
          await db.from('sales').update({ fulfillment_status: 'Cancelled', cancelled_at: new Date().toISOString() }).eq('id', row.id)
          console.log('[shopify-orders] orders/updated: line removed from order ->', order.name, rowPn, '- cancelled')
        } else if ((row.qty || 1) !== currentPnQty[rowPn]) {
          await db.from('sales').update({ qty: currentPnQty[rowPn] }).eq('id', row.id)
          console.log('[shopify-orders] orders/updated: qty changed ->', order.name, rowPn, row.qty, '->', currentPnQty[rowPn])
        }
      }
      const existingPnSet = new Set((existingLineRows || []).map((r: any) => _canon(r.pn || '')))
      const newLineItems = currentLineItems.filter((li: any) => {
        const pn = li.sku ? li.sku.trim().toUpperCase() : (li.title || '').trim()
        return pn && _liQty(li) > 0 && !existingPnSet.has(_canon(pn))
      })
      if (newLineItems.length) {
        const shipAddr = order.shipping_address || {}
        const custName = (order.shipping_address?.name || order.billing_address?.name || (order.customer ? (order.customer.first_name||'')+' '+(order.customer.last_name||'') : '')).trim()
        const custEmail = order.email || order.customer?.email || ''
        for (const li of newLineItems) {
          const pn = li.sku ? li.sku.trim().toUpperCase() : (li.title || '').trim()
          const { error: insErr } = await db.from('sales').insert({
            order_number: order.name,
            pn,
            qty: _liQty(li),
            source: 'Shopify',
            fulfillment_status: 'Open',
            financial_status: order.financial_status || 'pending',
            sale_date: centralDateOnly(order.created_at),
            customer_name: custName || null,
            customer_email: custEmail || null,
            customer_phone: shipAddr.phone || order.customer?.phone || null,
            shipping_address1: shipAddr.address1 || null,
            shipping_address2: shipAddr.address2 || null,
            shipping_city: shipAddr.city || null,
            shipping_province: shipAddr.province_code || shipAddr.province || null,
            shipping_zip: shipAddr.zip || null,
            shipping_country: shipAddr.country_code || shipAddr.country || null,
            discount_code: (order.discount_codes && order.discount_codes.length ? order.discount_codes[0].code : null),
            shopify_order_id: String(order.id),
            shopify_line_item_id: String(li.id),
          })
          if (insErr) console.error('[shopify-orders] orders/updated: insert new line error:', insErr.message)
          else { console.log('[shopify-orders] orders/updated: new line added to existing order ->', order.name, pn); await dedupeSalesLine(order.name, pn) }
        }
      }

      // Some fraud apps finish their risk assessment a moment after order creation - checking
      // again here (idempotent, see checkOrderRisk) catches those without needing a dedicated
      // webhook topic.
      await checkOrderRisk(order.id, order.name)
      // [FEATURE] Some drop-ship vendors fulfill directly in Shopify (their own app or a manual
      // fulfillment) rather than ever passing through ShipStation. Those lines would otherwise
      // sit in Open/Ordered forever, since nothing ShipStation-side ever sees them ship.
      // Mirrors Shopify's own fulfillments array onto matching sales lines. Scoped to
      // drop-ship lines ONLY (no assemblies/parts record for that SKU) - a real inventory SKU
      // fulfilled this way still needs actual stock deduction, which this does not attempt, so
      // it deliberately leaves those alone rather than silently skipping a deduction.
      // Naturally idempotent: once a line is Shipped, the .in(['Open','Ordered']) filter below
      // stops matching it, so a redelivered webhook is a harmless no-op.
      if (Array.isArray(order.fulfillments) && order.fulfillments.length) {
        for (const f of order.fulfillments) {
          const trackingNum = f.tracking_number || null
          const trackingCo = f.tracking_company || null
          const items = Array.isArray(f.line_items) ? f.line_items : []
          for (const li of items) {
            const pn = li.sku ? li.sku.trim().toUpperCase() : (li.title || '').trim()
            if (!pn) continue
            // [SKU] new_sku-aware existence check, same pattern used elsewhere in this file -
            // a renamed real SKU must not be misclassified as drop-ship just because only its
            // legacy pn (or only its new_sku) was checked.
            let isRealItem = false
            const { data: asmPn } = await db.from('assemblies').select('id').eq('pn', pn).limit(1)
            if (asmPn?.length) isRealItem = true
            if (!isRealItem) { const { data: asmSku } = await db.from('assemblies').select('id').eq('new_sku', pn).limit(1); if (asmSku?.length) isRealItem = true }
            if (!isRealItem) { const { data: partPn } = await db.from('parts').select('id').eq('pn', pn).limit(1); if (partPn?.length) isRealItem = true }
            if (!isRealItem) { const { data: partSku } = await db.from('parts').select('id').eq('new_sku', pn).limit(1); if (partSku?.length) isRealItem = true }
            if (isRealItem) continue
            // shopify_fulfilled: true - same flag the ERP's manual "Mark Fulfilled via Shopify"
            // action sets, so a line fulfilled this way is always labeled the same regardless
            // of whether Jon or this automatic detection is the one that caught it.
            await db.from('sales').update({
              fulfillment_status: 'Shipped',
              shopify_fulfilled: true,
              tracking_number: trackingNum,
              carrier: trackingCo,
              shipped_at: f.created_at || new Date().toISOString()
            }).eq('order_number', order.name).eq('pn', pn).in('fulfillment_status', ['Open', 'Ordered'])
          }
        }
      }
    }
    if (body.action === 'create_refund') {
    // [AUDIT] This URL is public (Shopify must reach it), so a refund requires a signed-in ERP user's token.
    const _tok = (req.headers.get('Authorization') || '').replace('Bearer ', '')
    const _who = _tok ? await db.auth.getUser(_tok) : null
    if (!_who || _who.error || !_who.data || !_who.data.user) {
      return new Response(JSON.stringify({ error: 'Refund refused - not signed in to the ERP' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    const store = (body.store || Deno.env.get('SHOPIFY_STORE') || '').replace('https://', '').replace('http://', '')
    const key = body.key || Deno.env.get('SHOPIFY_KEY') || ''
    if (!store || !key) return new Response(JSON.stringify({error:'Missing Shopify credentials — set SHOPIFY_STORE and SHOPIFY_KEY in edge function secrets'}), {status:400, headers:{...CORS,'Content-Type':'application/json'}})
    const { orderName, shopifyOrderId, shopifyLineItemId, qty, amount, note } = body
    let orderId = shopifyOrderId
    let autoAmount = Number(amount) || 0
    if (!orderId || !autoAmount) {
      const lookupUrl = orderId
        ? 'https://' + store + '/admin/api/2024-01/orders/' + orderId + '.json?fields=id,line_items'
        : 'https://' + store + '/admin/api/2024-01/orders.json?name=' + encodeURIComponent(orderName) + '&fields=id,line_items&status=any&limit=1'
      const lookupRes = await fetch(lookupUrl, {headers:{'X-Shopify-Access-Token':key}})
      if (lookupRes.ok) {
        const ld = await lookupRes.json()
        const order = orderId ? ld : ld.orders?.[0]
        if (order) {
          if (!orderId) orderId = order.id
          if (!autoAmount) {
            const li = shopifyLineItemId
              ? (order.line_items || []).find((l: any) => String(l.id) === String(shopifyLineItemId))
              : (order.line_items || [])[0]
            if (li) autoAmount = parseFloat(li.price || '0') * (Number(qty) || 1)
          }
        }
      }
    }
    if (!orderId) return new Response(JSON.stringify({error:'Order not found in Shopify — check order number'}), {status:404, headers:{...CORS,'Content-Type':'application/json'}})
    const refundPayload: any = {
      refund: {
        notify: true,
        note: note || 'Return processed via TGK ERP',
        refund_line_items: shopifyLineItemId ? [{ line_item_id: Number(shopifyLineItemId), quantity: Number(qty) || 1, restock_type: 'no_restock' }] : [],
        transactions: autoAmount > 0 ? [{ kind: 'refund', gateway: 'manual', amount: autoAmount.toFixed(2), currency: 'USD' }] : []
      }
    }
    const refundRes = await fetch('https://' + store + '/admin/api/2024-01/orders/' + orderId + '/refunds.json', {
      method: 'POST', headers: {'X-Shopify-Access-Token': key, 'Content-Type': 'application/json'},
      body: JSON.stringify(refundPayload)
    })
    const refundData = await refundRes.json()
    if (!refundRes.ok) return new Response(JSON.stringify({error: JSON.stringify(refundData.errors || refundData)}), {status:502, headers:{...CORS,'Content-Type':'application/json'}})
    return new Response(JSON.stringify({refund_id: refundData.refund?.id, status:'created', amount: autoAmount}), {headers:{...CORS,'Content-Type':'application/json'}})
  }
} catch (err) {
    console.error('[shopify-orders] webhook error:', err)
  }
  return new Response('ok', { headers: CORS })
})

/* Migration needed before the risk-flagging feature works:
   ALTER TABLE sales ADD COLUMN IF NOT EXISTS risk_flagged boolean DEFAULT false;
   ALTER TABLE sales ADD COLUMN IF NOT EXISTS risk_level text;
*/
