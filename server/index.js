import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { AccessToken, WebhookReceiver } from 'livekit-server-sdk'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const port = Number(process.env.PORT || 8080)
const roomConsumers = new Map()

app.use(
  express.json({
    limit: '64kb',
    verify: (request, _response, buffer) => {
      request.rawBody = buffer.toString('utf8')
    },
  }),
)

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, service: 'airix-video-demo' })
})

app.get('/api/v1/me', requireApiKey, (request, response) => {
  response.json({
    id: request.airixConsumer.id,
    name: request.airixConsumer.name,
    webhookConfigured: Boolean(request.airixConsumer.webhookUrl),
  })
})

app.post('/api/v1/rooms', requireApiKey, async (request, response) => {
  const roomId = normalizeRoomId(request.body?.roomId) || createRoomId()
  const mode = normalizeMode(request.body?.mode)
  const metadata = normalizeMetadata(request.body?.metadata)
  const joinUrl = `${getPublicDemoUrl()}/${roomId}`

  const room = {
    createdAt: new Date().toISOString(),
    joinUrl,
    metadata,
    mode,
    roomId,
  }

  rememberRoomConsumer(roomId, request.airixConsumer)
  response.status(201).json(room)

  void emitConsumerWebhook(request.airixConsumer, 'room.created', {
    consumerId: request.airixConsumer.id,
    room,
  })
})

app.post('/api/v1/rooms/:roomId/tokens', requireApiKey, async (request, response) => {
  const roomId = normalizeRoomId(request.params.roomId)
  const mode = normalizeMode(request.body?.mode)
  const displayName = normalizeDisplayName(request.body?.displayName)
  const participantId =
    normalizeParticipantId(request.body?.participantId) ||
    `guest-${crypto.randomUUID()}`
  const role = normalizeRole(request.body?.role)
  const metadata = normalizeMetadata(request.body?.metadata)

  if (!roomId) {
    response.status(400).json({
      code: 'invalid_room',
      message: 'A valid roomId is required.',
    })
    return
  }

  try {
    const joinToken = await createJoinToken({
      displayName,
      metadata: {
        ...metadata,
        airixConsumerId: request.airixConsumer.id,
        mode,
        role,
      },
      participantId,
      role,
      roomId,
    })

    rememberRoomConsumer(roomId, request.airixConsumer)
    response.json(joinToken)

    void emitConsumerWebhook(request.airixConsumer, 'participant.token_created', {
      consumerId: request.airixConsumer.id,
      participant: {
        displayName,
        participantId,
        role,
      },
      room: {
        joinUrl: `${getPublicDemoUrl()}/${roomId}`,
        mode,
        roomId,
      },
    })
  } catch (error) {
    response.status(500).json({
      code: 'token_creation_failed',
      message:
        error instanceof Error
          ? error.message
          : 'Unable to create participant token.',
    })
  }
})

app.post('/api/internal/livekit-webhook', async (request, response) => {
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET

  if (!apiKey || !apiSecret) {
    response.status(500).json({ ok: false })
    return
  }

  try {
    const receiver = new WebhookReceiver(apiKey, apiSecret)
    const event = await receiver.receive(
      request.rawBody || JSON.stringify(request.body),
      request.get('authorization'),
    )

    console.log(
      JSON.stringify({
        event: 'livekit.webhook.received',
        livekitEvent: event.event,
        participantId: event.participant?.identity,
        roomId: event.room?.name,
      }),
    )

    const roomId = normalizeRoomId(event.room?.name)
    const consumer = roomId ? roomConsumers.get(roomId) : null
    if (consumer) {
      void emitConsumerWebhook(consumer, `livekit.${event.event}`, {
        livekit: serializeLiveKitEvent(event),
      })
    }

    response.json({ ok: true })
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'invalid webhook',
        event: 'livekit.webhook.invalid',
      }),
    )
    response.status(401).json({ ok: false })
  }
})

