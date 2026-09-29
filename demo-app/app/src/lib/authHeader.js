// Builds the Authorization header for admin API calls from the current Supabase
// session. Returns {} in local mode (no Supabase) so stub/offline calls are
// unaffected. The backend's requireAuth() validates the token.
import { supabase } from './supabaseClient.js';

export async function authHeaders() {
  if (!supabase) return {};
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}
