import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import net from 'node:net'
import http from 'node:http'
import { after, before, test } from 'node:test'
import pg from 'pg'
import { AccessToken } from 'livekit-server-sdk'

let port
let base
let fakeEgress
let egressPort
let fakeS3
let s3Port
const egressRequests = []

async function freePort() {
  return new Promise((resolve) => {
    const listener = net.createServer()
    listener.listen(0, '127.0.0.1', () => {
      const selected = listener.address().port
      listener.close(() => resolve(selected))
    })
  })
}
const firstKey = 'test-product-one-key'
const secondKey = 'test-product-two-key'
const roomId = `recording-test-${crypto.randomUUID()}`
const pool = new pg.Pool({ host: '127.0.0.1', port: 55432, user: process.env.USER, database: 'postgres' })
let server

async function postWebhook(event) {
  const payload = JSON.stringify(event)
  const signature = new AccessToken('test-key', 'test-secret-for-signing-tokens')
  signature.sha256 = crypto.createHash('sha256').update(payload).digest('base64')
  return fetch(`http://127.0.0.1:${port}/api/internal/livekit-webhook`, {
    method: 'POST',
    headers: { authorization: await signature.toJwt(), 'content-type': 'application/json' },
    body: payload,
  })
}

before(async () => {
  port = await freePort()
  egressPort = await freePort()
  s3Port = await freePort()
  fakeS3 = http.createServer((request, response) => {
    const body = Buffer.from(new URL(request.url, 'http://localhost').pathname.endsWith('.mp3') ? 'fake-mp3' : 'fake-mp4')
    const range = request.headers.range
    const output = range ? body.subarray(0, 4) : body
    response.statusCode = range ? 206 : 200
    response.setHeader('content-length', String(output.length))
    if (range) response.setHeader('content-range', `bytes 0-3/${body.length}`)
    response.end(output)
  })
  await new Promise((resolve) => fakeS3.listen(s3Port, '127.0.0.1', resolve))
  fakeEgress = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const egressId = request.url.includes('StartRoomCompositeEgress')
      ? `egress-${crypto.randomUUID()}` : body.egressId
    egressRequests.push({ path: request.url, body, egressId })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      egressId,
      status: 'EGRESS_ACTIVE',
    }))
  })
  await new Promise((resolve) => fakeEgress.listen(egressPort, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${port}/api/v1`
  const consumers = [firstKey, secondKey].map((key, index) => ({
    id: `test-product-${index + 1}`,
    keyHash: crypto.createHash('sha256').update(key).digest('hex'),
  }))
  server = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      PGHOST: '127.0.0.1',
      PGPORT: '55432',
      PGUSER: process.env.USER,
      PGDATABASE: 'postgres',
      PGPASSWORD: '',
      AIRIX_VIDEO_API_KEYS: JSON.stringify(consumers),
      LIVEKIT_API_KEY: 'test-key',
      LIVEKIT_API_SECRET: 'test-secret-for-signing-tokens',
      LIVEKIT_INTERNAL_URL: `http://127.0.0.1:${egressPort}`,
      RECORDING_SHARE_SECRET: 'test-share-secret-for-public-recordings',
      RECORDING_S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
      RECORDING_S3_ACCESS_KEY: 'test',
      RECORDING_S3_SECRET_KEY: 'test',
      PUBLIC_DEMO_URL: `http://127.0.0.1:${port}`,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Test API did not start')
})

after(async () => {
  server?.kill()
  fakeEgress?.close()
  fakeS3?.close()
  await pool.query('DELETE FROM airix_video_recordings WHERE room_id = $1', [roomId]).catch(() => {})
  await pool.query('DELETE FROM airix_video_room_owners WHERE room_id = $1 OR room_id = $2', [roomId, `${roomId}-manual`]).catch(() => {})
  await pool.end()
})

