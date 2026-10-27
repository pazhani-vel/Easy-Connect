import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCheck,
  CircleAlert,
  Clock3,
  Copy,
  Fingerprint,
  KeyRound,
  Link2,
  LockKeyhole,
  LogOut,
  MessageSquareText,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  UsersRound,
  X,
} from 'lucide-react';
import { decryptMessage } from './crypto/decrypt.js';
import { encryptMessage } from './crypto/encrypt.js';
import { deriveRoomKey, randomRoomSecret } from './crypto/keyDerivation.js';
import { apiRequest, getSocketUrl } from './services/api.js';
import './App.css';

const ROOM_CODE_PATTERN = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function emitWithAck(socket, event, payload, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) {
      reject(new Error('Connection lost. Wait for reconnection and try again.'));
      return;
    }
    const timer = window.setTimeout(() => reject(new Error('The server did not respond. Please try again.')), timeoutMs);
    socket.emit(event, payload, (response) => {
      window.clearTimeout(timer);
      if (!response?.ok) reject(new Error(response?.error || 'The request could not be completed.'));
      else resolve(response);
    });
  });
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(timestamp);
}

function App() {
  const [initialInvitation] = useState(() => new URLSearchParams(
    typeof window === 'undefined' ? '' : window.location.hash.slice(1),
  ));
  const [page, setPage] = useState(() => initialInvitation.has('room') || initialInvitation.has('secret') ? 'join' : 'home');
  const [room, setRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const [connection, setConnection] = useState('disconnected');
  const [peerConnected, setPeerConnected] = useState(false);
  const [joinCode, setJoinCode] = useState(() => initialInvitation.get('room') || '');
  const [joinSecret, setJoinSecret] = useState(() => initialInvitation.get('secret') || '');
  const [joinError, setJoinError] = useState(() => (
    initialInvitation.has('room') && !initialInvitation.has('secret')
      ? 'This invitation link is incomplete. Ask the room creator for a new link.'
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
    toastTimerRef.current = window.setTimeout(() => setToast(''), 2_800);
  }

  useEffect(() => {
    if (!window.location.hash) return;
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }, []);

  useEffect(() => {
    if (!room) return undefined;
    const activeRoom = room;
    const socket = io(getSocketUrl(), {
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 700,
      reconnectionDelayMax: 5_000,
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
          setRoomError(result?.error || 'This room is no longer available.');
          setPage('unavailable');
          setRoom(null);
          return;
        }
        if (result.role !== activeRoom.role) {
          setRoomError('Room membership could not be verified. Join again using the complete room code.');
          setPage('unavailable');
          setRoom(null);
          return;
        }
        setPeerConnected(result.peerConnected);
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
        setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
      } catch {
        notify('A received message failed its integrity check and was not shown.');
      }
    });
    socket.on('message:deleted', ({ messageId }) => {
      setMessages((current) => current.filter((message) => message.id !== messageId));
    });
    socket.on('room:cleared', () => {
      setMessages([]);
      notify('Chat cleared by your peer.');
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
      const code = `${created.roomId}.${created.joinCapability}`;
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
      notify('Secure room created. Share the private invitation with your peer.');
    } catch (error) {
      setRoomError(error.message);
      setPage('connection-error');
    } finally {
      setBusy(false);
    }
  }

  async function joinRoom(event) {
    event.preventDefault();
    setJoinError('');
    const code = joinCode.trim();
    const secret = joinSecret.trim();
    if (!ROOM_CODE_PATTERN.test(code)) {
      setJoinError('Enter the complete room code, including its access suffix.');
      return;
    }
    if (!SECRET_PATTERN.test(secret)) {
      setJoinError('Enter the 32-byte room secret or open the complete invitation link.');
      return;
    }

    const [roomId, capability] = code.split('.');
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
        code,
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
      notify('Joined securely. Messages are encrypted in your browser.');
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
      notify('Clipboard access was blocked. Select and copy the text instead.');
    }
  }

  async function sendMessage(event) {
    event?.preventDefault();
    const text = draft;
    if (!room || !text.length || sending) return;
    setSending(true);
    setDraft('');
    try {
      const { envelope, serialized } = await encryptMessage(text, room.key, room.roomId, room.role);
      await emitWithAck(socketRef.current, 'message:send', {
        roomId: room.roomId,
        envelope: serialized,
      });
      setMessages((current) => [...current, { ...envelope, text }]);
      notify('Message sent securely.');
    } catch (error) {
      setDraft(text);
      notify(error.message);
    } finally {
      setSending(false);
    }
  }

  async function deleteMessage(messageId) {
    if (!window.confirm('Delete this message for everyone in the room?')) return;
    try {
      await emitWithAck(socketRef.current, 'message:delete', { roomId: room.roomId, messageId });
      setMessages((current) => current.filter((message) => message.id !== messageId));
    } catch (error) {
      notify(error.message);
    }
  }

  async function clearChat() {
    if (!messages.length) return;
    if (!window.confirm('Clear every message for both participants? This cannot be undone.')) return;
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
    if (!room || !window.confirm('End this room for everyone? The room and its invitation will stop working.')) return;
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
    <main className="app-shell min-h-screen">
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />
      <header className="topbar">
        <button className="brand" onClick={() => setPage('home')} aria-label="SecureCode home">
          <span className="brand-mark"><LockKeyhole size={19} strokeWidth={2.2} /></span>
          <span>secure<span className="brand-accent">code</span></span>
        </button>
        <div className="topbar-note"><span className="topbar-dot" /> End-to-end encrypted</div>
      </header>

      <div className="page-content">
        {page === 'home' && (
          <HomePage onCreate={createRoom} onJoin={() => { setJoinError(''); setPage('join'); }} busy={busy} />
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
            title="This room is unavailable"
            description={roomError || 'The room may have expired, been ended, or its server may have restarted.'}
            onBack={() => { setRoomError(''); setPage('home'); }}
          />
        )}
        {page === 'connection-error' && (
          <StatusPage
            icon={<CircleAlert size={24} />}
            title="Could not create a room"
            description={roomError || 'The SecureCode server could not be reached. Check the connection and try again.'}
            onBack={() => { setRoomError(''); setPage('home'); }}
            actionLabel="Try again"
            onAction={createRoom}
            busy={busy}
          />
        )}
      </div>

      <footer className="site-footer">
        <span><ShieldCheck size={14} /> No accounts. No stored messages.</span>
        <span>Rooms expire automatically after 30 minutes.</span>
      </footer>
      <Toast message={toast} />
    </main>
  );
}

function HomePage({ onCreate, onJoin, busy }) {
  return (
    <section className="home-layout">
      <div className="hero-copy">
        <div className="eyebrow"><span className="eyebrow-line" /> PRIVATE BY DESIGN</div>
        <h1>Share privately.<br /><span>Connect securely.</span></h1>
        <p className="hero-subtitle">
          Exchange passwords, API keys, and sensitive text in a private room.
          No accounts, no history, no compromise.
        </p>
        <div className="hero-actions">
          <button className="button button-primary" onClick={onCreate} disabled={busy}>
            {busy ? <span className="spinner" /> : <Plus size={18} />}
            {busy ? 'Creating room…' : 'Create secure room'}
            {!busy && <ArrowRight size={17} className="button-trailing" />}
          </button>
          <button className="button button-secondary" onClick={onJoin}>
            <Link2 size={17} /> Join existing room
          </button>
        </div>
        <div className="trust-row">
          <span><Fingerprint size={16} /> Browser-side encryption</span>
          <span><Clock3 size={16} /> Temporary by design</span>
          <span><UsersRound size={16} /> Just two people</span>
        </div>
      </div>

      <div className="hero-visual">
        <div className="visual-orbit orbit-outer" />
        <div className="visual-orbit orbit-inner" />
        <div className="visual-glow" />
        <div className="security-card">
          <div className="security-card-top">
            <div className="mini-lock"><LockKeyhole size={19} /></div>
            <div><span className="security-title">Private session</span><span className="security-subtitle">Just you and your peer</span></div>
            <span className="live-indicator"><i /> LIVE</span>
          </div>
          <div className="secure-line"><span className="line-dot violet-dot" /><span /><span /></div>
          <div className="secure-message">
            <span className="message-label">ENCRYPTED MESSAGE</span>
            <div className="cipher-text">••••••••••••••••••••••••••</div>
            <div className="message-lock"><LockKeyhole size={13} /> Only your peer can read this</div>
          </div>
          <div className="card-footer">
            <span><span className="secure-pulse" /> AES-256-GCM</span><span>End-to-end</span>
          </div>
        </div>
        <div className="floating-chip chip-one"><ShieldCheck size={14} /> Zero knowledge</div>
        <div className="floating-chip chip-two"><Sparkles size={14} /> No sign-up needed</div>
        <div className="visual-caption"><span /> Your words stay yours.</div>
      </div>

      <div className="feature-strip">
        <Feature icon={<KeyRound size={19} />} title="Encrypted in your browser" description="Your text is locked before it ever leaves your device." />
        <Feature icon={<Clock3 size={19} />} title="Nothing sticks around" description="No message history. Rooms expire automatically." />
        <Feature icon={<ShieldCheck size={19} />} title="No account needed" description="Start a private session in seconds. No personal details." />
      </div>
      <div className="privacy-note"><LockKeyhole size={15} /><span><strong>A note on privacy</strong> &nbsp; Room state is temporary and disappears if the server restarts. Anyone with the full invitation link can join.</span></div>
    </section>
  );
}

function Feature({ icon, title, description }) {
  return (
    <article className="feature-item">
      <span className="feature-icon">{icon}</span>
      <div><h2>{title}</h2><p>{description}</p></div>
    </article>
  );
}

function JoinPage({ code, secret, error, busy, onCodeChange, onSecretChange, onSubmit, onBack }) {
  return (
    <section className="form-page">
      <button className="back-link" onClick={onBack}><ArrowLeft size={16} /> Back to home</button>
      <div className="form-card">
        <div className="form-icon"><Link2 size={23} /></div>
        <div className="eyebrow form-eyebrow"><span className="eyebrow-line" /> JOIN A PRIVATE ROOM</div>
        <h1>Pick up the<br /><span>conversation.</span></h1>
        <p className="form-intro">Enter the room code and its separate encryption secret. Both are needed to join securely.</p>
        <form className="join-form" onSubmit={onSubmit}>
          <label htmlFor="room-code">Room code</label>
          <input
            id="room-code"
            autoComplete="off"
            spellCheck="false"
            placeholder="Paste the complete room code"
            value={code}
            onChange={(event) => onCodeChange(event.target.value)}
          />
          <label htmlFor="room-secret">Encryption secret</label>
          <div className="secret-input-wrap">
            <KeyRound size={16} />
            <input
              id="room-secret"
              type="password"
              autoComplete="off"
              spellCheck="false"
              placeholder="Paste the room secret"
              value={secret}
              onChange={(event) => onSecretChange(event.target.value)}
            />
          </div>
          {error && <div className="form-error" role="alert"><CircleAlert size={16} />{error}</div>}
          <button className="button button-primary form-submit" type="submit" disabled={busy}>
            {busy ? <span className="spinner" /> : <LockKeyhole size={17} />}
            {busy ? 'Joining securely…' : 'Join secure room'}
            {!busy && <ArrowRight size={17} className="button-trailing" />}
          </button>
        </form>
        <div className="form-security"><ShieldCheck size={15} /><span>Your secret stays in this browser and is never sent to the server.</span></div>
      </div>
      <div className="join-hint"><Sparkles size={15} /><span>Have an invitation link? Open it in this browser to fill in the details automatically.</span></div>
    </section>
  );
}

function ChatRoom({ room, messages, connection, peerConnected, draft, setDraft, sending, scrollRef, onCopy, onSend, onDelete, onClear, onLeave, onEnd }) {
  const statusLabels = {
    connecting: 'Connecting',
    connected: 'Connected',
    reconnecting: 'Reconnecting',
    disconnected: 'Disconnected',
  };
  const expiryTime = formatTime(room.expiresAt);

  async function copyRoomCode() {
    await onCopy(room.code, 'Room code copied. Send the secret separately.');
  }

  return (
    <main className="chat-shell">
      <header className="chat-topbar">
        <button className="brand" onClick={onLeave} aria-label="Leave SecureCode room">
          <span className="brand-mark"><LockKeyhole size={18} strokeWidth={2.2} /></span>
          <span>secure<span className="brand-accent">code</span></span>
        </button>
        <div className="chat-top-actions">
          <div className={`connection-pill connection-${connection}`}>
            <span className="connection-dot" />{statusLabels[connection]}
          </div>
          <button className="icon-button" onClick={onLeave} aria-label="Leave room" title="Leave room"><LogOut size={17} /></button>
        </div>
      </header>
      <div className="chat-main">
        <aside className="room-sidebar">
          <button className="back-link room-back" onClick={onLeave}><ArrowLeft size={15} /> Leave room</button>
          <div className="room-label"><span className="room-label-icon"><LockKeyhole size={15} /></span> SECURE ROOM</div>
          <h1>Private<br /><span>session</span></h1>
          <p className="room-description">A quiet space for your conversation. Only your invited peer can read these messages.</p>
          <div className="participants">
            <div className="participants-title">PARTICIPANTS <span>2 max</span></div>
            <div className="participant-row">
              <span className="avatar avatar-you">{room.role === 'owner' ? 'Y' : 'P'}</span>
              <span><strong>You</strong><small>Room creator</small></span><i className="presence-online" />
            </div>
            <div className="participant-row">
              <span className="avatar avatar-peer">{room.role === 'owner' ? 'P' : 'Y'}</span>
              <span><strong>Your peer</strong><small>{peerConnected ? 'In this room' : 'Waiting to connect'}</small></span>
              <i className={peerConnected ? 'presence-online' : 'presence-offline'} />
            </div>
          </div>
          <div className="room-encryption">
            <div className="encryption-heading"><ShieldCheck size={17} /> End-to-end encrypted</div>
            <p>Messages are encrypted on your device. The server only relays ciphertext.</p>
            <div className="encryption-algorithm"><span /> AES-256-GCM <span className="algorithm-divider">·</span> HKDF-SHA-256</div>
          </div>
          {room.role === 'owner' && room.invitationUrl && (
            <div className="invite-panel">
              <div className="invite-heading"><Link2 size={15} /> INVITE YOUR PEER</div>
              <p>The room code includes a separate access key. Share the encryption secret privately too.</p>
              <button className="button button-invite" onClick={() => onCopy(room.invitationUrl, 'Private invitation link copied.')}>
                <Copy size={15} /> Copy invitation link
              </button>
              <div className="manual-share">
                <span>ROOM CODE</span>
                <code>{room.code}</code>
                <button className="text-copy" onClick={copyRoomCode}><Copy size={13} /> Copy code</button>
                <span>ENCRYPTION SECRET</span>
                <code>{room.secret}</code>
                <button className="text-copy" onClick={() => onCopy(room.secret, 'Encryption secret copied. Share it separately.')}>
                  <Copy size={13} /> Copy secret
                </button>
              </div>
            </div>
          )}
          <div className="room-lifetime"><Clock3 size={15} /><span>Expires at {expiryTime}</span></div>
          <div className="sidebar-bottom">
            <button className="button button-quiet" onClick={onClear} disabled={!messages.length}><Trash2 size={15} /> Clear chat</button>
            {room.role === 'owner' && <button className="end-room-button" onClick={onEnd}><X size={15} /> End room for everyone</button>}
          </div>
        </aside>

        <section className="conversation">
          <div className="conversation-header">
            <div><div className="conversation-kicker"><span className="conversation-live" /> LIVE CONVERSATION</div><h2>Secure chat</h2></div>
            <div className="message-count"><MessageSquareText size={15} /> {messages.length} {messages.length === 1 ? 'message' : 'messages'}</div>
          </div>
          <div className="conversation-feed" aria-live="polite" aria-label="Encrypted messages">
            {!peerConnected && (
              <div className="waiting-banner"><UsersRound size={17} /><span><strong>Waiting for your peer.</strong> Send them the invitation link to start chatting.</span></div>
            )}
            {messages.length === 0 ? (
              <div className="empty-chat">
                <div className="empty-chat-icon"><MessageSquareText size={23} /></div>
                <h3>Your conversation starts here</h3>
                <p>Messages are encrypted before leaving your browser and are never saved as history.</p>
                <div className="empty-chat-tip"><ArrowDown size={14} /> Type a message below to begin</div>
              </div>
            ) : messages.map((message) => (
              <article className={`message-card ${message.sender === room.role ? 'message-own' : 'message-peer'}`} key={message.id}>
                <div className="message-meta">
                  <span className={`message-avatar ${message.sender === room.role ? 'message-avatar-you' : 'message-avatar-peer'}`}>{message.sender === room.role ? 'Y' : 'P'}</span>
                  <strong>{message.sender === room.role ? 'You' : 'Peer'}</strong>
                  <time dateTime={new Date(message.createdAt).toISOString()}>{formatTime(message.createdAt)}</time>
                </div>
                <p className="message-text">{message.text}</p>
                <div className="message-tools">
                  <button onClick={() => onCopy(message.text, 'Message copied to clipboard.')} aria-label="Copy message"><Copy size={14} /> Copy</button>
                  <button onClick={() => onDelete(message.id)} aria-label="Delete message for everyone"><Trash2 size={14} /> Delete</button>
                </div>
              </article>
            ))}
            <div ref={scrollRef} />
          </div>
          <form className="composer" onSubmit={onSend}>
            <div className="composer-topline">
              <span><LockKeyhole size={13} /> Encrypted before sending</span>
              <span>{draft.length.toLocaleString()} / 8,000</span>
            </div>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value.slice(0, 8_000))}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  onSend(event);
                }
              }}
              maxLength={8_000}
              rows={3}
              placeholder={peerConnected ? 'Write a private message…' : 'Your peer needs to join before you can send.'}
              aria-label="Message"
              disabled={!peerConnected || connection !== 'connected' || sending}
            />
            <div className="composer-bottom">
              <span>Press <kbd>Enter</kbd> to send <span className="key-divider">·</span> <kbd>Shift + Enter</kbd> for a new line</span>
              <button className="send-button" type="submit" disabled={!draft.length || !peerConnected || connection !== 'connected' || sending}>
                {sending ? <span className="spinner" /> : <Send size={15} />} Send securely
              </button>
            </div>
          </form>
          <div className="conversation-footnote"><CheckCheck size={14} /> Your shared content is never stored on the server.</div>
        </section>
      </div>
      <span className="visually-hidden" aria-live="polite">{connection === 'connected' ? 'Connected to secure room' : statusLabels[connection]}</span>
    </main>
  );
}

function StatusPage({ icon, title, description, onBack, actionLabel, onAction, busy }) {
  return (
    <section className="status-page">
      <div className="status-icon">{icon}</div>
      <div className="eyebrow"><span className="eyebrow-line" /> SECURECODE</div>
      <h1>{title}</h1>
      <p>{description}</p>
      <div className="status-actions">
        {actionLabel && <button className="button button-primary" onClick={onAction} disabled={busy}>{busy ? <span className="spinner" /> : <Plus size={17} />}{actionLabel}</button>}
        <button className="button button-secondary" onClick={onBack}><ArrowLeft size={16} /> Back to home</button>
      </div>
    </section>
  );
}

function Toast({ message }) {
  if (!message) return null;
  return <div className="toast" role="status"><Check size={16} />{message}</div>;
}

export default App;
