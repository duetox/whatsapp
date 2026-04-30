async function j(url, opts) {
  const r = await fetch(url, opts)
  return r.json()
}

async function refresh() {
  const status = await j('/api/status')
  document.getElementById('status').textContent = `State: ${status.state} | Me: ${status.meJid || 'N/A'}`

  if (status.hasQr) {
    const qr = await j('/api/qr')
    if (qr.ok) document.getElementById('qr').src = qr.qrDataUrl
  }
}

document.getElementById('refresh').onclick = refresh

document.getElementById('reconnect').onclick = async () => {
  await j('/api/reconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
  await refresh()
}

document.getElementById('pairBtn').onclick = async () => {
  const phoneNumber = document.getElementById('phone').value
  const out = await j('/api/pairing-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber })
  })
  document.getElementById('pairResult').textContent = out.ok ? `Pairing code: ${out.pairingCode}` : out.error
}

document.getElementById('sendBtn').onclick = async () => {
  const jid = document.getElementById('jid').value
  const messageCode = document.getElementById('messageCode').value
  const out = await j('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jid, messageCode })
  })
  document.getElementById('sendResult').textContent = JSON.stringify(out, null, 2)
}

refresh()
setInterval(refresh, 8000)
