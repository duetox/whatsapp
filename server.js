require('dotenv').config()

const express = require('express')
const path = require('path')
const pino = require('pino')
const QRCode = require('qrcode')
const { Pool } = require('pg')
const { Boom } = require('@hapi/boom')
const {
  default: makeWASocket,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  initAuthCreds
} = require('baileys')

const app = express()
const PORT = process.env.PORT || 3000
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`
const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) throw new Error('DATABASE_URL is required.')

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
})

let sock = null
let latestQr = null
let connectionState = 'disconnected'
let meJid = null
let connectingLock = false

const store = makeInMemoryStore({ logger })

const TABLE_SETUP_SQL = `
CREATE TABLE IF NOT EXISTS wa_auth_creds (
  id INTEGER PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS wa_auth_keys (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  data JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (kind, id)
);`

async function initDb() { await pool.query(TABLE_SETUP_SQL) }
async function readCreds() {
  const { rows } = await pool.query('SELECT data FROM wa_auth_creds WHERE id = 1 LIMIT 1')
  return rows[0]?.data || null
}
async function writeCreds(data) {
  await pool.query(
    `INSERT INTO wa_auth_creds (id, data, updated_at) VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [data]
  )
}

function createDbAuthState() {
  const state = { creds: null, keys: {
    get: async (type, ids) => {
      const out = {}
      for (const id of ids) {
        const { rows } = await pool.query('SELECT data FROM wa_auth_keys WHERE kind=$1 AND id=$2 LIMIT 1', [type, id])
        out[id] = rows[0]?.data || null
      }
      return out
    },
    set: async (data) => {
      for (const kind of Object.keys(data)) {
        for (const id of Object.keys(data[kind])) {
          const value = data[kind][id]
          if (value == null) {
            await pool.query('DELETE FROM wa_auth_keys WHERE kind=$1 AND id=$2', [kind, id])
          } else {
            await pool.query(`INSERT INTO wa_auth_keys (kind,id,data,updated_at) VALUES ($1,$2,$3,NOW())
              ON CONFLICT (kind,id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`, [kind, id, value])
          }
        }
      }
    }
  } }
  return { state, saveCreds: async () => writeCreds(state.creds) }
}

async function connectWhatsApp(force = false) {
  if (connectingLock && !force) return
  connectingLock = true
  try {
    connectionState = 'connecting'
    const { version } = await fetchLatestBaileysVersion()
    const { state, saveCreds } = createDbAuthState()
    state.creds = (await readCreds()) || initAuthCreds()

    sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: ['Heroku WA Advanced', 'Chrome', '1.0.0']
    })

    store.bind(sock.ev)
    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) latestQr = qr
      if (connection === 'open') {
        connectionState = 'connected'
        meJid = sock?.user?.id || null
        latestQr = null
        if (meJid) await sock.sendMessage(meJid, { text: 'Successfully CONNECTED 📈' })
      } else if (connection === 'close') {
        connectionState = 'disconnected'
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut
        if (shouldReconnect) setTimeout(() => connectWhatsApp().catch((e) => logger.error(e)), 2500)
      }
    })
  } finally {
    connectingLock = false
  }
}

app.use(express.json({ limit: '1mb' }))
app.use(express.static(path.join(__dirname, 'public')))

app.get('/api/status', (_req, res) => res.json({ ok: true, state: connectionState, meJid, hasQr: !!latestQr }))
app.get('/api/qr', async (_req, res) => {
  if (!latestQr) return res.status(404).json({ ok: false, error: 'QR not available. Click Reconnect and wait.' })
  res.json({ ok: true, qrDataUrl: await QRCode.toDataURL(latestQr) })
})
app.post('/api/pairing-code', async (req, res) => {
  try {
    const phoneNumber = String(req.body.phoneNumber || '').replace(/\D/g, '')
    if (phoneNumber.length < 10) return res.status(400).json({ ok: false, error: 'Enter valid number with country code.' })
    if (!sock) return res.status(500).json({ ok: false, error: 'Socket not ready. Retry in 5 sec.' })
    const code = await sock.requestPairingCode(phoneNumber)
    res.json({ ok: true, pairingCode: code })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.get('/api/chats', (_req, res) => {
  const chats = Object.values(store.chats || {}).slice(-50).reverse().map((c) => ({ id: c.id, name: c.name, unreadCount: c.unreadCount }))
  res.json({ ok: true, chats })
})
app.get('/api/messages/:jid', (req, res) => {
  const jid = req.params.jid
  const msgDict = store.messages?.[jid]?.array || []
  const messages = msgDict.slice(-40).map((m) => ({ key: m.key, text: m.message?.conversation || m.message?.extendedTextMessage?.text || '[non-text]' }))
  res.json({ ok: true, messages })
})

app.post('/api/send', async (req, res) => {
  try {
    const jid = String(req.body.jid || '').trim()
    const messageCode = String(req.body.messageCode || '').trim()
    if (!jid || !messageCode) return res.status(400).json({ ok: false, error: 'jid and messageCode required.' })
    if (!sock || connectionState !== 'connected') return res.status(400).json({ ok: false, error: 'WhatsApp not connected.' })
    const payload = new Function(`"use strict"; return (${messageCode});`)()
    if (!payload || typeof payload !== 'object') return res.status(400).json({ ok: false, error: 'messageCode must return object.' })
    const result = await sock.sendMessage(jid, payload)
    res.json({ ok: true, id: result?.key?.id })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/api/reconnect', async (_req, res) => {
  await connectWhatsApp(true)
  res.json({ ok: true })
})

app.listen(PORT, async () => {
  await initDb()
  await connectWhatsApp()
  logger.info(`Running on ${PUBLIC_URL}`)
})
