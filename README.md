# AIRIX Video Demo

Guest video room demo powered by the AIRIX Video SDK.

## Features

- Shareable room URLs: `/r/:roomId`
- Guest join with display name only
- Token backend backed by LiveKit
- Uses `@airix/video-react` from the AIRIX SDK release tarballs

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
PORT=8080
```
