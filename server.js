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
  fetchLatestBaileysVersion
} = require('baileys')

const app = express()
const PORT = process.env.PORT || 3000
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`

const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required (Heroku Postgres URL).')
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
})

let sock = null
let latestQr = null
let connectionState = 'disconnected'
let meJid = null

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
);
`

async function initDb() {
  await pool.query(TABLE_SETUP_SQL)
}

async function readCreds() {
  const { rows } = await pool.query('SELECT data FROM wa_auth_creds WHERE id = 1 LIMIT 1')
  return rows[0]?.data || null
}

async function writeCreds(data) {
  await pool.query(
    `INSERT INTO wa_auth_creds (id, data, updated_at)
     VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [data]
  )
}

function createDbAuthState() {
  const state = {
    creds: null,
    keys: {
      get: async (type, ids) => {
        const result = {}
        for (const id of ids) {
          const { rows } = await pool.query(
            'SELECT data FROM wa_auth_keys WHERE kind = $1 AND id = $2 LIMIT 1',
            [type, id]
          )
          result[id] = rows[0]?.data || null
        }
        return result
      },
      set: async (data) => {
        for (const category of Object.keys(data)) {
          for (const id of Object.keys(data[category])) {
            const value = data[category][id]
            if (value === null) {
              await pool.query('DELETE FROM wa_auth_keys WHERE kind = $1 AND id = $2', [category, id])
            } else {
              await pool.query(
                `INSERT INTO wa_auth_keys (kind, id, data, updated_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (kind, id)
                 DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
                [category, id, value]
              )
            }
          }
        }
      }
    }
  }

  return {
    state,
    saveCreds: async () => writeCreds(state.creds)
  }
}

async function connectWhatsApp() {
  connectionState = 'connecting'

  const { version } = await fetchLatestBaileysVersion()
  const { state, saveCreds } = createDbAuthState()
  state.creds = (await readCreds()) || {}

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      latestQr = qr
    }

    if (connection === 'open') {
      connectionState = 'connected'
      meJid = sock?.user?.id || null
      latestQr = null

      if (meJid) {
        await sock.sendMessage(meJid, { text: 'Successfully CONNECTED 📈' })
      }

      logger.info({ meJid }, 'WhatsApp connected')
    } else if (connection === 'close') {
      connectionState = 'disconnected'
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      logger.warn({ statusCode, shouldReconnect }, 'WhatsApp connection closed')
      if (shouldReconnect) {
        setTimeout(() => connectWhatsApp().catch((err) => logger.error(err)), 3000)
      }
    } else if (connection === 'connecting') {
      connectionState = 'connecting'
    }
  })
}

app.use(express.json({ limit: '1mb' }))
app.use(express.static(path.join(__dirname, 'public')))

app.get('/api/status', async (_req, res) => {
  res.json({
    ok: true,
    state: connectionState,
    meJid,
    hasQr: Boolean(latestQr),
    publicUrl: PUBLIC_URL
  })
})

app.get('/api/qr', async (_req, res) => {
  if (!latestQr) return res.status(404).json({ ok: false, error: 'QR not available yet.' })
  const dataUrl = await QRCode.toDataURL(latestQr)
  res.json({ ok: true, qrDataUrl: dataUrl })
})

app.post('/api/pairing-code', async (req, res) => {
  try {
    const raw = String(req.body.phoneNumber || '').replace(/\D/g, '')
    if (!raw) return res.status(400).json({ ok: false, error: 'phoneNumber is required.' })
    if (!sock) return res.status(500).json({ ok: false, error: 'Socket is not ready yet.' })

    const code = await sock.requestPairingCode(raw)
    res.json({ ok: true, pairingCode: code })
  } catch (error) {
    logger.error(error)
    res.status(500).json({ ok: false, error: error.message })
  }
})

app.post('/api/send', async (req, res) => {
  try {
    const jid = String(req.body.jid || '').trim()
    const messageCode = String(req.body.messageCode || '').trim()

    if (!jid || !messageCode) {
      return res.status(400).json({ ok: false, error: 'jid and messageCode are required.' })
    }
    if (!sock) return res.status(500).json({ ok: false, error: 'WhatsApp is not initialized.' })

    const compiled = new Function(`"use strict"; return (${messageCode});`)
    const messagePayload = compiled()

    if (!messagePayload || typeof messagePayload !== 'object') {
      return res.status(400).json({ ok: false, error: 'messageCode must return a message object.' })
    }

    const result = await sock.sendMessage(jid, messagePayload)
    res.json({ ok: true, result })
  } catch (error) {
    logger.error(error)
    res.status(500).json({ ok: false, error: error.message })
  }
})

app.post('/api/reconnect', async (_req, res) => {
  try {
    await connectWhatsApp()
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message })
  }
})

app.listen(PORT, async () => {
  await initDb()
  await connectWhatsApp()
  logger.info(`Server running on ${PUBLIC_URL}`)
})
