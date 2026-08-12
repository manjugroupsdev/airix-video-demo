import '@livekit/components-styles'
import React from 'react'
import ReactDOM from 'react-dom/client'
import {
  ControlBar,
  GridLayout,
  LiveKitRoom,
  ParticipantTile,
  RoomAudioRenderer,
  useParticipants,
  useTracks,
} from '@livekit/components-react'
import { AirixVideoClient, type AirixJoinRoomInput } from 'airix-video-core'
import { Track } from 'livekit-client'
import './styles.css'

type JoinToken = {
  livekitUrl: string
  token: string
}

const randomRoomId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  return `room-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

const readRoomId = () => {
  const pathnameRoom =
    window.location.pathname.match(/^\/r\/([^/]+)/)?.[1] ||
    window.location.pathname.match(/^\/([^/?#]+)/)?.[1]
  const queryRoom = new URLSearchParams(window.location.search).get('room')

  return normalizeRoomId(pathnameRoom || queryRoom || randomRoomId())
}

const normalizeRoomId = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || randomRoomId()

const ParticipantCount = () => {
  const participants = useParticipants()

  return (
    <span className="participant-count">
      {participants.length} {participants.length === 1 ? 'participant' : 'participants'}
    </span>
  )
}

const StableRoomLayout = () => {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  )

  return (
    <>
      <RoomAudioRenderer />
      <GridLayout className="stable-grid" tracks={tracks}>
        <ParticipantTile />
      </GridLayout>
      <ControlBar
        className="stable-controls"
        controls={{ chat: false, settings: false }}
        saveUserChoices
      />
    </>
  )
}

const StableConference = ({
  displayName,
  mediaEnabled,
  participantId,
  roomId,
}: {
  displayName: string
  mediaEnabled: boolean
  participantId: string
  roomId: string
}) => {
  const [joinToken, setJoinToken] = React.useState<JoinToken>()
  const [error, setError] = React.useState('')
  const [status, setStatus] = React.useState('Preparing your room...')
  const client = React.useMemo(
    () =>
      new AirixVideoClient({
        apiBaseUrl: '/api',
        joinTokenProvider: async (input: AirixJoinRoomInput) => {
          const response = await fetch('/api/token', {
            body: JSON.stringify(input),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          })

          if (!response.ok) {
            const responseError = await response.json().catch(() => ({}))
            throw new Error(responseError.message || 'Could not create a join token')
          }

          return response.json()
        },
      }),
    [],
  )

  React.useEffect(() => {
    let isMounted = true

    const createToken = async () => {
      try {
        setError('')
        setStatus('Preparing your room...')

        const nextJoinToken = await client.createToken({
          displayName,
          mode: 'group-call',
          participantId,
          roomId,
        })

        if (isMounted) {
          setJoinToken(nextJoinToken)
          setStatus('Connecting...')
        }
      } catch (tokenError) {
        if (isMounted) {
          setError(tokenError instanceof Error ? tokenError.message : 'Could not join room')
        }
      }
    }

    void createToken()

    return () => {
      isMounted = false
    }
  }, [client, displayName, participantId, roomId])

  if (error) {
    return <div className="loading-state" data-airix-error>{error}</div>
  }

  if (!joinToken) {
    return <div className="loading-state">{status}</div>
  }

  return (
    <LiveKitRoom
      audio={mediaEnabled}
      className="stable-room"
      connect
      connectOptions={{ autoSubscribe: true }}
      data-lk-theme="default"
      onConnected={() => setStatus('Connected')}
      onDisconnected={(reason) => setStatus(reason ? `Disconnected: ${reason}` : 'Disconnected')}
      onError={(roomError) => setError(roomError.message)}
      onMediaDeviceFailure={() => setError('Camera or microphone permission was blocked. Allow access and refresh.')}
      options={{ adaptiveStream: false, dynacast: true }}
      serverUrl={joinToken.livekitUrl}
      token={joinToken.token}
      video={mediaEnabled}
    >
      <div className="connection-status">{status}</div>
      <ParticipantCount />
      <StableRoomLayout />
    </LiveKitRoom>
  )
}

const App = () => {
  const [roomId] = React.useState(readRoomId)
  const [displayName, setDisplayName] = React.useState('')
  const [isJoined, setIsJoined] = React.useState(false)
  const [isJoining, setIsJoining] = React.useState(false)
  const [mediaEnabled, setMediaEnabled] = React.useState(false)
  const [permissionMessage, setPermissionMessage] = React.useState('')
  const [copied, setCopied] = React.useState(false)
  const roomUrl = `${window.location.origin}/r/${roomId}`
  const participantId = React.useMemo(() => crypto.randomUUID(), [])

  React.useEffect(() => {
    if (window.location.pathname !== `/r/${roomId}`) {
      window.history.replaceState(null, '', `/r/${roomId}`)
    }
  }, [roomId])

  const copyInvite = async () => {
    await navigator.clipboard.writeText(roomUrl)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  const requestMediaAndJoin = async () => {
    setIsJoining(true)
    setPermissionMessage('')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      })

      stream.getTracks().forEach((track) => track.stop())
      setMediaEnabled(true)
    } catch {
      setMediaEnabled(false)
      setPermissionMessage(
        'Camera or microphone permission was blocked. You can still join now and enable devices from the controls after allowing access.',
      )
    } finally {
      setIsJoining(false)
      setIsJoined(true)
    }
  }

  if (isJoined) {
    return (
      <main className="conference-shell">
        <div className="room-bar">
          <div>
            <span className="eyebrow">AIRIX Video</span>
            <strong>{roomId}</strong>
          </div>
          <button className="secondary-button" type="button" onClick={copyInvite}>
            {copied ? 'Copied' : 'Copy invite'}
          </button>
        </div>
        <StableConference
          displayName={displayName || 'Guest'}
          mediaEnabled={mediaEnabled}
          participantId={participantId}
          roomId={roomId}
        />
      </main>
    )
  }

  return (
    <main className="join-page">
      <section className="join-card">
        <div className="brand-row">
          <div className="brand-mark">A</div>
          <span>AIRIX Video</span>
        </div>
        <div className="join-copy">
          <p className="eyebrow">Guest access</p>
          <h1>Join a room with one link.</h1>
          <p>
            Share this URL with anyone and they can enter as a guest. No account,
            no workspace setup.
          </p>
        </div>
        <form
          className="join-form"
          onSubmit={(event) => {
            event.preventDefault()
            void requestMediaAndJoin()
          }}
        >
          <label>
            Display name
            <input
              autoFocus
              maxLength={48}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Guest"
              value={displayName}
            />
          </label>
          {permissionMessage ? <p className="permission-note">{permissionMessage}</p> : null}
          <button disabled={isJoining} type="submit">
            {isJoining ? 'Checking camera...' : 'Join room'}
          </button>
        </form>
        <div className="invite-row">
          <code>{roomUrl}</code>
          <button className="text-button" type="button" onClick={copyInvite}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </section>
      <section className="preview-panel" aria-label="AIRIX video preview">
        <div className="preview-gradient" />
        <div className="preview-content">
          <p>Realtime SDK demo</p>
          <h2>Fast guest meetings for web and mobile products.</h2>
          <div className="participant-grid">
            <span>Guest 1</span>
            <span>Guest 2</span>
            <span>Guest 3</span>
            <span>Guest 4</span>
          </div>
        </div>
      </section>
    </main>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
