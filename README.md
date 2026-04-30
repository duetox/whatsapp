# Advanced WhatsApp (Baileys) for Heroku

Features:
- QR linking + Pairing code linking
- Stylish web dashboard
- Send raw message object to any JID using JS object code
- Auth state persisted in Postgres (Heroku Postgres)
- On successful link, bot sends itself: `Successfully CONNECTED 📈`

## Deploy to Heroku
1. Create Heroku app.
2. Add Heroku Postgres addon.
3. Set config vars if needed (`LOG_LEVEL`, `PUBLIC_URL`).
4. Deploy this repository.
5. Open app URL and link via QR or pairing code.

## Usage
- Send message panel accepts message JS object, e.g.:
  ```js
  ({ text: "Hello from dashboard" })
  ```
- JID examples:
  - `1234567890@s.whatsapp.net`
  - `1203630XXXXXXX@g.us`

## Security Note
`/api/send` evaluates message object code from the dashboard using `new Function`. Do not expose this app publicly without access controls.
