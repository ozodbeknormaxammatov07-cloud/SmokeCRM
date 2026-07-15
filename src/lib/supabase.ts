import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js'

/**
 * Cloud backup client. Optional by design: with no credentials configured the app runs
 * exactly as it always has — local-only, offline, IndexedDB as the source of truth. The
 * cloud is a replica, never the master, so nothing here is on the critical path of a sale.
 *
 * The publishable key is safe in the bundle: it grants no access on its own. Row-level
 * security is what protects the data — every table is restricted to `user_id = auth.uid()`.
 */
// These fall back to the shop's Supabase project when no build-time env var is set. Both are
// safe to ship in the browser bundle by design (see .env.example): the publishable key grants
// no access on its own — row-level security is what protects the data. Setting the matching
// VITE_* env var in the host overrides these.
const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)
  ?? 'https://oxjljygjcdbndunnkrzo.supabase.co'
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)
  ?? 'sb_publishable_yzQPh820AgXLrb8uC9uyzw_JyVXaeKN'

export const cloudConfigured = Boolean(url && key)

export const supabase: SupabaseClient | null = cloudConfigured
  ? createClient(url!, key!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  : null

export type { Session }

export async function currentSession(): Promise<Session | null> {
  if (!supabase) return null
  const { data } = await supabase.auth.getSession()
  return data.session
}

export async function signIn(email: string, password: string): Promise<void> {
  if (!supabase) throw new Error('Bulut sozlanmagan')
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw new Error(translateAuthError(error.message))
}

export async function signUp(email: string, password: string): Promise<{ needsConfirmation: boolean }> {
  if (!supabase) throw new Error('Bulut sozlanmagan')
  const { data, error } = await supabase.auth.signUp({ email, password })
  if (error) throw new Error(translateAuthError(error.message))
  // With email confirmation on, Supabase returns a user but no session until they click.
  return { needsConfirmation: !data.session }
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut()
}

/** Supabase speaks English; the shop does not. */
function translateAuthError(msg: string): string {
  const m = msg.toLowerCase()
  if (m.includes('invalid login credentials')) return "Email yoki parol noto'g'ri"
  if (m.includes('email not confirmed')) return 'Emailingizni tasdiqlang — pochtangizga xat yuborildi'
  if (m.includes('user already registered')) return "Bu email allaqachon ro'yxatdan o'tgan — kiring"
  if (m.includes('password should be at least')) return "Parol kamida 6 ta belgidan iborat bo'lsin"
  if (m.includes('unable to validate email')) return "Email manzili noto'g'ri"
  if (m.includes('fetch') || m.includes('network')) return 'Internet yo\'q — keyinroq urinib ko\'ring'
  return msg
}
