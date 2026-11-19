import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const { Pool } = pg;

function toText(value, fallback = '') {
  if (value == null) return fallback;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toIsoString(value) {
  if (!value) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function nextActionFromRow(row) {
  if (row.action_items) {
    const raw = row.action_items;
    let items = raw;
    if (typeof raw === 'string') {
      try {
        items = JSON.parse(raw);
      } catch {
        items = raw;
      }
    }

    if (Array.isArray(items)) {
      const tasks = items
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object') return item.task || item.text || item.what || '';
          return '';
        })
        .filter(Boolean);

      if (tasks.length) return tasks.slice(0, 2).join(' | ');
    }

    return toText(raw, 'Follow up on completed call');
  }
  return 'Follow up on completed call';
}

function mapSupabaseRowToWorkspaceCall(row) {
  return {
    id: row.id,
    userId: row.executive_id || undefined,
    deviceId: row.device_id || undefined,
    executiveName: row.employee_name || 'Unknown Executive',
    clientName: row.client_name || row.client_phone || 'Unknown Client',
    clientPhone: row.client_phone || '',
    durationSeconds: row.duration_seconds || 0,
    createdAt: toIsoString(row.created_at),
    direction: 'Outgoing',
    status: 'completed',
    sentiment: 'Neutral',
    summary: row.summary || 'Completed call received from Supabase. Summary pending.',
    promise: 'Pending follow-up',
    nextAction: nextActionFromRow(row),
    transcript: row.transcript || 'Transcript pending.',
  };
}

export function createSupabaseBridge({ upsertCall, notifyNewCall } = {}) {
  const enabled = process.env.SUPABASE_BRIDGE_ENABLED === 'true';
  const connectionString =
    process.env.SUPABASE_BRIDGE_DATABASE_URL || process.env.DATABASE_URL || '';
  const pollMs = Number(process.env.SUPABASE_BRIDGE_POLL_MS || 1000);
  const limit = Number(process.env.SUPABASE_BRIDGE_LIMIT || 15);
  const projectUrl = process.env.SUPABASE_PROJECT_URL || '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!enabled || !connectionString) {
    return {
      enabled: false,
      async start() {
        return false;
      },
      async stop() {},
    };
  }

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 1,
  });
  pool.on('error', (error) => {
    console.error('Supabase bridge pool error:', error.message || error);
  });
  const hasRealtimeCredentials = Boolean(projectUrl && serviceRoleKey);
  const supabase = hasRealtimeCredentials
    ? createClient(projectUrl, serviceRoleKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      })
    : null;

  const seenCalls = new Map();
  let timer = null;
  let bootstrapped = false;
  let polling = false;
  let realtimeChannel = null;

  async function syncRow(row, { notifyIfNew = false } = {}) {
    const signature = `${row.id}:${row.updated_at || row.created_at}:${row.summary || ''}:${row.transcript || ''}`;
    const isNew = !seenCalls.has(row.id);
    const hasChanged = seenCalls.get(row.id) !== signature;

    if (!hasChanged) return null;

    const call = await upsertCall?.(mapSupabaseRowToWorkspaceCall(row));
    seenCalls.set(row.id, signature);

    if (bootstrapped && notifyIfNew && isNew && call) {
      notifyNewCall?.(call);
    }

    return call;
  }

  async function pollOnce() {
    if (polling) return;
    polling = true;

    try {
      const { rows } = await pool.query(
        `SELECT
          id,
          executive_id,
          device_id,
          employee_name,
          client_name,
          client_phone,
          duration_seconds,
          status,
          summary,
          transcript,
          action_items,
          created_at,
          updated_at
         FROM calls
         WHERE status = 'completed'
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit],
      );

      if (!bootstrapped) {
        console.log(`Supabase bridge fetched ${rows.length} completed calls on bootstrap.`);
      }

      const orderedRows = [...rows].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );

      for (const row of orderedRows) {
        await syncRow(row, { notifyIfNew: true });
      }

      if (!bootstrapped) {
        console.log(`Supabase bridge bootstrapped ${orderedRows.length} calls into local workspace.`);
      }

      bootstrapped = true;
    } catch (error) {
      console.error('Supabase bridge poll failed:', error.message || error);
    } finally {
      polling = false;
    }
  }

  async function startRealtime() {
    if (!supabase) return false;

    realtimeChannel = supabase
      .channel('workspace-live-calls')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'calls' },
        async (payload) => {
          if (payload.new?.status !== 'completed') return;
          await syncRow(payload.new, { notifyIfNew: true });
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'calls' },
        async (payload) => {
          if (payload.new?.status !== 'completed') return;
          await syncRow(payload.new, { notifyIfNew: true });
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('Supabase bridge realtime subscription active.');
        }
      });

    return true;
  }

  return {
    enabled: true,
    async start() {
      await pollOnce();

      if (hasRealtimeCredentials) {
        console.log('Supabase bridge starting in realtime subscription mode.');
        await startRealtime();
      } else {
        console.log(`Supabase realtime credentials missing, using ${pollMs}ms polling fallback.`);
        timer = setInterval(() => {
          void pollOnce();
        }, pollMs);
      }

      return true;
    },
    async stop() {
      if (timer) clearInterval(timer);
      if (realtimeChannel) {
        await supabase.removeChannel(realtimeChannel);
      }
      await pool.end();
    },
  };
}
