import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Lazily-instantiated Supabase client using the service-role key.
 *
 * This runs only on the server (inside API routes), so the service-role key
 * never reaches the browser. We disable session persistence/refresh because
 * there is no end-user auth context here — every call is a trusted server call.
 */
let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables"
    );
  }

  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return client;
}
