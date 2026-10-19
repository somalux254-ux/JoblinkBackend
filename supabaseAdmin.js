const { createClient } = require('@supabase/supabase-js');

let _adminClient = null;

function getAdminClient() {
  if (_adminClient) return _adminClient;
  const supabaseUrl = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || process.env.REACT_APP_SUPABASE_SERVICE_ROLE_KEY;

  const missingKeys = [];
  if (!supabaseUrl) missingKeys.push('SUPABASE_URL or REACT_APP_SUPABASE_URL');
  if (!supabaseServiceKey) missingKeys.push('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE');

  if (missingKeys.length > 0) {
    throw new Error(`Missing ${missingKeys.join(' and ')} environment variable(s)`);
  }

  _adminClient = createClient(supabaseUrl, supabaseServiceKey, {
    // server-side defaults: keep auth refresh disabled and avoid browser storage
    auth: { persistSession: false },
  });
  return _adminClient;
}

module.exports = { getAdminClient };
