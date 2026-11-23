import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import {
  all,
  get,
  upsertWhatsAppMessage,
} from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSIONS_DIR = path.resolve(__dirname, '../../data/whatsapp-sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// In-memory registry of active sessions
const activeSessions = new Map();

/**
 * Extracts plain text from various Baileys message structures
 */
function extractMessageText(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.templateButtonReplyMessage?.selectedId ||
    message.buttonsResponseMessage?.selectedButtonId ||
    ''
  );
}

/**
 * Cleans WhatsApp JID into international phone number format
 */
function jidToPhoneNumber(jid = '') {
  const num = (String(jid).split('@')[0] || '').split(':')[0] || '';
  const clean = num.replace(/\D/g, '');
  if (!clean) return '';
  return clean.startsWith('91') && clean.length === 12 ? `+${clean}` : `+${clean}`;
}

/**
 * Returns connection and auth status for all executives
 */
export function getWhatsAppSessionsStatus() {
  const executives = all(`
    SELECT u.id, u.name, u.email, u.role, d.employee_phone AS work_phone
    FROM users u
    LEFT JOIN devices d ON d.user_id = u.id
    ORDER BY u.rowid ASC
  `);

  const byId = new Map();

  for (const exec of executives) {
    const session = activeSessions.get(exec.id) || {
      status: 'disconnected',
      phone: null,
      qr: null,
      updatedAt: null,
    };
    const credsPath = path.join(SESSIONS_DIR, exec.id, 'creds.json');
    const hasSavedAuth = fs.existsSync(credsPath);

    byId.set(exec.id, {
      executiveId: exec.id,
      executiveName: exec.name,
      executiveEmail: exec.email,
      status: session.status,
      phone: session.phone || exec.work_phone || null,
      qr: session.qr,
      hasSavedAuth,
      updatedAt: session.updatedAt,
    });
  }

  // Also include any active in-memory sessions not present in `users` table
  for (const [execId, session] of activeSessions.entries()) {
    if (byId.has(execId)) continue;
    const credsPath = path.join(SESSIONS_DIR, execId, 'creds.json');
    byId.set(execId, {
      executiveId: execId,
      executiveName: session.phone || session.executiveName || execId,
      executiveEmail: '',
      status: session.status,
      phone: session.phone || null,
      qr: session.qr,
      hasSavedAuth: fs.existsSync(credsPath),
      updatedAt: session.updatedAt,
    });
  }

  // Also include any saved session folders on disk not yet in `byId`
  if (fs.existsSync(SESSIONS_DIR)) {
    try {
      const dirs = fs.readdirSync(SESSIONS_DIR);
      for (const execId of dirs) {
        if (byId.has(execId)) continue;
        const credsPath = path.join(SESSIONS_DIR, execId, 'creds.json');
        if (!fs.existsSync(credsPath)) continue;
        let savedPhone = null;
        let savedName = '';
        try {
          const parsed = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
          savedPhone = jidToPhoneNumber(parsed?.me?.id || '') || null;
          savedName = String(parsed?.me?.name || '').trim();
        } catch {}
        byId.set(execId, {
          executiveId: execId,
          executiveName: savedPhone || savedName || execId,
          executiveEmail: '',
          status: 'disconnected',
          phone: savedPhone,
          qr: null,
          hasSavedAuth: true,
          updatedAt: null,
        });
      }
    } catch {}
  }

  return Array.from(byId.values());
}

/**
 * Starts or retrieves WhatsApp session for a specific executive
 */