test('manual start and stop create MP4 and MP3 composite egresses', async () => {
  const response = await fetch(`${base}/rooms/${roomId}-manual/recordings`, {
    method: 'POST', headers: { authorization: `Bearer ${firstKey}` },
  })
  assert.equal(response.status, 201)
  const recording = await response.json()
  assert.equal(recording.status, 'recording')
  const starts = egressRequests.filter((entry) => entry.path.includes('StartRoomCompositeEgress'))
  assert.equal(starts.length, 2)
  assert.deepEqual(starts.map((entry) => entry.body.fileOutputs[0].fileType), ['MP4', 'MP3'])
  assert.equal(starts[1].body.audioOnly, true)

  const stopped = await fetch(`${base}/recordings/${recording.id}/stop`, {
    method: 'POST', headers: { authorization: `Bearer ${firstKey}` },
  })
  assert.equal(stopped.status, 200)
  assert.equal(egressRequests.filter((entry) => entry.path.includes('StopEgress')).length, 2)

  for (let index = 0; index < 2; index++) {
    const webhook = await postWebhook({
      event: 'egress_ended',
      egressInfo: {
        egressId: starts[index].egressId,
        status: 'EGRESS_COMPLETE',
        fileResults: [{ filename: `airix-video/${recording.id}.${index === 0 ? 'mp4' : 'mp3'}` }],
      },
    })
    assert.equal(webhook.status, 200)
  }
  const readyResponse = await fetch(`${base}/recordings/${recording.id}`, {
    headers: { authorization: `Bearer ${firstKey}` },
  })
  const ready = await readyResponse.json()
  assert.equal(ready.status, 'ready')
  assert.ok(ready.mp4Url && ready.mp3Url)
  const ttl = new Date(ready.publicUrlExpiresAt).getTime() - Date.now()
  assert.ok(ttl > 23.9 * 60 * 60 * 1000 && ttl <= 24 * 60 * 60 * 1000)
  const audio = await fetch(ready.mp3Url)
  assert.equal(audio.status, 200)
  assert.equal(audio.headers.get('content-type'), 'audio/mpeg')
  assert.equal(await audio.text(), 'fake-mp3')
  const partial = await fetch(ready.mp4Url, { headers: { range: 'bytes=0-3' } })
  assert.equal(partial.status, 206)
  assert.equal(await partial.text(), 'fake')
  await pool.query('DELETE FROM airix_video_recordings WHERE id = $1', [recording.id])
})

test('host autoStart schedules a recording and protects its status by product', async () => {
  const tokenResponse = await fetch(`${base}/rooms/${roomId}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${firstKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'Test', role: 'host', recording: { autoStart: true } }),
  })
  assert.equal(tokenResponse.status, 200)
  const token = await tokenResponse.json()
  assert.equal(token.recording.status, 'pending')
  assert.match(token.recording.id, /^[0-9a-f-]{36}$/)
  assert.equal(token.recording.mp3Url, undefined)

  const path = `${base}/recordings/${token.recording.id}`
  const otherProduct = await fetch(path, { headers: { authorization: `Bearer ${secondKey}` } })
  assert.equal(otherProduct.status, 404)

  const ownResponse = await fetch(path, { headers: { authorization: `Bearer ${firstKey}` } })
  assert.equal(ownResponse.status, 200)
  assert.equal((await ownResponse.json()).status, 'pending')

  const foreignToken = await fetch(`${base}/rooms/${roomId}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secondKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'Other product' }),
  })
  assert.equal(foreignToken.status, 409)

  const viewerResponse = await fetch(`${base}/rooms/${roomId}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${firstKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'Viewer', role: 'viewer', recording: { autoStart: true } }),
  })
  assert.equal(viewerResponse.status, 403)

  const joined = await postWebhook({ event: 'participant_joined', room: { name: roomId } })
  assert.equal(joined.status, 200)
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await pool.query('SELECT status FROM airix_video_recordings WHERE id = $1', [token.recording.id])
    if (result.rows[0].status === 'recording') break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const started = await pool.query('SELECT status FROM airix_video_recordings WHERE id = $1', [token.recording.id])
  assert.equal(started.rows[0].status, 'recording')

  await pool.query(
    `UPDATE airix_video_recordings SET status = 'ready', mp4_ready = true, mp3_ready = true,
     expires_at = now() + interval '24 hours' WHERE id = $1`, [token.recording.id],
  )
  const readyResponse = await fetch(path, { headers: { authorization: `Bearer ${firstKey}` } })
  const ready = await readyResponse.json()
  assert.match(ready.mp4Url, /\/mp4\//)
  assert.match(ready.mp3Url, /\/mp3\//)

  const invalidLink = await fetch(ready.mp3Url.replace(/.$/, 'x'))
  assert.equal(invalidLink.status, 404)
  await pool.query(`UPDATE airix_video_recordings SET expires_at = now() - interval '1 second' WHERE id = $1`, [token.recording.id])
  const expired = await fetch(ready.mp3Url)
  assert.equal(expired.status, 404)
})
