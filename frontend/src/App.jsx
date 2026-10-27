import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  Clock3,
  Copy,
  KeyRound,
  Link2,
  LockKeyhole,
  LogOut,
  Send,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { decryptMessage } from './crypto/decrypt.js';
import { encryptMessage } from './crypto/encrypt.js';
import { deriveRoomKey, randomRoomSecret } from './crypto/keyDerivation.js';
import { apiRequest, getSocketUrl } from './services/api.js';
import './App.css';

function emitWithAck(socket, event, payload, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) {
      reject(new Error('Connection lost. Please wait for reconnection.'));
      return;
    }
    const timer = window.setTimeout(() => reject(new Error('Server did not respond in time.')), timeoutMs);
    socket.emit(event, payload, (response) => {
      window.clearTimeout(timer);
      if (!response?.ok) reject(new Error(response?.error || 'Request failed.'));
      else resolve(response);
    });
  });
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(timestamp);
}

function App() {
  const [initialInvitation] = useState(() => {
    if (typeof window === 'undefined') return new URLSearchParams();
    return new URLSearchParams(window.location.hash.slice(1));
  });

  const [page, setPage] = useState(() => (
    initialInvitation.has('room') || initialInvitation.has('secret') ? 'join' : 'home'
  ));
  const [room, setRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const [connection, setConnection] = useState('disconnected');
  const [peerConnected, setPeerConnected] = useState(false);
  const [joinCode, setJoinCode] = useState(() => initialInvitation.get('room') || '');
  const [joinSecret, setJoinSecret] = useState(() => initialInvitation.get('secret') || '');
  const [joinError, setJoinError] = useState(() => (
    initialInvitation.has('room') && !initialInvitation.has('secret')
      ? 'Invite link is missing the secret. Please enter it manually.'
      : ''
  ));
  const [roomError, setRoomError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState('');
  const socketRef = useRef(null);
  const scrollRef = useRef(null);
  const toastTimerRef = useRef(null);

  function notify(message) {
    setToast(message);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(''), 2_600);
  }

  useEffect(() => {
    if (!window.location.hash) return;
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }, []);

  useEffect(() => {
    if (!room) return undefined;
    const activeRoom = room;
    const socket = io(getSocketUrl(), {
      transports: ['websocket', 'polling'],
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3_000,
      timeout: 8_000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnection('connecting');
      socket.emit('room:join', {
        roomId: activeRoom.roomId,
        capability: activeRoom.capability,
        sessionId: activeRoom.sessionId,
      }, (result) => {
        if (!result?.ok) {
          setRoomError(result?.error || 'Room is unavailable or has expired.');
          setPage('unavailable');
          setRoom(null);
          return;
        }
        if (result.role !== activeRoom.role) {
          setRoomError('Room membership could not be verified.');
          setPage('unavailable');
          setRoom(null);
          return;
        }
        setPeerConnected(Boolean(result.peerConnected));
        setConnection('connected');
      });
    });

    socket.on('connect_error', () => {
      setConnection('disconnected');
    });
    socket.io.on('reconnect_attempt', () => setConnection('reconnecting'));
    socket.on('disconnect', (reason) => {
      if (reason === 'io server disconnect') setConnection('disconnected');
      else setConnection('reconnecting');
      setPeerConnected(false);
    });
    socket.on('room:peer-status', ({ online }) => setPeerConnected(Boolean(online)));
    socket.on('message:new', async ({ roomId, envelope: serialized }) => {
      if (roomId !== activeRoom.roomId) return;
      try {
        const message = await decryptMessage(serialized, activeRoom.key, activeRoom.roomId);
        setMessages((curr) => curr.some((m) => m.id === message.id) ? curr : [...curr, message]);
      } catch {
        notify('Message failed decryption check.');
      }
    });
    socket.on('message:deleted', ({ messageId }) => {
      setMessages((curr) => curr.filter((m) => m.id !== messageId));
    });
    socket.on('room:cleared', () => {
      setMessages([]);
      notify('Chat cleared by peer.');
    });
    socket.on('room:ended', () => {
      setRoomError('This secure room has been ended.');
      setMessages([]);
      setRoom(null);
      setPage('unavailable');
    });

    socket.connect();
    return () => {
      socket.removeAllListeners();
      socket.io.removeAllListeners();
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [room]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  useEffect(() => () => window.clearTimeout(toastTimerRef.current), []);

  async function createRoom() {
    setBusy(true);
    setRoomError('');
    try {
      const created = await apiRequest('/rooms', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const secret = randomRoomSecret();
      const key = await deriveRoomKey(secret, created.roomId);
      const code = created.roomId;
      const invitationUrl = new URL(`${window.location.origin}${window.location.pathname}`);
      invitationUrl.hash = new URLSearchParams({ room: code, secret }).toString();

      setRoom({
        roomId: created.roomId,
        code,
        secret,
        key,
        role: 'owner',
        capability: created.ownerCapability,
        sessionId: crypto.randomUUID(),
        expiresAt: created.expiresAt,
        invitationUrl: invitationUrl.toString(),
      });
      setConnection('connecting');
      setMessages([]);
      setPeerConnected(false);
      setPage('room');
      notify('Room created. Share the code or invite link.');
    } catch (error) {
      setRoomError(error.message);
      setPage('connection-error');
    } finally {
      setBusy(false);
    }
  }

  async function joinRoom(event) {
    event?.preventDefault();
    setJoinError('');
    const rawCode = joinCode.trim();
    const secret = joinSecret.trim();

    if (!rawCode) {
      setJoinError('Please enter a room code.');
      return;
    }
    if (!secret || secret.length < 4) {
      setJoinError('Secret must be at least 4 characters.');
      return;
    }

    let roomId = rawCode;
    let capability = rawCode;
    if (rawCode.includes('.')) {
      [roomId, capability] = rawCode.split('.');
    } else {
      roomId = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
      capability = roomId;
    }

    setBusy(true);
    try {
      const key = await deriveRoomKey(secret, roomId);
      await apiRequest(`/rooms/${roomId}`);
      const membership = await apiRequest(`/rooms/${roomId}/join`, {
        method: 'POST',
        body: JSON.stringify({ capability }),
      });
      setRoom({
        roomId,
        code: roomId,
        secret,
        key,
        role: membership.role,
        capability,
        sessionId: crypto.randomUUID(),
        expiresAt: membership.expiresAt,
        invitationUrl: null,
      });
      setConnection('connecting');
      setMessages([]);
      setPeerConnected(false);
      setPage('room');
      notify('Joined room securely.');
    } catch (error) {
      setJoinError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function copyText(value, successMessage) {
    try {
      await navigator.clipboard.writeText(value);
      notify(successMessage);
    } catch {
      notify('Failed to copy. Please select and copy manually.');
    }
  }

  async function sendMessage(event) {
    event?.preventDefault();
    const text = draft.trim();
    if (!room || !text.length || sending) return;
    setSending(true);
    setDraft('');
    try {
      const { envelope, serialized } = await encryptMessage(text, room.key, room.roomId, room.role);
      await emitWithAck(socketRef.current, 'message:send', {
        roomId: room.roomId,
        envelope: serialized,
      });
      setMessages((curr) => [...curr, { ...envelope, text }]);
    } catch (error) {
      setDraft(text);
      notify(error.message);
    } finally {
      setSending(false);
    }
  }

  async function deleteMessage(messageId) {
    if (!window.confirm('Delete this message for everyone?')) return;
    try {
      await emitWithAck(socketRef.current, 'message:delete', { roomId: room.roomId, messageId });
      setMessages((curr) => curr.filter((m) => m.id !== messageId));
    } catch (error) {
      notify(error.message);
    }
  }

  async function clearChat() {
    if (!messages.length) return;
    if (!window.confirm('Clear all messages for everyone in the room?')) return;
    try {
      await emitWithAck(socketRef.current, 'room:clear', { roomId: room.roomId });
      setMessages([]);
      notify('Chat cleared.');
    } catch (error) {
      notify(error.message);
    }
  }

  function leaveRoom() {
    socketRef.current?.disconnect();
    setMessages([]);
    setDraft('');
    setRoom(null);
    setPeerConnected(false);
    setConnection('disconnected');
    setPage('home');
  }

  async function endRoom() {
    if (!room || !window.confirm('End room for everyone? All messages will disappear.')) return;
    setBusy(true);
    try {
      await apiRequest(`/rooms/${room.roomId}`, {
        method: 'DELETE',
        body: JSON.stringify({ capability: room.capability }),
      });
      setRoomError('This secure room has been ended.');
      setMessages([]);
      setRoom(null);
      setPage('unavailable');
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  }

  if (page === 'room' && room) {
    return (
      <>
        <ChatRoom
          room={room}
          messages={messages}
          connection={connection}
          peerConnected={peerConnected}
          draft={draft}
          setDraft={setDraft}
          sending={sending}
          scrollRef={scrollRef}
          onCopy={copyText}
          onSend={sendMessage}
          onDelete={deleteMessage}
          onClear={clearChat}
          onLeave={leaveRoom}
          onEnd={endRoom}
        />
        <Toast message={toast} />
      </>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setPage('home')} aria-label="SecureCode home">
          <span className="brand-mark"><LockKeyhole size={18} strokeWidth={2.4} /></span>
          <span>secure<span className="brand-accent">code</span></span>
        </button>
        <div className="topbar-status">
          <span className="status-dot" /> End-to-End Encrypted
        </div>
      </header>

      <div className="page-content">
        {page === 'home' && (
          <HomePage
            onCreate={createRoom}
            onJoin={() => { setJoinError(''); setPage('join'); }}
            busy={busy}
          />
        )}
        {page === 'join' && (
          <JoinPage
            code={joinCode}
            secret={joinSecret}
            error={joinError}
            busy={busy}
            onCodeChange={setJoinCode}
            onSecretChange={setJoinSecret}
            onSubmit={joinRoom}
            onBack={() => { setJoinError(''); setPage('home'); }}
          />
        )}
        {page === 'unavailable' && (
          <StatusPage
            icon={<Clock3 size={24} />}
            title="Room Unavailable"
            description={roomError || 'This room has expired, ended, or does not exist.'}
            onBack={() => { setRoomError(''); setPage('home'); }}
          />
        )}
        {page === 'connection-error' && (
          <StatusPage
            icon={<CircleAlert size={24} />}
            title="Connection Error"
            description={roomError || 'Could not connect to the server. Please try again.'}
            onBack={() => { setRoomError(''); setPage('home'); }}
            actionLabel="Try again"
            onAction={createRoom}
            busy={busy}
          />
        )}
      </div>

      <footer className="site-footer">
        <span>No accounts. Zero storage. Rooms auto-expire after 30 minutes.</span>
      </footer>
      <Toast message={toast} />
    </main>
  );
}

function HomePage({ onCreate, onJoin, busy }) {
  return (
    <section className="home-card">
      <div className="home-icon">
        <LockKeyhole size={28} />
      </div>
      <h1>Private & Temporary<br /><span className="brand-accent">Secure Messaging</span></h1>
      <p className="home-desc">
        Share passwords, secrets, and sensitive text in an encrypted 2-person room.
        Nothing is ever saved on the server.
      </p>

      <div className="home-buttons">
        <button className="btn btn-primary" onClick={onCreate} disabled={busy}>
          {busy ? <span className="spinner" /> : <LockKeyhole size={16} />}
          {busy ? 'Creating...' : 'Create Room'}
          {!busy && <ArrowRight size={15} />}
        </button>
        <button className="btn btn-secondary" onClick={onJoin}>
          <Link2 size={16} /> Join Room
        </button>
      </div>

      <div className="home-features">
        <span><ShieldCheck size={14} /> AES-256-GCM</span>
        <span><Clock3 size={14} /> 30m Auto-Expire</span>
        <span><Users size={14} /> 2-Person Only</span>
      </div>
    </section>
  );
}

function JoinPage({ code, secret, error, busy, onCodeChange, onSecretChange, onSubmit, onBack }) {
  return (
    <section className="join-card">
      <button className="back-btn" onClick={onBack}>
        <ArrowLeft size={15} /> Back
      </button>

      <h2>Join Room</h2>
      <p className="card-desc">Enter the 6-character room code and secret.</p>

      <form className="join-form" onSubmit={onSubmit}>
        <div className="form-group">
          <label htmlFor="room-code">Room Code</label>
          <input
            id="room-code"
            className="input-code"
            autoComplete="off"
            spellCheck="false"
            maxLength={10}
            placeholder="e.g. K9X2M4"
            value={code}
            onChange={(e) => onCodeChange(e.target.value.toUpperCase())}
            autoFocus
          />
        </div>

        <div className="form-group">
          <label htmlFor="room-secret">Secret</label>
          <div className="secret-wrap">
            <KeyRound size={15} className="input-icon" />
            <input
              id="room-secret"
              type="text"
              autoComplete="off"
              spellCheck="false"
              maxLength={32}
              placeholder="e.g. 7F3K9M"
              value={secret}
              onChange={(e) => onSecretChange(e.target.value)}
            />
          </div>
        </div>

        {error && <div className="form-error"><CircleAlert size={14} /> {error}</div>}

        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? <span className="spinner" /> : <LockKeyhole size={16} />}
          {busy ? 'Connecting...' : 'Join Secure Room'}
        </button>
      </form>
    </section>
  );
}

function ChatRoom({
  room,
  messages,
  connection,
  peerConnected,
  draft,
  setDraft,
  sending,
  scrollRef,
  onCopy,
  onSend,
  onDelete,
  onClear,
  onLeave,
  onEnd,
}) {
  const expiryTime = formatTime(room.expiresAt);

  return (
    <main className="chat-shell">
      <header className="chat-topbar">
        <div className="chat-left">
          <button className="brand" onClick={onLeave} aria-label="Leave room">
            <span className="brand-mark"><LockKeyhole size={16} strokeWidth={2.4} /></span>
            <span>secure<span className="brand-accent">code</span></span>
          </button>
          <div className={`status-badge status-${connection}`}>
            <span className="status-dot" />
            {connection === 'connected' ? (peerConnected ? 'Peer connected' : 'Waiting for peer') : connection}
          </div>
        </div>

        <div className="chat-center-pills">
          <button
            className="info-pill"
            onClick={() => onCopy(room.code, 'Room code copied!')}
            title="Click to copy Room Code"
          >
            <span>Room:</span>
            <strong>{room.code}</strong>
            <Copy size={13} />
          </button>

          <button
            className="info-pill"
            onClick={() => onCopy(room.secret, 'Encryption secret copied!')}
            title="Click to copy Secret"
          >
            <span>Secret:</span>
            <strong>{room.secret}</strong>
            <Copy size={13} />
          </button>

          {room.invitationUrl && (
            <button
              className="btn btn-sm btn-accent"
              onClick={() => onCopy(room.invitationUrl, 'Invite link copied!')}
              title="Copy 1-click invitation link"
            >
              <Link2 size={13} /> Copy Invite Link
            </button>
          )}
        </div>

        <div className="chat-actions">
          <span className="expiry-tag" title={`Expires at ${expiryTime}`}>
            <Clock3 size={13} /> {expiryTime}
          </span>
          <button
            className="btn btn-sm btn-ghost"
            onClick={onClear}
            disabled={!messages.length}
            title="Clear all messages"
          >
            <Trash2 size={14} /> Clear
          </button>
          <button
            className="btn btn-sm btn-ghost"
            onClick={onLeave}
            title="Leave room"
          >
            <LogOut size={14} /> Leave
          </button>
          {room.role === 'owner' && (
            <button
              className="btn btn-sm btn-danger"
              onClick={onEnd}
              title="End room for everyone"
            >
              <X size={14} /> End
            </button>
          )}
        </div>
      </header>

      {!peerConnected && (
        <div className="waiting-bar">
          <Users size={15} />
          <span>Waiting for your peer. Share Room Code <strong>{room.code}</strong> and Secret <strong>{room.secret}</strong>, or send the invite link.</span>
        </div>
      )}

      <div className="chat-feed" aria-live="polite">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <LockKeyhole size={28} className="empty-icon" />
            <h3>End-to-End Encrypted Room</h3>
            <p>Messages are encrypted directly in your browser. Nothing is stored.</p>
          </div>
        ) : (
          messages.map((m) => {
            const isOwn = m.sender === room.role;
            return (
              <div key={m.id} className={`message-row ${isOwn ? 'message-own' : 'message-peer'}`}>
                <div className="message-bubble">
                  <div className="message-header">
                    <span className="message-sender">{isOwn ? 'You' : 'Peer'}</span>
                    <span className="message-time">{formatTime(m.createdAt)}</span>
                  </div>
                  <div className="message-body">{m.text}</div>
                  <div className="message-actions">
                    <button onClick={() => onCopy(m.text, 'Copied message.')} title="Copy">
                      <Copy size={12} />
                    </button>
                    <button onClick={() => onDelete(m.id)} title="Delete for all">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={scrollRef} />
      </div>

      <form className="chat-composer" onSubmit={onSend}>
        <textarea
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, 8_000))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend(e);
            }
          }}
          placeholder={peerConnected ? 'Type an encrypted message… (Enter to send)' : 'Waiting for peer to join…'}
          disabled={!peerConnected || connection !== 'connected' || sending}
        />
        <button
          className="btn btn-primary send-btn"
          type="submit"
          disabled={!draft.trim().length || !peerConnected || connection !== 'connected' || sending}
        >
          {sending ? <span className="spinner" /> : <Send size={15} />}
        </button>
      </form>
    </main>
  );
}

function StatusPage({ icon, title, description, onBack, actionLabel, onAction, busy }) {
  return (
    <section className="status-card">
      <div className="status-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{description}</p>
      <div className="status-actions">
        {actionLabel && (
          <button className="btn btn-primary" onClick={onAction} disabled={busy}>
            {busy ? <span className="spinner" /> : actionLabel}
          </button>
        )}
        <button className="btn btn-secondary" onClick={onBack}>
          <ArrowLeft size={15} /> Back to Home
        </button>
      </div>
    </section>
  );
}

function Toast({ message }) {
  if (!message) return null;
  return (
    <div className="toast" role="status">
      <Check size={14} /> {message}
    </div>
  );
}

export default App;
