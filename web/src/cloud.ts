// Cloud mode: the app is served from GitHub Pages and talks to the Supabase API with your signed-in session.
// Local mode (no VITE_SUPABASE_URL at build time): the Mac's Flask server, unlocked with the PIN, as before.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const cloud = !!(URL_ && KEY)
export const API_BASE = cloud ? `${URL_}/functions/v1` : ''
export const supabase: SupabaseClient | null = cloud
  // detectSessionInUrl: the emailed sign-in link lands back here and signs you in
  ? createClient(URL_!, KEY!, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null

/** Current access token (refreshed automatically), or null when signed out. */
export async function accessToken(): Promise<string | null> {
  if (!supabase) return null
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

export async function signOut() {
  if (supabase) { await supabase.auth.signOut(); window.location.reload() } else window.location.href = '/logout'
}
