# AIRIX Video Demo

Guest video room demo powered by the AIRIX Video SDK.

## Features

- Shareable room URLs: `/r/:roomId`
- Guest join with display name only
- Token backend backed by LiveKit
- Partner API keys for server-side room and token creation
- Signed product webhooks for room, token, and LiveKit lifecycle events
- Uses `airix-video-react` from vendored AIRIX SDK release tarballs
- MP4 and MP3 room recordings with 24-hour public download links

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
PGHOST=postgres
PGUSER=suite
PGPASSWORD=...
PGDATABASE=suite
RECORDING_S3_ENDPOINT=http://minio:9000
RECORDING_S3_ACCESS_KEY=...
RECORDING_S3_SECRET_KEY=...
RECORDING_SHARE_SECRET=...
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

Use the AIRIX SDK for calls and recording. On your product backend, use
`airix-video-core@0.1.3` with `livekit-client@2.20.0` installed as its peer
dependency. Add `"recording":{"autoStart":true}` to a host token request;
the response includes a recording ID. Recording starts when the first
participant joins. Product code does not need direct LiveKit calls.

Manual control, from the product backend with its API key:

```text
POST /api/v1/rooms/{roomId}/recordings
POST /api/v1/recordings/{recordingId}/stop
GET  /api/v1/recordings/{recordingId}
```

When status becomes `ready`, the GET response includes `mp4Url`, `mp3Url`, and
`publicUrlExpiresAt`. Both links work without authentication for 24 hours.
They proxy private MinIO objects; the bucket must stay private. Media objects
are removed after 30 days.

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
- `recording.ready`
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
