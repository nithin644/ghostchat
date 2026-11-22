'use client';

import type { IceServer } from '@ghostchat/shared-types';

/**
 * One canonical peer connection per call.
 *
 * Security notes that matter operationally:
 *  - `iceTransportPolicy` defaults to 'all'. Set it to 'relay' to force traffic
 *    through TURN, which is what you want when hiding participants' IPs from
 *    each other (at the cost of bandwidth and latency).
 *  - Media is DTLS-SRTP encrypted by the browser; this code never touches the
 *    media path, only SDP and ICE.
 */
export interface PeerOptions {
  iceServers: IceServer[];
  relayOnly?: boolean;
  onIce: (candidate: RTCIceCandidate) => void;
  onTrack: (stream: MediaStream) => void;
  onState: (state: RTCPeerConnectionState) => void;
}

export function createPeer(options: PeerOptions): RTCPeerConnection {
  const pc = new RTCPeerConnection({
    iceServers: options.iceServers,
    iceTransportPolicy: options.relayOnly ? 'relay' : 'all',
    bundlePolicy: 'max-bundle',
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) options.onIce(event.candidate);
  };
  pc.ontrack = (event) => {
    options.onTrack(event.streams[0] ?? new MediaStream([event.track]));
  };
  pc.onconnectionstatechange = () => options.onState(pc.connectionState);

  return pc;
}

export async function getLocalStream(video: boolean): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
  });
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}
