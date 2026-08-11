import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { AccessToken } from 'livekit-server-sdk'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const port = Number(process.env.PORT || 8080)

app.use(express.json({ limit: '32kb' }))

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, service: 'airix-video-demo' })
})

app.post('/api/token', async (request, response) => {
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET
  const livekitUrl =
    process.env.PUBLIC_LIVEKIT_URL || 'wss://meet.theairix.com/api/livekit'

  if (!apiKey || !apiSecret) {
    response.status(500).json({
      code: 'livekit_not_configured',
      message: 'LiveKit credentials are not configured.',
    })
    return
  }

  const roomId = normalizeRoomId(request.body?.roomId)
  const displayName = normalizeDisplayName(request.body?.displayName)
  const participantId =
    normalizeParticipantId(request.body?.participantId) ||
    `guest-${crypto.randomUUID()}`

  if (!roomId) {
    response.status(400).json({
      code: 'invalid_room',
      message: 'A valid roomId is required.',
    })
    return
  }

  const token = new AccessToken(apiKey, apiSecret, {
    identity: participantId,
    name: displayName,
    ttl: '2h',
  })

  token.addGrant({
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
    room: roomId,
    roomJoin: true,
  })

  const jwt = await token.toJwt()
  response.json({
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    livekitUrl,
    participantId,
    roomId,
    token: jwt,
  })
})

const distPath = path.resolve(__dirname, '../dist')
app.use(express.static(distPath))
app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(distPath, 'index.html'))
})

app.listen(port, () => {
  console.log(`AIRIX video demo listening on ${port}`)
})

function normalizeRoomId(value) {
  if (typeof value !== 'string') {
    return ''
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

function normalizeDisplayName(value) {
  if (typeof value !== 'string') {
    return 'Guest'
  }

  return value.trim().replace(/\s+/g, ' ').slice(0, 48) || 'Guest'
}

function normalizeParticipantId(value) {
  if (typeof value !== 'string') {
    return ''
  }

  return value.trim().replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80)
}
