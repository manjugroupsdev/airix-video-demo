import '@livekit/components-styles'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { AirixVideoConference } from '@airix/video-react'
import './styles.css'

const randomRoomId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  return `room-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

const readRoomId = () => {
  const pathnameRoom = window.location.pathname.match(/^\/r\/([^/]+)/)?.[1]
  const queryRoom = new URLSearchParams(window.location.search).get('room')

  return pathnameRoom || queryRoom || randomRoomId()
}

const App = () => {
  const [roomId] = React.useState(readRoomId)
  const [displayName, setDisplayName] = React.useState('')
  const [isJoined, setIsJoined] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const roomUrl = `${window.location.origin}/r/${roomId}`

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
        <AirixVideoConference
          apiBaseUrl={window.location.origin}
          displayName={displayName || 'Guest'}
          fallback={<div className="loading-state">Preparing your room...</div>}
          joinTokenProvider={async (input) => {
            const response = await fetch('/api/token', {
              body: JSON.stringify(input),
              headers: { 'content-type': 'application/json' },
              method: 'POST',
            })

            if (!response.ok) {
              const error = await response.json().catch(() => ({}))
              throw new Error(error.message || 'Could not create a join token')
            }

            return response.json()
          }}
          mode="group-call"
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
            setIsJoined(true)
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
          <button type="submit">Join room</button>
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
