import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { EgressClient, EgressStatus, EncodedFileType } from 'livekit-server-sdk'
import pg from 'pg'

const { Pool } = pg
const DAY = 24 * 60 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function installRecordingRoutes(app, requireApiKey, normalizeRoomId) {
  const pool = new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
  })
  const s3 = new S3Client({
    endpoint: process.env.RECORDING_S3_ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.RECORDING_S3_ACCESS_KEY,
      secretAccessKey: process.env.RECORDING_S3_SECRET_KEY,
    },
  })
  const bucket = process.env.RECORDING_S3_BUCKET || 'meet-media-storage'
  const egress = new EgressClient(
    process.env.LIVEKIT_INTERNAL_URL || 'http://livekit:7880',
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
  )

  let ready
  const ensureReady = () => (ready ??= pool.query(`
    CREATE TABLE IF NOT EXISTS airix_video_room_owners (
      room_id text PRIMARY KEY,
      consumer_id text NOT NULL,
      last_seen_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS airix_video_recordings (
      id uuid PRIMARY KEY,
      consumer_id text NOT NULL,
      room_id text NOT NULL,
      status text NOT NULL,
      mp4_egress_id text,
      mp3_egress_id text,
      mp4_ready boolean NOT NULL DEFAULT false,
      mp3_ready boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz,
      error text
    );
    CREATE UNIQUE INDEX IF NOT EXISTS airix_video_active_room
      ON airix_video_recordings (room_id)
      WHERE status IN ('pending', 'starting', 'recording', 'stopping');
  `))

  async function claimRoom(roomId, consumerId) {
    await ensureReady()
    const result = await pool.query(
      `INSERT INTO airix_video_room_owners (room_id, consumer_id)
       VALUES ($1, $2)
       ON CONFLICT (room_id) DO UPDATE SET last_seen_at = now()
       WHERE airix_video_room_owners.consumer_id = EXCLUDED.consumer_id
       RETURNING consumer_id`, [roomId, consumerId],
    )
    return Boolean(result.rows[0])
  }

  async function ownerForRoom(roomId) {
    await ensureReady()
    const result = await pool.query(
      'SELECT consumer_id FROM airix_video_room_owners WHERE room_id = $1', [roomId],
    )
    return result.rows[0]?.consumer_id || null
  }

  function key(id, format) {
    return `airix-video/${id}.${format}`
  }

  function token(id, format, expiresAt) {
    return crypto.createHmac('sha256', process.env.RECORDING_SHARE_SECRET)
      .update(`${id}:${format}:${new Date(expiresAt).toISOString()}`)
      .digest('base64url')
  }

  function present(recording) {
    const expiresAt = recording.expires_at?.toISOString() || null
    const publicBase = (process.env.PUBLIC_DEMO_URL || 'https://demo.theairix.com').replace(/\/+$/, '')
    const links = {}
    if (expiresAt && new Date(expiresAt).getTime() > Date.now()) {
      for (const format of ['mp4', 'mp3']) {
        if (recording[`${format}_ready`]) {
          links[`${format}Url`] = `${publicBase}/api/v1/public/recordings/${recording.id}/${format}/${token(recording.id, format, expiresAt)}`
        }
      }
    }
    return {
      id: recording.id,
      roomId: recording.room_id,
      status: recording.status,
      createdAt: recording.created_at.toISOString(),
      publicUrlExpiresAt: expiresAt,
      ...links,
    }
  }

  async function owned(request, response) {
    if (!UUID.test(request.params.recordingId)) {
      response.status(404).json({ code: 'recording_not_found', message: 'Recording not found.' })
      return null
    }
    await ensureReady()
    const result = await pool.query(
      'SELECT * FROM airix_video_recordings WHERE id = $1 AND consumer_id = $2',
      [request.params.recordingId, request.airixConsumer.id],
    )
    if (!result.rows[0]) {
      response.status(404).json({ code: 'recording_not_found', message: 'Recording not found.' })
      return null
    }
    return result.rows[0]
  }

  async function start(roomId, consumerId) {
    await ensureReady()
    if (!await claimRoom(roomId, consumerId)) throw new Error('Room is owned by another product.')
    const id = crypto.randomUUID()
    let recordingId = id
    try {
      await pool.query(
        `INSERT INTO airix_video_recordings (id, consumer_id, room_id, status)
         VALUES ($1, $2, $3, 'starting')`,
        [id, consumerId, roomId],
      )
    } catch (error) {
      if (error.code !== '23505') throw error
      const existing = await pool.query(
        `SELECT * FROM airix_video_recordings WHERE consumer_id = $1 AND room_id = $2
         AND status IN ('pending', 'starting', 'recording', 'stopping')`,
        [consumerId, roomId],
      )
      if (!existing.rows[0]) throw new Error('Room already has a recording owned by another product.')
      if (existing.rows[0].status !== 'pending') {
        return { recording: present(existing.rows[0]), created: false }
      }
      const claimed = await pool.query(
        `UPDATE airix_video_recordings SET status = 'starting'
         WHERE id = $1 AND status = 'pending' RETURNING id`, [existing.rows[0].id],
      )
      if (!claimed.rows[0]) return { recording: present(existing.rows[0]), created: false }
      recordingId = existing.rows[0].id
    }

    let mp4
    try {
      const s3Config = {
        endpoint: process.env.RECORDING_S3_ENDPOINT,
        accessKey: process.env.RECORDING_S3_ACCESS_KEY,
        secret: process.env.RECORDING_S3_SECRET_KEY,
        bucket,
        region: 'us-east-1',
        forcePathStyle: true,
      }
      mp4 = await egress.startRoomCompositeEgress(roomId, {
        fileType: EncodedFileType.MP4,
        filepath: key(recordingId, 'mp4'),
        output: { case: 's3', value: s3Config },
      }, { layout: 'speaker-light' })
      await pool.query('UPDATE airix_video_recordings SET mp4_egress_id = $2 WHERE id = $1', [recordingId, mp4.egressId])
      const mp3 = await egress.startRoomCompositeEgress(roomId, {
        fileType: EncodedFileType.MP3,
        filepath: key(recordingId, 'mp3'),
        output: { case: 's3', value: s3Config },
      }, { audioOnly: true })
      const result = await pool.query(
        `UPDATE airix_video_recordings SET mp3_egress_id = $2, status = 'recording'
         WHERE id = $1 RETURNING *`, [recordingId, mp3.egressId],
      )
      return { recording: present(result.rows[0]), created: true }
    } catch (error) {
      if (mp4?.egressId) await egress.stopEgress(mp4.egressId).catch(() => {})
      await pool.query(`UPDATE airix_video_recordings SET status = 'failed', error = $2 WHERE id = $1`, [recordingId, String(error)])
      throw error
    }
  }

  async function schedule(roomId, consumerId) {
    await ensureReady()
    if (!await claimRoom(roomId, consumerId)) throw new Error('Room is owned by another product.')
    const result = await pool.query(
      `INSERT INTO airix_video_recordings (id, consumer_id, room_id, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (room_id) WHERE status IN ('pending', 'starting', 'recording', 'stopping')
       DO NOTHING RETURNING *`, [crypto.randomUUID(), consumerId, roomId],
    )
    if (result.rows[0]) return present(result.rows[0])
    const existing = await pool.query(
      `SELECT * FROM airix_video_recordings WHERE room_id = $1 AND status IN ('pending', 'starting', 'recording', 'stopping')`,
      [roomId],
    )
    if (existing.rows[0]?.consumer_id !== consumerId) throw new Error('Room is owned by another product.')
    return present(existing.rows[0])
  }

  app.post('/api/v1/rooms/:roomId/recordings', requireApiKey, async (request, response) => {
    const roomId = normalizeRoomId(request.params.roomId)
    if (!roomId) return response.status(400).json({ code: 'invalid_room' })
    try {
      if (!await claimRoom(roomId, request.airixConsumer.id)) {
        return response.status(409).json({ code: 'room_owned_by_another_product' })
      }
      const result = await start(roomId, request.airixConsumer.id)
      return response.status(result.created ? 201 : 200).json(result.recording)
    } catch {
      return response.status(502).json({ code: 'recording_start_failed', message: 'Could not start recording.' })
    }
  })

  app.post('/api/v1/recordings/:recordingId/stop', requireApiKey, async (request, response) => {
    const recording = await owned(request, response)
    if (!recording) return
    if (recording.status !== 'recording') return response.status(409).json({ code: 'recording_not_active' })
    await pool.query(`UPDATE airix_video_recordings SET status = 'stopping' WHERE id = $1`, [recording.id])
    try {
      await Promise.all([egress.stopEgress(recording.mp4_egress_id), egress.stopEgress(recording.mp3_egress_id)])
      return response.json({ ...present(recording), status: 'stopping' })
    } catch {
      return response.status(502).json({ code: 'recording_stop_failed' })
    }
  })

  app.get('/api/v1/recordings/:recordingId', requireApiKey, async (request, response) => {
    const recording = await owned(request, response)
    if (recording) response.json(present(recording))
  })

  app.get('/api/v1/public/recordings/:recordingId/:format/:token', async (request, response) => {
    await ensureReady()
    const { recordingId, format, token: supplied } = request.params
    if (!['mp4', 'mp3'].includes(format) || !UUID.test(recordingId)) {
      return response.sendStatus(404)
    }
    const result = await pool.query('SELECT * FROM airix_video_recordings WHERE id = $1', [recordingId])
    const recording = result.rows[0]
    if (!recording?.[`${format}_ready`] || !recording.expires_at || recording.expires_at.getTime() <= Date.now()) {
      return response.sendStatus(404)
    }
    const expected = Buffer.from(token(recordingId, format, recording.expires_at))
    const actual = Buffer.from(supplied)
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return response.sendStatus(404)
    try {
      const object = await s3.send(new GetObjectCommand({
        Bucket: bucket, Key: key(recordingId, format),
        ...(request.get('range') ? { Range: request.get('range') } : {}),
      }))
      response.set('Cache-Control', 'private, no-store')
      response.set('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'video/mp4')
      response.set('Accept-Ranges', 'bytes')
      if (object.ContentLength) response.set('Content-Length', String(object.ContentLength))
      if (object.ContentRange) response.set('Content-Range', object.ContentRange)
      response.status(object.ContentRange ? 206 : 200)
      Readable.fromWeb(object.Body.transformToWebStream()).pipe(response)
    } catch {
      response.sendStatus(404)
    }
  })

  if (process.env.PGHOST) {
    const cleanup = setInterval(async () => {
      try {
        await ensureReady()
        const old = await pool.query(
          `SELECT id FROM airix_video_recordings WHERE created_at < now() - interval '30 days' LIMIT 100`,
        )
        for (const { id } of old.rows) {
          await Promise.all(['mp4', 'mp3'].map((format) => s3.send(new DeleteObjectCommand({
            Bucket: bucket, Key: key(id, format),
          }))))
          await pool.query('DELETE FROM airix_video_recordings WHERE id = $1', [id])
        }
      } catch (error) {
        console.error(JSON.stringify({ event: 'recording.cleanup.failed', error: String(error) }))
      }
    }, DAY)
    cleanup.unref()
  }

  return {
    start,
    schedule,
    claimRoom,
    ownerForRoom,
    async onParticipantJoined(roomId) {
      await ensureReady()
      const result = await pool.query(
        `SELECT * FROM airix_video_recordings WHERE room_id = $1 AND status = 'pending'`, [roomId],
      )
      if (result.rows[0]) await start(roomId, result.rows[0].consumer_id)
    },
    async onEgressEnded(event) {
      await ensureReady()
      const egressId = event.egressInfo?.egressId
      if (!egressId) return
      const result = await pool.query(
        `SELECT * FROM airix_video_recordings WHERE mp4_egress_id = $1 OR mp3_egress_id = $1`,
        [egressId],
      )
      const recording = result.rows[0]
      if (!recording) return
      const format = recording.mp4_egress_id === egressId ? 'mp4' : 'mp3'
      const succeeded = event.egressInfo?.status === EgressStatus.EGRESS_COMPLETE && event.egressInfo?.fileResults?.length > 0
      const updated = await pool.query(
        `UPDATE airix_video_recordings SET ${format}_ready = $2,
         status = CASE WHEN status = 'failed' OR NOT $2 THEN 'failed'
                       WHEN ${format === 'mp4' ? 'mp3_ready' : 'mp4_ready'} THEN 'ready' ELSE 'processing' END,
         expires_at = CASE WHEN $2 AND ${format === 'mp4' ? 'mp3_ready' : 'mp4_ready'} AND expires_at IS NULL
                           THEN now() + interval '24 hours' ELSE expires_at END
         WHERE id = $1 AND ${format}_ready = false RETURNING *`, [recording.id, succeeded],
      )
      if (!updated.rows[0]) return null
      return updated.rows[0].status === 'ready'
        ? { ...present(updated.rows[0]), consumerId: updated.rows[0].consumer_id }
        : null
    },
  }
}
