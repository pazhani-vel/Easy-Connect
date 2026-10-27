# SecureCode

SecureCode is a temporary, two-person text-sharing room. It uses a React/Vite browser client (Tailwind CSS v4 with custom responsive styles) and a Node/Express/Socket.IO relay. There is no account system or database.

## Local development

Requirements: Node.js 20.19+ and npm.

From this directory (`practice`):

```powershell
npm run install:all
Copy-Item backend\.env.example backend\.env
Copy-Item frontend\.env.example frontend\.env.local
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The backend listens on port 5000. The frontend proxies `/api` requests to it and connects to the local Socket.IO server. You can also install each package separately with `npm install --prefix backend` and `npm install --prefix frontend`.

Useful commands:

```powershell
npm test
npm run build
npm run start
```

`npm run start` starts only the backend. `npm run build` creates the static client in `frontend/dist`.

## Room and message flow

1. The backend creates a room with a random 128-bit identifier, a creator membership capability, and a separate peer membership capability. It stores only SHA-256 hashes of those capabilities.
2. The browser independently creates a 256-bit room secret. The complete invitation URL carries the room code and secret in the URL fragment; URL fragments are not sent in HTTP requests or referrer headers. The manual room code contains the peer capability, while the encryption secret is shared separately.
3. The backend validates the capability when a participant joins the Socket.IO room. A room identifier alone is not authorization. Membership capabilities are not encryption keys and are held in browser memory only. A temporary random session ID lets a reconnecting socket reclaim its membership but is not an authentication credential.
4. The client derives a non-extractable AES-256-GCM key using HKDF-SHA-256, with the public room identifier as salt and a protocol-specific context string. Each message uses a fresh 96-bit nonce from `crypto.getRandomValues()`. Version, room ID, message ID, sender role, and timestamp are authenticated as AES-GCM additional authenticated data. The Web Crypto ciphertext includes the authentication tag.
5. The backend validates envelope shape, sender membership, unique message IDs/nonces, event limits, and room membership, then relays the opaque envelope to the other connected participant. It never receives plaintext or the encryption secret/key and does not keep message history.

The client uses `textContent`-equivalent React text rendering; shared content is never interpreted as HTML. Decrypted text and the derived key live in application memory only and are released when the room view is left, as far as the browser permits. Clipboard contents are controlled by the operating system/browser and are outside the application's memory-cleanup guarantees.

## Security assumptions and limitations

- **Use HTTPS/WSS in deployment.** The app's local HTTP configuration is for localhost development only.
- Anyone possessing the full invitation URL can join as the peer. Share it through a trusted channel. The manual room code is a server membership capability; the separately shared secret provides message confidentiality.
- This is a small, auditable initial protocol, not a security certification. A compromised browser, malicious/modified JavaScript, browser extension, clipboard manager, screenshot, or participant can expose plaintext. End-to-end encryption cannot hide IP addresses, connection times, room identifiers, or traffic volume from infrastructure.
- The room key is derived once from the invitation secret; there is no ratchet or forward secrecy. Anyone who later obtains the secret and captured ciphertext can attempt to decrypt that ciphertext.
- Messages are live-only and are not replayed to someone who joins later or reconnects after missing them. Clear/delete events affect connected participants; no server-side message history exists.
- Rooms expire after 30 minutes by default. `ROOM_LIFETIME_MS` can be set from 1 ms through a maximum of 2 hours. Server restarts erase every room and disconnect active participants.
- One in-memory backend instance is the supported deployment. Multiple instances need shared room coordination, sticky sessions, and a shared Socket.IO adapter; they are not supported by this configuration.
- Rate limits use in-memory state and are not shared across instances. When behind a trusted reverse proxy, set `TRUST_PROXY=true`; do not enable it if clients can bypass that proxy.

## Configuration

Backend variables are documented in `backend/.env.example`:

- `PORT`: HTTP/Socket.IO port (default `5000`).
- `FRONTEND_ORIGINS`: comma-separated exact browser origins allowed by HTTP and Socket.IO CORS.
- `ROOM_LIFETIME_MS`: room lifetime from 1 ms to 2 hours (default 30 minutes).
- `MAX_ACTIVE_ROOMS`: maximum active rooms (default 10,000).
- `TRUST_PROXY`: set to `true` only when the backend is reached through one trusted reverse proxy.

Frontend build variables are documented in `frontend/.env.example`:

- `VITE_API_URL`: deployed backend origin for `/api` requests. Leave unset locally to use the Vite proxy.
- `VITE_SOCKET_URL`: deployed backend origin for Socket.IO. Leave unset locally to use `http://localhost:5000`.

Do not put room secrets or capabilities in environment variables, build arguments, analytics, or logs.

## Tests and build

`npm test` runs unit, integration, and security tests for backend room management, request validation, CORS/security headers, API and socket rate limits, room authorization, expiration/cleanup, reconnects, and encrypted message delivery. Browser crypto tests cover wrong secrets, room-key separation, tampering, authenticated metadata, nonce freshness, malformed envelopes, Unicode, and size limits. Use `npm run test:coverage` to produce Node's coverage report for both test suites.

`npm run build` produces the static frontend bundle. `npm run lint --prefix frontend` runs Oxlint.

## Deployment

Deploy the backend and static frontend separately:

1. **Backend:** deploy `backend` as a Node web service. `backend/render.yaml` includes a Render configuration with `/api/health` as its health check. Set `FRONTEND_ORIGINS` to the exact HTTPS frontend origin and configure the platform to provide HTTPS/WSS. Use one backend instance.
2. **Frontend:** deploy `frontend` as a Vite static site. `frontend/vercel.json` provides build/output settings and security headers for Vercel. Set `VITE_API_URL` and `VITE_SOCKET_URL` to the HTTPS backend origin in the frontend build environment, then rebuild.
3. Confirm that the frontend's Content Security Policy allows the backend's HTTPS/WSS origin and that the backend CORS origin list exactly matches the deployed frontend origin.
4. Verify `https://<backend-origin>/api/health`, then create and join a room from two separate browser contexts.

The deploy files are starting configurations, not a claim that the service is production-secure. Review hosting-provider proxy, TLS, logging, origin, and availability settings before sharing sensitive material.