export async function startExecutiveWhatsAppSession(executiveId, { sendEvent = () => {} } = {}) {
  const user = get('SELECT id, name, email FROM users WHERE id = ?', [executiveId]);
  const device = get('SELECT employee_phone FROM devices WHERE user_id = ? LIMIT 1', [executiveId]);
  const sessionPath = path.join(SESSIONS_DIR, executiveId);
  const credsPath = path.join(sessionPath, 'creds.json');

  let savedWaPhone = '';
  let savedWaName = '';
  if (fs.existsSync(credsPath)) {
    try {
      const parsedCreds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      savedWaPhone = jidToPhoneNumber(parsedCreds?.me?.id || '');
      savedWaName = String(parsedCreds?.me?.name || '').trim();
    } catch {}
  }

  const workPhone = savedWaPhone || device?.employee_phone || '';
  let executiveName = workPhone || user?.name || savedWaName || executiveId || 'Sales Executive';

  // Return existing active session if already connected or waiting for QR
  const current = activeSessions.get(executiveId);
  if (current && (current.status === 'connected' || current.status === 'qr_ready')) {
    return {
      executiveId,
      executiveName: current.phone || current.executiveName || executiveName,
      status: current.status,
      qr: current.qr,
      phone: current.phone,
    };
  }

  if (fs.existsSync(credsPath)) {
    try {
      const raw = fs.readFileSync(credsPath, 'utf8').trim();
      if (!raw) throw new Error('Empty creds.json');
      JSON.parse(raw);
    } catch {
      console.warn(`[WhatsApp Bridge] Corrupted creds.json detected for ${executiveId}. Resetting session folder.`);
      try {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      } catch {}
    }
  }
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  const sessionState = {
    executiveId,
    executiveName,
    status: 'connecting',
    qr: null,
    phone: workPhone || null,
    socket: null,
    updatedAt: new Date().toISOString(),
  };
  activeSessions.set(executiveId, sessionState);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    // Minimal silent logger to prevent terminal noise
    const silentLogger = {
      level: 'silent',
      child: () => silentLogger,
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    };

    const syncHistory = process.env.WHATSAPP_SYNC_HISTORY !== 'false';
    const sock = makeWASocket({
      auth: state,
      browser: ['Climeto Cockpit', 'Chrome', '1.0.0'],
      printQRInTerminal: false,
      logger: silentLogger,
      syncFullHistory: syncHistory,
      generateHighQualityLinkPreview: false,
    });

    sessionState.socket = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
          sessionState.status = 'qr_ready';
          sessionState.qr = qrDataUrl;
          sessionState.updatedAt = new Date().toISOString();

          sendEvent('whatsapp.session_updated', {
            executiveId,
            executiveName,
            status: 'qr_ready',
            qr: qrDataUrl,
          });
        } catch (err) {
          console.error('[WhatsApp Bridge] QR generation error:', err.message);
        }
      }

      if (connection === 'open') {
        const phone = jidToPhoneNumber(sock.user?.id || '');
        sessionState.status = 'connected';
        sessionState.qr = null;
        sessionState.phone = phone;
        sessionState.updatedAt = new Date().toISOString();

        console.log(`[WhatsApp Bridge] Multi-Device session connected for ${executiveName} (${phone})`);

        sendEvent('whatsapp.session_updated', {
          executiveId,
          executiveName,
          status: 'connected',
          phone,
        });
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        sessionState.status = shouldReconnect ? 'connecting' : 'disconnected';
        sessionState.qr = null;
        sessionState.updatedAt = new Date().toISOString();

        sendEvent('whatsapp.session_updated', {
          executiveId,
          executiveName,
          status: sessionState.status,
          reason: statusCode,
        });

        if (shouldReconnect) {
          const delayMs = isRestartRequired ? 500 : 3000;
          console.log(`[WhatsApp Bridge] Reconnecting session for ${executiveName} (code ${statusCode || 'unknown'}) in ${delayMs}ms...`);
          // Delete old entry so startExecutiveWhatsAppSession creates a fresh socket
          activeSessions.delete(executiveId);
          setTimeout(() => {
            startExecutiveWhatsAppSession(executiveId, { sendEvent }).catch(() => {});
          }, delayMs);
        } else {
          console.log(`[WhatsApp Bridge] Session logged out for ${executiveName}. Clearing credentials.`);
          try {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          } catch {}
          activeSessions.delete(executiveId);
        }
      }
    });

    function ingestBaileysMessage(msg, contactNameMap = new Map()) {
      if (!msg?.message || msg.key?.remoteJid === 'status@broadcast') return null;

      let remoteJid = msg.key?.remoteJid || '';
      if (
        remoteJid.endsWith('@g.us') ||
        remoteJid.endsWith('@broadcast') ||
        remoteJid.endsWith('@newsletter')
      ) {
        return null; // Ignore groups, status broadcasts, and WhatsApp Channels/Newsletters
      }
      if (remoteJid.endsWith('@lid')) {
        if (msg.key?.remoteJidAlt && msg.key.remoteJidAlt.endsWith('@s.whatsapp.net')) {
          remoteJid = msg.key.remoteJidAlt;
        } else {
          // Resolve LID using Baileys reverse mapping file (lid-mapping-<lid>_reverse.json)
          const lidDigits = (remoteJid.split('@')[0] || '').split(':')[0].replace(/\D/g, '');
          const reversePath = lidDigits ? path.join(sessionPath, `lid-mapping-${lidDigits}_reverse.json`) : '';
          let mappedPhone = '';
          if (reversePath && fs.existsSync(reversePath)) {
            try {
              const raw = JSON.parse(fs.readFileSync(reversePath, 'utf8'));
              mappedPhone = String(raw || '').replace(/\D/g, '');
            } catch {}
          }
          if (mappedPhone && mappedPhone.length >= 10 && mappedPhone.length <= 15) {
            remoteJid = `${mappedPhone}@s.whatsapp.net`;
          } else {
            return null; // Ignore unresolvable internal WhatsApp LIDs without a phone number
          }
        }
      }
      if (!remoteJid.endsWith('@s.whatsapp.net')) {
        return null;
      }

      const clientPhone = jidToPhoneNumber(remoteJid);
      const rawDigits = clientPhone.replace(/\D/g, '');
      // Valid international E.164 phone numbers are 10 to 15 digits (blocks 18-digit channel IDs like 120363...)
      if (!clientPhone || rawDigits.length < 10 || rawDigits.length > 15) return null;

      // Match against existing leads in Climeto CRM
      const digits = clientPhone.replace(/\D/g, '').slice(-10);
      const matchedLead = get('SELECT * FROM leads WHERE client_phone LIKE ? LIMIT 1', [`%${digits}`]);

      // Company Work SIM mode: capture all 1-on-1 business chats by default
      const captureAll = process.env.WHATSAPP_CAPTURE_ALL !== 'false';
      if (!matchedLead && !captureAll) {
        return null;
      }

      const messageText = extractMessageText(msg.message);
      if (!messageText) return null;

      const isFromMe = Boolean(msg.key?.fromMe);
      const direction = isFromMe ? 'outgoing' : 'incoming';
      const rawTs = msg.messageTimestamp;
      const numericTs = typeof rawTs === 'object' && rawTs !== null ? Number(rawTs.low || rawTs) : Number(rawTs);
      const msgTimestamp = numericTs
        ? new Date(numericTs * 1000).toISOString()
        : new Date().toISOString();

      const externalId = msg.key?.id || `wa-${clientPhone}-${Date.now()}`;
      const pushName = !isFromMe && msg.pushName ? String(msg.pushName).trim() : '';
      const contactName = contactNameMap.get(remoteJid) || contactNameMap.get(msg.key?.remoteJid) || '';

      const latestUser = get('SELECT name FROM users WHERE id = ?', [executiveId]);
      const resolvedExecName = latestUser?.name || sessionState.phone || executiveName;

      return upsertWhatsAppMessage({
        externalId,
        deviceId: `server-bridge-${executiveId}`,
        ownerId: executiveId,
        leadId: matchedLead?.id || null,
        executiveName: resolvedExecName,
        clientName: matchedLead?.client_name || contactName || pushName || clientPhone,
        clientPhone,
        direction,
        message: messageText,
        timestamp: msgTimestamp,
        status: direction === 'incoming' ? 'received' : 'sent',
      });
    }

    // Sync historical / previous chats sent by WhatsApp right after linking
    sock.ev.on('messaging-history.set', ({ messages = [], contacts = [] }) => {
      try {
        const contactNameMap = new Map();
        for (const c of contacts) {
          const name = c.name || c.notify || c.verifiedName || '';
          if (c.id && name) contactNameMap.set(c.id, name);
        }

        const historyLimit = Math.max(Number(process.env.WHATSAPP_HISTORY_LIMIT || 250), 10);
        // Sort newest first and take latest N messages so DB stays fast
        const sorted = [...messages].sort((a, b) => {
          const ta = Number(a.messageTimestamp?.low ?? a.messageTimestamp ?? 0);
          const tb = Number(b.messageTimestamp?.low ?? b.messageTimestamp ?? 0);
          return tb - ta;
        });

        let syncedCount = 0;
        let lastSaved = null;
        for (const msg of sorted) {
          if (syncedCount >= historyLimit) break;
          const saved = ingestBaileysMessage(msg, contactNameMap);
          if (saved) {
            syncedCount += 1;
            lastSaved = saved;
          }
        }

        if (syncedCount > 0) {
          console.log(`[WhatsApp Bridge] Synced ${syncedCount} historical messages for ${executiveName}.`);
          sendEvent('whatsapp.received', {
            id: lastSaved?.id,
            lead_id: lastSaved?.lead_id,
            client_name: `${syncedCount} past messages synced (${executiveName})`,
            client_phone: lastSaved?.client_phone,
            executive_name: executiveName,
            direction: 'incoming',
            message: `Synced ${syncedCount} historical chats from WhatsApp`,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.error('[WhatsApp Bridge] Error syncing historical chats:', err.message);
      }
    });

    // Handle live incoming and outgoing messages
    sock.ev.on('messages.upsert', async (m) => {
      try {
        const type = m.type;
        if (type !== 'notify' && type !== 'append') return;

        for (const msg of m.messages) {
          const saved = ingestBaileysMessage(msg);
          if (!saved) continue;

          sendEvent('whatsapp.received', {
            id: saved.id,
            lead_id: saved.lead_id,
            client_name: saved.client_name,
            client_phone: saved.client_phone,
            executive_name: saved.executive_name,
            direction: saved.direction,
            message: saved.message,
            timestamp: saved.timestamp,
          });
        }
      } catch (err) {
        console.error('[WhatsApp Bridge] Error processing incoming message:', err.message);
      }
    });

    return {
      executiveId,
      executiveName,
      status: sessionState.status,
      qr: sessionState.qr,
      phone: sessionState.phone,
    };
  } catch (err) {
    sessionState.status = 'error';
    sessionState.error = err.message;
    throw err;
  }
}

/**
 * Disconnects and logs out an executive session
 */
export async function disconnectExecutiveWhatsAppSession(executiveId, { sendEvent = () => {} } = {}) {
  const current = activeSessions.get(executiveId);
  if (current?.socket) {
    try {
      await current.socket.logout();
    } catch {
      try {
        current.socket.end();
      } catch {}
    }
  }

  const sessionPath = path.join(SESSIONS_DIR, executiveId);
  try {
    fs.rmSync(sessionPath, { recursive: true, force: true });
  } catch {}

  activeSessions.delete(executiveId);

  sendEvent('whatsapp.session_updated', {
    executiveId,
    status: 'disconnected',
  });

  return { ok: true, executiveId, status: 'disconnected' };
}

/**
 * Boots saved sessions on server startup
 */
export async function autoResumeWhatsAppSessions({ sendEvent = () => {} } = {}) {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const dirs = fs.readdirSync(SESSIONS_DIR);

    for (const execId of dirs) {
      const credsPath = path.join(SESSIONS_DIR, execId, 'creds.json');
      if (fs.existsSync(credsPath)) {
        console.log(`[WhatsApp Bridge] Auto-resuming saved session for executive: ${execId}`);
        startExecutiveWhatsAppSession(execId, { sendEvent }).catch((err) => {
          console.warn(`[WhatsApp Bridge] Failed to resume session ${execId}:`, err.message);
        });
      }
    }
  } catch (err) {
    console.warn('[WhatsApp Bridge] Notice during autoResumeWhatsAppSessions:', err.message);
  }
}

