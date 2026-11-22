'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  b64d,
  b64e,
  bundleTranscript,
  deriveOneTimePreKeys,
  deriveSignedPreKey,
  deriveContactCode,
  deriveClaimVerifier,
  deriveIdentity,
  isValidAccessKey,
  normalizeAccessKey,
  ready,
  signBundle,
  signDetached,
  utf8,
  type IdentityKeyPair,
  type PublicPreKeyBundle,
} from '@ghostchat/crypto';
import { api } from '../../lib/api';
import { unlockVault, vaultPut } from '../../lib/vault';
import { setUser } from '../../store/sessionSlice';
import { useAppDispatch } from '../../store/hooks';
import type { PublicUser } from '@ghostchat/shared-types';

type Stage = 'key' | 'profile' | 'working';

const ONE_TIME_KEY_COUNT = 50;

/**
 * Onboarding.
 *
 * Two paths converge here:
 *  - returning user: key -> challenge -> sign -> session
 *  - new user:       key -> challenge -> generate identity + pre-keys -> claim
 *
 * The access key is never sent anywhere. What travels is the *contact code*
 * (a one-way hash of the key, safe to publish) and, at claim time, a verifier
 * derived from the key that the server compares against a stored hash.
 */
export default function OnboardingPage() {
  const router = useRouter();
  const dispatch = useAppDispatch();

  const [accessKey, setAccessKey] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [stage, setStage] = useState<Stage>('key');
  const [error, setError] = useState<string | null>(null);
  const [needsClaim, setNeedsClaim] = useState(false);

  const finish = (user: PublicUser) => {
    dispatch(setUser(user));
    router.replace('/chat');
  };

  const login = async (key: string) => {
    const normalized = normalizeAccessKey(key);
    if (!isValidAccessKey(normalized)) {
      setError('That is not a valid access key. Expected GHOST-XXXXX-XXXXX-XXXXX-XXXXX.');
      return;
    }

    setStage('working');
    setError(null);

    try {
      await ready();
      const contactCode = await deriveContactCode(normalized);
      const challenge = await api.challenge(contactCode);

      // Derive the identity from the key + the server's public salt. This is the
      // Argon2id step: intentionally slow, and it happens only on the device.
      const identity = await deriveIdentity(normalized, b64d(challenge.identitySalt));

      if (!challenge.claimed) {
        setNeedsClaim(true);
        setStage('profile');
        // Hold the identity for the claim step without putting it in React state
        // (state is inspectable by extensions; a closure is not).
        pending.current = { normalized, contactCode, challengeId: challenge.challengeId, identity };
        return;
      }

      const signature = signDetached(
        utf8(['ghostchat/login/v1', contactCode, challenge.challenge].join('|')),
        identity.sign.privateKey,
      );

      const session = await api.verify({
        contactCode,
        challengeId: challenge.challengeId,
        signature: b64e(signature),
      });

      unlockVault(identity.seed);
      const spk = deriveSignedPreKey(identity, 1);
      const otpks = deriveOneTimePreKeys(identity.seed, 1, 50);
      await vaultPut('prekeys', {
        signedPreKey: {
          keyId: spk.keyId,
          publicKey: b64e(spk.keyPair.publicKey),
          privateKey: b64e(spk.keyPair.privateKey),
        },
        oneTimePreKeys: otpks.map((k) => ({
          keyId: k.keyId,
          publicKey: b64e(k.keyPair.publicKey),
          privateKey: b64e(k.keyPair.privateKey),
        })),
      }).catch(() => null);
      await vaultPut('identity', {
        seed: b64e(identity.seed),
        contactCode,
      });
      finish(session.user);
    } catch (e) {
      setStage('key');
      setError(e instanceof Error ? e.message : 'Sign-in failed');
    }
  };

  const pending = useRef<{
    normalized: string;
    contactCode: string;
    challengeId: string;
    identity: IdentityKeyPair;
  } | null>(null);

  const claim = async () => {
    const state = pending.current;
    if (!state) return;
    if (displayName.trim().length < 2) {
      setError('Display name must be at least 2 characters.');
      return;
    }

    setStage('working');
    setError(null);

    try {
      const spk = deriveSignedPreKey(state.identity, 1);
      const otpks = deriveOneTimePreKeys(state.identity.seed, 1, ONE_TIME_KEY_COUNT);

      const bundle: PublicPreKeyBundle = {
        identityDhPublicKey: state.identity.dh.publicKey,
        identitySignPublicKey: state.identity.sign.publicKey,
        signedPreKey: { keyId: spk.keyId, publicKey: spk.keyPair.publicKey, signature: spk.signature },
        oneTimePreKey: null,
      };
      const bundleSignature = signBundle(bundle, state.identity);

      // The claim proof is a signature over a canonical transcript that the API
      // rebuilds byte-for-byte. Field order is fixed on both sides.
      const transcript = utf8(
        [
          'ghostchat/claim/v1',
          state.contactCode,
          state.challengeId,
          displayName.trim(),
          '',
          b64e(state.identity.sign.publicKey),
          b64e(state.identity.dh.publicKey),
          String(spk.keyId),
          b64e(spk.keyPair.publicKey),
          b64e(spk.signature),
          b64e(bundleSignature),
          otpks.slice().sort((a, b) => a.keyId - b.keyId).map((k) => `${k.keyId}:${b64e(k.keyPair.publicKey)}`).join(','),
        ].join('|'),
      );
      void bundleTranscript; // documented on both sides; kept for parity checks

      // Note: the challenge value itself must be included. The server stored it
      // with the challenge id, so we re-fetch it here to avoid trusting state.
      const fresh = await api.challenge(state.contactCode);
      const proof = signDetached(
        utf8(
          [
            'ghostchat/claim/v1',
            state.contactCode,
            fresh.challenge,
            displayName.trim(),
            '',
            b64e(state.identity.sign.publicKey),
            b64e(state.identity.dh.publicKey),
            String(spk.keyId),
            b64e(spk.keyPair.publicKey),
            b64e(spk.signature),
            b64e(bundleSignature),
            otpks.slice().sort((a, b) => a.keyId - b.keyId).map((k) => `${k.keyId}:${b64e(k.keyPair.publicKey)}`).join(','),
          ].join('|'),
        ),
        state.identity.sign.privateKey,
      );

      const verifier = await deriveClaimVerifier(state.normalized);

      const session = await api.claim({
        contactCode: state.contactCode,
        challengeId: fresh.challengeId,
        displayName: displayName.trim(),
        identitySignPublicKey: b64e(state.identity.sign.publicKey),
        identityDhPublicKey: b64e(state.identity.dh.publicKey),
        signedPreKey: {
          keyId: spk.keyId,
          publicKey: b64e(spk.keyPair.publicKey),
          signature: b64e(spk.signature),
        },
        oneTimePreKeys: otpks.map((k) => ({ keyId: k.keyId, publicKey: b64e(k.keyPair.publicKey) })),
        bundleSignature: b64e(bundleSignature),
        verifier,
        proof: b64e(proof),
      });

      unlockVault(state.identity.seed);

      // Private pre-keys must live on the device: without them a responder
      // cannot complete X3DH for inbound first messages.
      await vaultPut('prekeys', {
        signedPreKey: {
          keyId: spk.keyId,
          publicKey: b64e(spk.keyPair.publicKey),
          privateKey: b64e(spk.keyPair.privateKey),
        },
        oneTimePreKeys: otpks.map((k) => ({
          keyId: k.keyId,
          publicKey: b64e(k.keyPair.publicKey),
          privateKey: b64e(k.keyPair.privateKey),
        })),
      });
      await vaultPut('identity', {
        seed: b64e(state.identity.seed),
        contactCode: state.contactCode,
      });

      finish(session.user);
    } catch (e) {
      setStage('profile');
      setError(e instanceof Error ? e.message : 'Could not claim that key');
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-wa-panel px-4">
      <div className="w-full max-w-md rounded-xl bg-white p-7 shadow-sm ring-1 ring-black/5">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-wa-green text-lg font-bold text-white">
            G
          </div>
          <div>
            <h1 className="text-lg font-semibold text-black/85">GhostChat</h1>
            <p className="text-xs text-black/40">No phone number. No email. Just a key.</p>
          </div>
        </div>

        {error && (
          <p className="mb-4 rounded bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-100">
            {error}
          </p>
        )}

        {stage === 'profile' ? (
          <div className="space-y-4">
            <div>
              <label className="text-xs font-medium uppercase tracking-wide text-black/40">
                Display name
              </label>
              <input
                autoFocus
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={24}
                placeholder="How others will see you"
                className="mt-1 w-full rounded-lg border border-black/10 bg-white px-3 py-2.5 text-sm text-[#111B21] caret-[#128C7E] placeholder:text-[#667781] outline-none focus:border-wa-green"
              />
              <p className="mt-1 text-[11px] text-black/35">
                Visible to people you chat with. Not linked to any real identity.
              </p>
            </div>
            <button
              onClick={claim}
              className="w-full rounded-lg bg-wa-green py-2.5 text-sm font-semibold text-white hover:bg-wa-greenDark"
            >
              Claim this key
            </button>
            <p className="text-center text-[11px] text-black/35">
              Your private keys are generated here and never leave this device.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="text-xs font-medium uppercase tracking-wide text-black/40">
                Access key
              </label>
              <input
                autoFocus
                value={accessKey}
                onChange={(e) => setAccessKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void login(accessKey)}
                placeholder="GHOST-XXXXX-XXXXX-XXXXX-XXXXX"
                spellCheck={false}
                autoComplete="off"
                className="mt-1 w-full rounded-lg border border-black/10 bg-white px-3 py-2.5 font-mono text-sm text-[#111B21] caret-[#128C7E] tracking-wider placeholder:text-[#667781] outline-none focus:border-wa-green"
              />
              <p className="mt-1 text-[11px] text-black/35">
                Keys are case-insensitive; I, L and O are read as 1 and 0.
              </p>
            </div>

            <button
              onClick={() => void login(accessKey)}
              disabled={stage === 'working'}
              className="w-full rounded-lg bg-wa-green py-2.5 text-sm font-semibold text-white hover:bg-wa-greenDark disabled:opacity-60"
            >
              {stage === 'working' ? 'Deriving keys…' : 'Continue'}
            </button>

            <p className="text-center text-[11px] leading-relaxed text-black/35">
              Deriving your identity takes a moment by design: Argon2id is deliberately
              expensive so a stolen database cannot be brute-forced.
            </p>
          </div>
        )}

        {needsClaim && stage === 'profile' && (
          <p className="mt-4 rounded bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            This key has never been used. Setting a display name claims it permanently.
          </p>
        )}
      </div>
    </main>
  );
}