app.post('/api/token', async (request, response) => {
  if (!hasLiveKitCredentials()) {
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

  const joinToken = await createJoinToken({
    displayName,
    metadata: { mode: normalizeMode(request.body?.mode) },
    participantId,
    role: 'host',
    roomId,
  })

  console.log(
    JSON.stringify({
      displayName,
      event: 'token.created',
      participantId,
      roomId,
    }),
  )

  response.json(joinToken)
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

function createRoomId() {
  return `room-${crypto.randomBytes(4).toString('hex')}`
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

function normalizeMode(value) {
  const allowedModes = new Set([
    'one-to-one',
    'group-call',
    'webinar',
    'broadcast',
    'audio-only',
  ])

  return typeof value === 'string' && allowedModes.has(value)
    ? value
    : 'group-call'
}

function normalizeRole(value) {
  const allowedRoles = new Set(['host', 'speaker', 'viewer'])

  return typeof value === 'string' && allowedRoles.has(value) ? value : 'host'
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => typeof key === 'string' && key.length <= 64)
      .slice(0, 24),
  )
}

async function createJoinToken({
  displayName,
  metadata,
  participantId,
  role,
  roomId,
}) {
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET

  if (!apiKey || !apiSecret) {
    throw new Error('LiveKit credentials are not configured.')
  }

  const token = new AccessToken(apiKey, apiSecret, {
    identity: participantId,
    metadata: JSON.stringify(metadata || {}),
    name: displayName,
    ttl: '2h',
  })

  token.addGrant({
    canPublish: role !== 'viewer',
    canPublishData: role !== 'viewer',
    canSubscribe: true,
    room: roomId,
    roomJoin: true,
  })

  return {
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    livekitUrl: getLiveKitUrl(),
    participantId,
    roomId,
    token: await token.toJwt(),
  }
}

function hasLiveKitCredentials() {
  return Boolean(process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET)
}

function getLiveKitUrl() {
  return process.env.PUBLIC_LIVEKIT_URL || 'wss://meet.theairix.com/api/livekit'
}

function getPublicDemoUrl() {
  return (process.env.PUBLIC_DEMO_URL || 'https://demo.theairix.com').replace(
    /\/+$/,
    '',
  )
}

function requireApiKey(request, response, next) {
  const apiKey = readBearerToken(request)
  const consumer = findConsumerByApiKey(apiKey)

  if (!consumer) {
    response.status(401).json({
      code: 'invalid_api_key',
      message: 'A valid AIRIX Video API key is required.',
    })
    return
  }

  request.airixConsumer = consumer
  next()
}

function readBearerToken(request) {
  const header = request.get('authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

function findConsumerByApiKey(apiKey) {
  if (!apiKey) return null

  const apiKeyHash = hashSecret(apiKey)
  return getApiConsumers().find((consumer) => consumer.keyHash === apiKeyHash)
}

function rememberRoomConsumer(roomId, consumer) {
  roomConsumers.set(roomId, {
    id: consumer.id,
    keyHash: consumer.keyHash,
    name: consumer.name,
    webhookSecret: consumer.webhookSecret,
    webhookUrl: consumer.webhookUrl,
  })
}

function getApiConsumers() {
  const rawConfig = process.env.AIRIX_VIDEO_API_KEYS
  if (!rawConfig) return []

  try {
    const parsed = JSON.parse(rawConfig)
    if (!Array.isArray(parsed)) return []

    return parsed
      .filter((consumer) => consumer?.id && consumer?.keyHash)
      .map((consumer) => ({
        id: String(consumer.id),
        keyHash: String(consumer.keyHash),
        name: String(consumer.name || consumer.id),
        webhookSecret: consumer.webhookSecret
          ? String(consumer.webhookSecret)
          : '',
        webhookUrl: consumer.webhookUrl ? String(consumer.webhookUrl) : '',
      }))
  } catch {
    return []
  }
}

function serializeLiveKitEvent(event) {
  if (typeof event.toJson === 'function') {
    return event.toJson()
  }

  return JSON.parse(JSON.stringify(event))
}

async function emitConsumerWebhook(consumer, eventName, payload) {
  if (!consumer.webhookUrl || !consumer.webhookSecret) return

  const timestamp = Math.floor(Date.now() / 1000)
  const eventId = `evt_${crypto.randomUUID()}`
  const body = JSON.stringify({
    apiVersion: '2026-08-12',
    createdAt: new Date(timestamp * 1000).toISOString(),
    data: payload,
    event: eventName,
    id: eventId,
  })
  const signature = signWebhookBody(body, timestamp, consumer.webhookSecret)

  try {
    const webhookResponse = await fetch(consumer.webhookUrl, {
      body,
      headers: {
        'content-type': 'application/json',
        'idempotency-key': eventId,
        'x-airix-event': eventName,
        'x-airix-signature': `t=${timestamp},v1=${signature}`,
      },
      method: 'POST',
    })

    console.log(
      JSON.stringify({
        consumerId: consumer.id,
        event: 'consumer.webhook.sent',
        status: webhookResponse.status,
        webhookEvent: eventName,
      }),
    )
  } catch (error) {
    console.error(
      JSON.stringify({
        consumerId: consumer.id,
        error: error instanceof Error ? error.message : 'webhook failed',
        event: 'consumer.webhook.failed',
        webhookEvent: eventName,
      }),
    )
  }
}

function signWebhookBody(body, timestamp, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex')
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex')
}
