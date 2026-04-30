# WhatsApp Advanced Control (Heroku + Baileys + Postgres)

## Fixed build
This version fixes connection/pairing issues and properly initializes Baileys auth creds for first login.

## Features
- QR login + pairing code login
- Recent chats list
- Recent messages by JID
- Advanced JID sender (JS message object)
- Postgres auth persistence
- Sends `Successfully CONNECTED 📈` to linked account on successful connect

## Deploy (Heroku)
1. Create app
2. Add Heroku Postgres
3. Deploy repo
4. Open app and link device

## Required env
- `DATABASE_URL` (auto via Heroku Postgres)
- `NODE_ENV=production`
- `LOG_LEVEL=info`
