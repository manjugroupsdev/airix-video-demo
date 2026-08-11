# AIRIX Video Demo

Guest video room demo powered by the AIRIX Video SDK.

## Features

- Shareable room URLs: `/r/:roomId`
- Guest join with display name only
- Token backend backed by LiveKit
- Partner API keys for server-side room and token creation
- Signed product webhooks for room, token, and LiveKit lifecycle events
- Uses `@airix/video-react` from vendored AIRIX SDK release tarballs

## Local Development

```bash
cp .env.example .env
npm install
npm run server
npm run dev
```

The Vite app runs on `http://localhost:5180` and proxies `/api` to the token server on `http://localhost:8080`.

## Production Env

```env
LIVEKIT_API_KEY=airixmeet
LIVEKIT_API_SECRET=...
PUBLIC_LIVEKIT_URL=wss://meet.theairix.com/api/livekit
PUBLIC_DEMO_URL=https://demo.theairix.com
AIRIX_VIDEO_API_KEYS=[{"id":"product-one","name":"Product One","keyHash":"sha256-of-ak-live-key","webhookUrl":"https://product.example.com/webhooks/airix","webhookSecret":"whsec_..."}]
PORT=8080
```

## Product API

API keys are for product backends only. Never expose them in React, React Native,
iOS, Android, or any browser/mobile client.

Create a key:

```bash
npm run api-key -- product-one "Product One"
```

Add the generated `envConfig` object to `AIRIX_VIDEO_API_KEYS`. Give the raw
`apiKey` only to the product backend that will mint participant tokens.

Check key:

```bash
curl https://demo.theairix.com/api/v1/me \
  -H "Authorization: Bearer ak_live_..."
```

Create a one-to-one or one-to-many room:

```bash
curl https://demo.theairix.com/api/v1/rooms \
  -H "Authorization: Bearer ak_live_..." \
  -H "Content-Type: application/json" \
  -d '{"roomId":"support-call-123","mode":"one-to-one","metadata":{"ticketId":"T-1001"}}'
```

Mint a participant token:

```bash
curl https://demo.theairix.com/api/v1/rooms/support-call-123/tokens \
  -H "Authorization: Bearer ak_live_..." \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Manoj","participantId":"user_123","role":"host"}'
```

Roles:

- `host`: publish audio/video/data and subscribe
- `speaker`: publish audio/video/data and subscribe
- `viewer`: subscribe only

Modes:

- `one-to-one`
- `group-call`
- `webinar`
- `broadcast`
- `audio-only`

## Webhooks

Configured products receive JSON webhook events with:

- `x-airix-event`
- `x-airix-signature: t=<unix>,v1=<hmac-sha256>`
- `idempotency-key`

Events currently emitted:

- `room.created`
- `participant.token_created`
- `livekit.room_started`
- `livekit.room_finished`
- `livekit.participant_joined`
- `livekit.participant_left`
- other LiveKit events as `livekit.<event>`

Verify webhook signatures in Node:

```js
import crypto from "node:crypto";

function verifyAirixWebhook(rawBody, signatureHeader, secret) {
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => part.split("=")),
  );
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${parts.t}.${rawBody}`)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(parts.v1, "hex"),
    Buffer.from(expected, "hex"),
  );
}
```
