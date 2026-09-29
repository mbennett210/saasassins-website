// Supabase client for the connected-inbox backend. Built with the service-role
// key, which bypasses RLS — this module must only ever run server-side.

import { createClient } from '@supabase/supabase-js';

let cached = null;

export function getSupabase() {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  }
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}
