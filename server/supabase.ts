import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types.js'
import { env } from './env.js'

let adminClient: ReturnType<typeof createClient<Database>> | undefined

export function getSupabaseAdmin() {
  if (!adminClient) {
    adminClient = createClient<Database>(env.supabaseUrl(), env.supabaseSecretKey(), {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    })
  }
  return adminClient
}
