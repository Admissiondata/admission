'use strict';

function createSupabaseClient({ url = process.env.SUPABASE_URL, key = process.env.SUPABASE_KEY, fetchImpl = fetch } = {}) {
  const baseUrl = String(url || '').trim().replace(/\/$/, '');
  const apiKey = String(key || '').trim();
  if (!baseUrl || !apiKey) throw new Error('SUPABASE_URL and SUPABASE_KEY are required');

  async function request(table, { method = 'GET', query = {}, body, prefer } = {}) {
    const search = new URLSearchParams(query);
    const endpoint = `${baseUrl}/rest/v1/${table}${search.size ? `?${search}` : ''}`;
    const headers = { apikey: apiKey, Authorization: `Bearer ${apiKey}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    const response = await fetchImpl(endpoint, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let result = null;
    if (text) {
      try { result = JSON.parse(text); }
      catch { result = text; }
    }
    if (!response.ok) {
      const message = result?.message || result?.error || result?.hint || `Supabase request failed (${response.status})`;
      const error = new Error(message);
      error.status = response.status;
      error.code = result?.code;
      throw error;
    }
    return result;
  }

  return {
    select: (table, query = {}) => request(table, { query }),
    insert: (table, rows) => request(table, { method: 'POST', body: rows, prefer: 'return=representation' }),
    upsert: (table, rows, onConflict) => request(table, {
      method: 'POST',
      query: { on_conflict: onConflict },
      body: rows,
      prefer: 'resolution=merge-duplicates,return=representation',
    }),
    update: (table, query, values) => request(table, {
      method: 'PATCH', query, body: values, prefer: 'return=representation',
    }),
    remove: (table, query) => request(table, { method: 'DELETE', query, prefer: 'return=representation' }),
    count: async (table) => {
      const search = new URLSearchParams({ select: 'id' });
      const response = await fetchImpl(`${baseUrl}/rest/v1/${table}?${search}`, {
        method: 'HEAD',
        headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}`, Prefer: 'count=exact' },
      });
      if (!response.ok) throw new Error(`Supabase count failed (${response.status})`);
      const contentRange = response.headers.get('content-range') || '';
      return Number(contentRange.split('/').at(-1));
    },
  };
}

module.exports = { createSupabaseClient };
