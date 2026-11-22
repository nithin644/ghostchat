'use client';

import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@ghostchat/shared-types';
import { API_URL } from './api';

/** /api -> same origin; absolute -> strip the /api suffix to get the socket root. */
const WS_ORIGIN = API_URL.startsWith('http') ? API_URL.replace(/\/api$/, '') : '';

export type GhostSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: GhostSocket | null = null;

/**
 * One Socket.IO connection per tab.
 *
 * Auth is the httpOnly session cookie, so there is no token in the handshake
 * payload or URL. `withCredentials` is what sends it.
 */
export function getSocket(): GhostSocket {
  if (socket) return socket;

  const origin = WS_ORIGIN || (typeof window !== 'undefined' ? window.location.origin : '');
  socket = io(origin, {
    withCredentials: true,
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    autoConnect: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelayMax: 10_000,
  }) as GhostSocket;

  return socket;
}

export function closeSocket(): void {
  socket?.disconnect();
  socket = null;
}
