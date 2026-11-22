# 👻 GhostChat

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg?logo=typescript)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-14.2-black.svg?logo=next.js)](https://nextjs.org/)
[![NestJS](https://img.shields.io/badge/NestJS-10.0-E0234E.svg?logo=nestjs)](https://nestjs.com/)
[![E2EE](https://img.shields.io/badge/Security-Signal%20Protocol%20(Double%20Ratchet)-00FF66.svg)](#cryptography--security-architecture)
[![Tor Onion](https://img.shields.io/badge/Network-Tor%20v3%20Hidden%20Service-7D4698.svg?logo=tor-browser)](https://www.torproject.org/)
[![Cloudflare Tunnel](https://img.shields.io/badge/Tunnel-Cloudflare%20Zero%20Trust-F38020.svg?logo=cloudflare)](https://www.cloudflare.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **GhostChat** is an air-tight, private messenger engineered for high-assurance, surveillance-resistant communication. It combines the familiar user experience of WhatsApp with zero-knowledge, invite-only cryptographic authentication, military-grade end-to-end encryption (Signal Protocol: X3DH + Double Ratchet), peer-to-peer WebRTC voice/video/screen streaming, push-to-talk walkie-talkie, and automated dual-stack publishing over **Tor Hidden Services (.onion)** and **Public Cloudflare Tunnels**.

---

## 📑 Table of Contents

- [Architectural Overview](#-architectural-overview)
- [Demo & Screenshots](#-demo--screenshots)
- [Key Features](#-key-features)
  - [Zero-Knowledge Identity & Authentication](#1-zero-knowledge-identity--authentication)
  - [Next-Gen WhatsApp Experience & 5 Curated Themes](#2-next-gen-whatsapp-experience--5-curated-themes)
  - [Interactive Real-Time FX Commands (/bomb, /fire, /love)](#3-interactive-real-time-fx-commands-bomb-fire-love)
  - [Voice Notes, Walkie-Talkie & Media](#4-voice-notes-walkie-talkie--media)
  - [P2P Encrypted Calls & Screen Sharing](#5-p2p-encrypted-calls--screen-sharing)
  - [WhatsApp-Style Group Architecture](#6-whatsapp-style-group-architecture)
  - [Administration & Fleet Console](#7-administration--fleet-console)
  - [One-Click Production Launch & Stylized Banner](#8-one-click-production-launch--stylized-banner)
- [End-to-End Cryptography & Security](#-end-to-end-cryptography--security)
  - [Identity & Key Derivation](#identity--key-derivation)
  - [1:1 Messaging (X3DH + Double Ratchet)](#11-messaging-x3dh--double-ratchet)
  - [Group Cryptography (Sender Keys)](#group-cryptography-sender-keys)
  - [Sealed Sender (Metadata Minimization)](#sealed-sender-metadata-minimization)
  - [Streaming Media AEAD](#streaming-media-aead)
- [Repository Structure](#-repository-structure)
- [Prerequisites & System Requirements](#-prerequisites--system-requirements)
- [Quick Start & Installation](#-quick-start--installation)
  - [Production Deploy (One-Command Automated)](#method-a-automated-production-deploy-recommended)
  - [Local Development Setup](#method-b-local-development-setup)
- [System Workflow](#-system-workflow)
- [Configuration Reference (.env)](#-configuration-reference-env)
- [Threat Model & Security Invariants](#-threat-model--security-invariants)
- [Verification & Testing](#-verification--testing)
- [License](#-license)

---

## 🏛 Architectural Overview

```
                      ┌──────────────────────────────────────────────┐
                      │             Clients & Browsers               │
                      │  (WebCrypto / WASM E2EE Keys in IndexedDB)   │
                      └──────────────┬───────────────────────────────┘
                                     │
           ┌─────────────────────────┴────────────────────────┐
           ▼                                                  ▼
 ┌──────────────────────┐                           ┌────────────────────┐
 │  Cloudflare Tunnel   │                           │  Tor v3 (.onion)   │
 │ (Public Clearnet)    │                           │ (Onion Routing)    │
 └─────────┬────────────┘                           └─────────┬──────────┘
           │                                                  │
           └─────────────────────────┬────────────────────────┘
                                     │
                             ┌───────▼────────┐
                             │  onion-proxy   │  Single-origin reverse proxy
                             │     :8080      │  (Binds Tor, HTTP & Sockets)
                             └───────┬────────┘
                                     │
                   ┌─────────────────┴─────────────────┐
                   │                                   │
             /api, /ws │                               │ / (Web Assets)
                   ▼                                   ▼
        ┌─────────────────────┐             ┌─────────────────────┐
        │     NestJS API      │             │     Next.js Web     │
        │       :4000         │             │        :3000        │
        └──────────┬──────────┘             └─────────────────────┘
                   │
         ┌─────────┴─────────┐
         ▼                   ▼
   ┌───────────┐       ┌───────────┐        ┌─────────────────────────────┐
   │PostgreSQL │       │   Redis   │        │ Encrypted Media Blob Store  │
   │ (Schema-  │       │(Ephemeral │◄──────►│ (Local Disk or S3 Bucket;   │
   │  level    │       │ sessions, │        │  only ciphertext stored)    │
   │  privacy) │       │ pub/sub,  │        └─────────────────────────────┘
   └───────────┘       │ rate-lim) │
                       └───────────┘
```

---

## 📸 Demo & Screenshots

<div align="center">
  <h3>✨ Desktop Chat & E2EE Secure Messaging</h3>
  <p><i>Full WhatsApp-style conversational interface with reactions, reply quote threads, and verified contact identification.</i></p>
  <!-- Replace the placeholder URL below with your screenshot URL -->
  <img src="https://via.placeholder.com/1200x675.png?text=GhostChat+Desktop+Interface" alt="GhostChat Desktop Interface" width="900" />
</div>

<br/>

<div align="center">
  <table border="0" cellspacing="10" cellpadding="8">
    <tr>
      <td width="50%" align="center">
        <b>💥 Interactive FX Reactions (/bomb, /fire, /love)</b><br/>
        <sub>Screen shake, synchronized particle explosions & audio synthesis</sub><br/><br/>
        <!-- Replace the placeholder URL below with your screenshot URL -->
        <img src="https://via.placeholder.com/600x400.png?text=Interactive+Slash+FX+Reactions" alt="Interactive Slash FX Reactions" width="420" />
      </td>
      <td width="50%" align="center">
        <b>🎨 5 Curated Themes & Instant Switching</b><br/>
        <sub>Midnight Obsidian, Executive Slate, Nordic Minimalist, Hacker & Normal</sub><br/><br/>
        <!-- Replace the placeholder URL below with your screenshot URL -->
        <img src="https://via.placeholder.com/600x400.png?text=5+Curated+Themes+Showcase" alt="5 Curated Themes Showcase" width="420" />
      </td>
    </tr>
    <tr>
      <td width="50%" align="center">
        <b>🎙️ Walkie-Talkie & Waveform Voice Notes</b><br/>
        <sub>Live PTT intercom with audio visualizer and waveform recorder</sub><br/><br/>
        <!-- Replace the placeholder URL below with your screenshot URL -->
        <img src="https://via.placeholder.com/600x400.png?text=Walkie-Talkie+and+Voice+Notes" alt="Walkie Talkie and Voice Note" width="420" />
      </td>
      <td width="50%" align="center">
        <b>📱 Responsive Mobile View</b><br/>
        <sub>Optimized for mobile Chrome, Safari, and Tor Browser</sub><br/><br/>
        <!-- Replace the placeholder URL below with your screenshot URL -->
        <img src="https://via.placeholder.com/600x400.png?text=Responsive+Mobile+Chat" alt="Mobile Chat Experience" width="420" />
      </td>
    </tr>
    <tr>
      <td width="50%" align="center">
        <b>📹 E2EE Video Calling & Screen Share</b><br/>
        <sub>WebRTC encrypted video streaming & live desktop broadcast</sub><br/><br/>
        <!-- Replace the placeholder URL below with your screenshot URL -->
        <img src="https://via.placeholder.com/600x400.png?text=Video+Call+and+Screen+Share" alt="Video Call & Screen Share" width="420" />
      </td>
      <td width="50%" align="center">
        <b>👥 WhatsApp Groups & Invites</b><br/>
        <sub>2-step group creator with member roster & invite management</sub><br/><br/>
        <!-- Replace the placeholder URL below with your screenshot URL -->
        <img src="https://via.placeholder.com/600x400.png?text=Group+Management+and+Invites" alt="Group Management and Invites" width="420" />
      </td>
    </tr>
    <tr>
      <td width="50%" align="center">
        <b>🛡️ Fleet Administration Console</b><br/>
        <sub>Access key minting, user verification, and account controls</sub><br/><br/>
        <!-- Replace the placeholder URL below with your screenshot URL -->
        <img src="https://via.placeholder.com/600x400.png?text=Admin+Fleet+Dashboard" alt="Admin Fleet Dashboard" width="420" />
      </td>
      <td width="50%" align="center">
        <b>🚀 Stylized Startup Banner (run.sh)</b><br/>
        <sub>Gradient ASCII art, developer tagline & clean dual-stack URLs</sub><br/><br/>
        <!-- Replace the placeholder URL below with your screenshot URL -->
        <img src="https://via.placeholder.com/600x400.png?text=GhostChat+Terminal+Startup+Banner" alt="Terminal Startup Banner" width="420" />
      </td>
    </tr>
  </table>
</div>

---

## ✨ Key Features

### 1. Zero-Knowledge Identity & Authentication
- **No Phone Numbers, No Emails, No User Tracking**: Accounts are strictly anchored to 100-bit cryptographic access keys (`GHOST-XXXXX-XXXXX-XXXXX-XXXXX`).
- **Deterministic Key Derivation**: Private identity keys are derived in-memory on the client via **Argon2id** and **BLAKE2b**.
- **Challenge-Response Login**: The access key is **never transmitted** over the wire. Authentication is conducted using Ed25519 digital signatures.

### 2. Next-Gen WhatsApp Experience & 5 Curated Themes
- **WhatsApp UI / UX**: Clean, intuitive interface with 5 adaptable, handcrafted themes:
  - **Normal** 🌿: Authentic WhatsApp classic green with soft light panels.
  - **Midnight Obsidian** 🌌: Sleek OLED charcoal dark mode with royal indigo/violet accents and flawless deep dark surfaces.
  - **Executive** 💼: Dark professional corporate slate navy with refined royal blue accents.
  - **Nordic Minimalist** ❄️: Crisp, ultra-clean daylight theme with sapphire blue accents.
  - **Hacker** ⚡: Cyberpunk Matrix terminal neon green (`#00FF66`) on pitch black.
- **Header Profile Bar & One-Click Logout**:
  - Prominent, user-friendly **Logout** button with confirmation modal that safely clears cryptographic vault memory, keys, and cookies.
  - Instant theme dropdown switcher right in the top navigation bar.
- **Copy, Reply & Forward**:
  - **1-Click Copy**: Instant clipboard copying with fallback and toast feedback.
  - **Contextual Reply**: Floating quote preview bar, input autofocus, and click-to-scroll navigation that smoothly highlights original messages.
  - **Smart Forwarding**: Full WhatsApp-style forward modal to search, select chats/contacts, and forward with a `↪ Forwarded` tag.
- **Message Reactions**: Fast emoji reaction picker with aggregate badge counters.
- **3-Digit Numeric User IDs**: Quick-find identifiers (e.g. `987`, `781`) for instant contact lookup and friend requests.

### 3. Interactive Real-Time FX Commands (`/bomb`, `/fire`, `/love`)
- **Synchronized Full-Screen Effects**: Type command directly in chat; triggers an interactive sensory animation on both your screen and the recipient's screen simultaneously with zero message pollution:
  - 💣 **`/bomb`**: Bomb drop trajectory, realistic screen shake, synthesized explosion blast audio, shockwave rings, and smoke particle physics.
  - 🔥 **`/fire`**: Roaring flame wall, upward rising ember sparks, blazing fire sound effect, screen edge glow, and "🔥 ON FIRE! 🔥" banner.
  - 💖 **`/love`**: Cascading 3D floating hearts fountain, romantic harp arpeggio chimes, ambient heartbeat pulse, and "💖 WITH LOVE 💖" banner (strictly timed to 2.0s).
- **Haptic Feedback**: Integrates device vibration API on supported mobile browsers.

### 4. Voice Notes, Walkie-Talkie & Media
- **Walkie-Talkie (Push-to-Talk / PTT)**: Ultra-low-latency real-time voice intercom between peers with dynamic audio spectrum analysis. Hold to talk, release to listen.
- **Voice Notes**: WhatsApp-style audio recorder with interactive waveform visualization, recording timer, and variable playback speeds (1x, 1.5x, 2x).
- **Client-Side Media Encryption**: Photos, videos, voice recordings, and documents are encrypted using XChaCha20-Poly1305 before upload.

### 5. P2P Encrypted Calls & Screen Sharing
- **1:1 Audio & Video Calls**: WebRTC peer-to-peer connection with DTLS-SRTP end-to-end encryption.
- **Live Desktop Screen Sharing**: Broadcast your screen in real time with toggleable microphone audio, camera switching, and picture-in-picture minimization so you can chat while sharing.

### 6. WhatsApp-Style Group Architecture
- **2-Step Group Creator**: Select contacts via searchable chips, define group title/avatar emoji, and initiate invites.
- **Group Requests & Invites**: Non-admin users receive incoming invitations in the **REQUESTS** tab with **Accept** and **Decline** options.
- **Member Roster & Admin Controls**: Group info drawer displaying participant counts, "Group Admin" badges, "+ Add Members" drawer, member removal, and exit controls.

### 7. Administration & Fleet Console
- **Admin Dashboard (`/admin`)**: Clean control plane for network operators.
- **Access Key Minting**: Generate batch invite keys with 1-click **"Copy All Keys"** or individual copy.
- **User Management**: Inspect public key fingerprints, contact codes, IP telemetry, and reassign 3-digit User IDs.
- **Ban & Permanent Deletion**: 1-click ban permanently purges user data, direct conversations, message ciphertexts, and terminates all active sessions.

### 8. One-Click Production Launch & Stylized Banner
- **Single Master Script (`./run.sh`)**: Automatically checks dependencies, boots PostgreSQL and Redis containers, generates Prisma client, compiles typescript packages, spins up Tor onion services, and generates public Cloudflare tunnels.
- **Noise-Free Stylized Terminal**: Silences background build chatter and prints a 24-bit multi-gradient ASCII banner (`Developed By Nithin Palegar>`) along with formatted URL boxes for public, LAN, and onion access.

---

## 🔐 End-to-End Cryptography & Security

GhostChat implements the complete **Signal Protocol** specification inside an isolated, framework-agnostic package (`@ghostchat/crypto`).

### Identity & Key Derivation
1. The user possesses a 100-bit entropy access key: `GHOST-XXXXX-XXXXX-XXXXX-XXXXX`.
2. A public locator (`contactCode`) is derived via **BLAKE2b-128**.
3. A 32-byte cryptographic seed is generated client-side via **Argon2id** (64 MiB memory, 3 iterations) using a 16-byte server salt.
4. From the root seed, two key pairs are derived:
   - **Ed25519**: Identity Signing Key (used for challenge-response auth and signing pre-keys).
   - **X25519**: Identity Diffie-Hellman Key (used in X3DH key agreements).

```
Access Key (GHOST-...)
   │
   ├─ BLAKE2b-128 ────────────────────────► Contact Code (Public Locator)
   │
   └─ Argon2id(salt, 64MiB, 3) ────────────► 32-Byte Master Seed
                                               │
                         ┌─────────────────────┴─────────────────────┐
                         ▼                                           ▼
                 Ed25519 Signing Key                         X25519 DH Key
```

### 1:1 Messaging (X3DH + Double Ratchet)
- **Extended Triple Diffie-Hellman (X3DH)**: Establishes a shared secret between parties even when one user is offline, utilizing signed pre-keys and one-time pre-keys.
- **Double Ratchet Algorithm**:
  - **KDF Chain Ratchet**: Symmetric ratchet generates new message keys for each transmission. Old chain keys are immediately wiped from memory (Forward Secrecy).
  - **DH Ratchet**: An ephemeral X25519 exchange occurs every round-trip, healing the ratchet if previous ephemeral keys were compromised (Break-in Recovery / Post-Compromise Security).
  - **Out-of-Order Handling**: Securely buffers skipped message keys up to 512 iterations.
  - **AEAD Binding**: The encoded ratchet header is bound as Associated Data (AD) into the AEAD ciphertext, eliminating replay, header tampering, or splice attacks.

### Group Cryptography (Sender Keys)
- Groups utilize **Sender Key** distribution. Each member maintains an independent symmetric chain and an Ed25519 signing key.
- Messages are encrypted once and broadcast to all members, ensuring high performance without sacrificing message authenticity.
- Group secrets are established client-side via invite verification, rotating whenever members are removed.

### Sealed Sender (Metadata Minimization)
- To prevent the server from reconstructing social graphs, `Message.senderPseudoId` is stored as **`NULL`** in the database for sealed envelopes.
- The sender's identity is packed inside a `crypto_box_seal` envelope decryptable only by the recipient.

### Streaming Media AEAD
- Attachments are processed in 64 KiB chunks using `crypto_secretstream_xchacha20poly1305`.
- Chunk indexes are bound into the authenticated cipher stream; truncation, reordering, or bit flips result in immediate authentication rejection.

---

## 📂 Repository Structure

```
ghostchat/
├── run.sh                          # Master production deployment script
├── docker-compose.yml              # Container definitions (PostgreSQL, Redis, Coturn)
├── package.json                    # Workspace monorepo root
├── packages/
│   ├── shared-types/               # DTOs, socket events, interfaces & enums
│   └── crypto/                     # Standalone audited cryptography package
│       ├── src/keys.ts             #   Access keys, Argon2id, pre-key bundles
│       ├── src/x3dh.ts             #   X3DH cryptographic handshake
│       ├── src/doubleRatchet.ts    #   Double Ratchet state machine
│       ├── src/senderKey.ts        #   Group sender key management
│       ├── src/sealedSender.ts     #   Sealed sender envelope encryption
│       ├── src/media.ts            #   Streaming file encryption
│       └── test/crypto.test.ts     #   Cryptographic test suite
├── apps/
│   ├── api/                        # NestJS Core API (Port 4000)
│   │   ├── prisma/schema.prisma    #   Privacy-first database schema
│   │   └── src/
│   │       ├── auth/               #   Challenge-response authentication
│   │       ├── chat/               #   Chat gateway, messages & conversations
│   │       ├── groups/             #   WhatsApp-style group coordination
│   │       ├── calls/              #   WebRTC signaling & ICE token minting
│   │       ├── media/              #   Signed upload/download blob handlers
│   │       └── admin/              #   Fleet management, key minting & user controls
│   └── web/                        # Next.js 14 Frontend (Port 3000)
│       └── src/
│           ├── app/                #   App router (Chat, Onboarding, Admin)
│           ├── components/         #   ChatWindow, ChatList, CallOverlay, Modals
│           └── lib/                #   Client E2EE state, WebRTC, Audio & IndexedDB Vault
└── infra/
    ├── onion-proxy.mjs             # Zero-dependency Tor/HTTP reverse proxy (Port 8080)
    └── coturn/turnserver.conf      # Secure STUN/TURN configuration
```

---

## 💻 Prerequisites & System Requirements

- **Operating System**: Linux (Ubuntu, Debian, Kali, Arch, Fedora) or macOS.
- **Node.js**: `v20.x` or higher (with `npm 10+`).
- **Docker**: Docker Engine & Docker Compose (for PostgreSQL and Redis).
- **Tor**: (Optional) For automated `.onion` hidden service generation.
- **cloudflared**: (Optional) Automatically downloaded by `run.sh` for public Chrome access.

---

## 🚀 Quick Start & Installation

### Method A: Automated Production Deploy (Recommended)

The easiest and fastest way to deploy GhostChat. One command configures dependencies, initializes databases, compiles packages, generates Tor hidden services, and establishes public Cloudflare tunnels.

```bash
# 1. Clone the repository
git clone https://github.com/nithin644/ghostchat.git
cd ghostchat

# 2. Grant execution permissions
chmod +x run.sh

# 3. Launch GhostChat (runs prerequisite checks & installs dependencies)
sudo -E ./run.sh
```

Once started, the console outputs your live access endpoints:

```
======================================================================
  GhostChat & Apache are live (Public & Chrome Accessible)
======================================================================

  🌐 PUBLIC INTERNET ACCESS (Open in Chrome / Safari / Edge)
  GhostChat Web       https://random-words.trycloudflare.com
  GhostChat Admin     https://random-words.trycloudflare.com/admin

  🏠 LOCAL NETWORK (Same Wi-Fi / LAN)
  GhostChat LAN       http://192.168.1.100:8080

  🧅 TOR HIDDEN SERVICE (.onion)
  GhostChat Onion     http://ahpjtjearxsez7bqf...25rd4dl56dadh4gzxsqd.onion

  Stop Service:       sudo -E ./run.sh --stop
======================================================================
```

#### Step 4: Mint Your First Admin Key
Because GhostChat is strictly invite-only, mint your first access key:

```bash
# In the ghostchat root directory:
set -a; . ./.env; set +a
npx tsx apps/api/scripts/seed-admin.ts
```

Open the printed URL in your browser, paste the access key at `/onboarding`, set your display name, and you are live!

---

### Method B: Local Development Setup

For developers modifying frontend or backend code:

```bash
# 1. Copy environment template
cp .env.example .env

# 2. Start PostgreSQL and Redis containers
docker compose up -d postgres redis

# 3. Install dependencies
npm install

# 4. Generate Prisma client & apply database schema
npx prisma generate --schema apps/api/prisma/schema.prisma
npx prisma db push --schema apps/api/prisma/schema.prisma

# 5. Build core packages
npm run build -w @ghostchat/shared-types
npm run build -w @ghostchat/crypto

# 6. Start development servers (API on :4000, Web on :3000)
npm run dev
```

---

## 🔄 System Workflow

```mermaid
sequenceDiagram
    autonumber
    actor Admin
    actor Alice
    actor Bob
    participant Server as GhostChat API / Relay
    participant DB as PostgreSQL / Redis

    Note over Admin,Server: 1. Provisioning
    Admin->>Server: Mint Access Key (GHOST-XXXXX-...)
    Server->>DB: Store hashed contactCode & verifier
    Admin-->>Alice: Securely distributes Access Key

    Note over Alice,Server: 2. Onboarding & Claiming
    Alice->>Alice: Derive seed & KeyPairs via Argon2id
    Alice->>Server: Submit PreKeyBundle + Claim Verifier
    Server->>DB: Store Public Keys & delete Verifier

    Note over Alice,Bob: 3. Session Initiation (X3DH)
    Alice->>Server: Request Bob's PreKey Bundle
    Server-->>Alice: Returns Bob's Public PreKeys
    Alice->>Alice: Perform X3DH & Initialize Double Ratchet
    Alice->>Server: Send First E2EE Message with Prelude Header
    Server->>Bob: Deliver Ciphertext & Prelude

    Note over Bob,Alice: 4. Continuous Double Ratchet
    Bob->>Bob: Derive shared secret from Prelude
    Bob->>Bob: Advance Symmetric & DH Ratchet
    Bob-->>Server: Reply with new DH Ephemeral Key & Ciphertext
    Server-->>Alice: Forward Encrypted Message
```

---

## ⚙️ Configuration Reference (.env)

| Variable | Description | Default |
|:---|:---|:---|
| `PORT` | Proxy port binding for onion-proxy | `8080` |
| `API_PORT` | Port for NestJS backend | `4000` |
| `WEB_PORT` | Port for Next.js frontend | `3000` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://ghostchat:ghostchat@127.0.0.1:5432/ghostchat` |
| `REDIS_URL` | Redis cache and session URL | `redis://127.0.0.1:6379` |
| `MEDIA_DRIVER` | Media storage engine (`local` or `s3`) | `local` |
| `MEDIA_DIR` | Directory for local encrypted blobs | `.ghostchat-state/media` |
| `S3_BUCKET` | AWS / S3-compatible bucket name | `ghostchat-media` |
| `COOKIE_SECURE` | Enforce HTTPS-only cookie transmission | `true` (false for Tor .onion) |
| `TURN_URLS` | STUN/TURN server URLs for WebRTC | `stun:stun.l.google.com:19302` |
| `TURN_SHARED_SECRET`| Shared HMAC secret for Coturn | Generated at runtime |

---

## 🛡 Threat Model & Security Invariants

### What GhostChat Protects Against

| Threat Vector | Mitigation Strategy & Invariant |
|:---|:---|
| **Compromised Server Operator** | Zero server plaintext. Messages, media, voice notes, and keys are encrypted client-side. |
| **Database Theft / Seizure** | Ciphertext-only at rest. Access keys are not stored (only BLAKE2b locators). |
| **Social Graph Analysis** | **Sealed Sender**: Message rows have `senderPseudoId = NULL`. Transport tags are server-blind. |
| **Passive Network Eavesdropping** | All transport is routed over Tor v3 or Cloudflare TLS tunnels. |
| **Key Compromise** | **Forward Secrecy**: Old message keys are erased upon ratchet advance. |
| **Device Seizure** | Client-side vault in IndexedDB encrypted with keys derived in-memory. |
| **Message Tampering & Replay** | AEAD headers bound as Associated Data; duplicate counters rejected. |

### Operational Assumptions
1. **Endpoint Integrity**: If an attacker installs malware or keyloggers on the physical client device, local memory can be inspected.
2. **Metadata Minimization**: While message content and sender authorship are sealed, delivery routing metadata exists temporarily in Redis memory to route packets to connected WebSockets.

---

## 🧪 Verification & Testing

GhostChat includes a rigorous test suite validating cryptographic correctness and security invariants:

```bash
# Run standalone cryptographic property tests
npm test -w @ghostchat/crypto

# Run TypeScript compilation checks across all workspaces
npm run build -w @ghostchat/shared-types
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json
```

**Test Coverage Highlights:**
- Access key entropy (100 bits) and Crockford Base32 typo repair.
- Deterministic Argon2id identity derivation.
- X3DH handshake and tamper detection.
- Bidirectional Double Ratchet key rotation and forward secrecy.
- Out-of-order delivery and skipped-key memory bounds.
- Replay attack rejection.
- Streaming XChaCha20-Poly1305 media chunk ordering and authentication.

---

## 📄 License

GhostChat is open-source software released under the [MIT License](LICENSE).

---

<div align="center">
  <sub>Engineered for absolute privacy. No backdoors. No surveillance.</sub>
</div>
