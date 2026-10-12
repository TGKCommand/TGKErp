import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const adminDb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS })

    const { data: { user }, error: authErr } = await adminDb.auth.getUser(authHeader.replace('Bearer ', ''))
    if (authErr || !user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS })

    const { data: profile } = await adminDb.from('profiles').select('role').eq('id', user.id).single()
    if (profile?.role !== 'admin') return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: CORS })

    const body = await req.json()
    const { action = 'invite' } = body

    if (action === 'invite') {
      const { email, role } = body
      if (!email || !role) return new Response(JSON.stringify({ error: 'email and role are required' }), { status: 400, headers: CORS })
      if (!['admin', 'warehouse', 'customer_service', 'design'].includes(role)) return new Response(JSON.stringify({ error: 'Invalid role' }), { status: 400, headers: CORS })

      const { redirectTo } = body
      const { data: linkData, error: linkErr } = await adminDb.auth.admin.generateLink({
        type: 'invite',
        email,
        options: redirectTo ? { redirectTo } : {}
      })
      if (linkErr) return new Response(JSON.stringify({ error: linkErr.message }), { status: 400, headers: CORS })

      const userId = linkData.user?.id
      if (userId) await adminDb.from('profiles').upsert({ id: userId, email, role, full_name: '' })
      const inviteLink = linkData.properties?.action_link || ''
      return new Response(JSON.stringify({ success: true, inviteLink }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (action === 'delete') {
      const { userId } = body
      if (!userId) return new Response(JSON.stringify({ error: 'userId required' }), { status: 400, headers: CORS })
      if (userId === user.id) return new Response(JSON.stringify({ error: 'Cannot delete your own account' }), { status: 400, headers: CORS })

      const { error: deleteErr } = await adminDb.auth.admin.deleteUser(userId)
      if (deleteErr) return new Response(JSON.stringify({ error: deleteErr.message }), { status: 400, headers: CORS })
      return new Response(JSON.stringify({ success: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: CORS })

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS })
  }
})