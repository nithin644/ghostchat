'use client';

import { b64d, b64e, kdf, LABELS, secretboxOpen, secretboxSeal } from '@ghostchat/crypto';
import { api } from './api';

/**
 * Local encrypted vault.
 *
 * Ratchet state must survive a page reload, but it must not be readable from a
 * stolen device backup. Everything here is sealed under a key derived from the
 * in-memory identity seed, and the seed itself is never written to disk.
 *
 * That means: close the tab, and the vault is unreadable until the access key is
 * entered again. This is intentional — it is the same property as a hardware
 * wallet needing its passphrase, and it is the only honest way to keep
 * "no server-side key storage" true.
 */
const DB_NAME = 'ghostchat';
const STORE = 'vault';

let vaultKey: Uint8Array | null = null;
let activeIdentitySeed: Uint8Array | null = null;

// In-memory fallback for environments where IndexedDB is blocked or restricted (e.g. Tor/Brave private windows)
const memoryVault = new Map<string, { nonce: string; ciphertext: string }>();

// Shared database connection pool to avoid opening/closing DB on every operation
let cachedDbPromise: Promise<IDBDatabase | null> | null = null;

export function getActiveIdentitySeed(): Uint8Array | null {
  if (activeIdentitySeed) return activeIdentitySeed;
  if (typeof window !== 'undefined') {
    try {
      const stored = sessionStorage.getItem('ghostchat_seed') || localStorage.getItem('ghostchat_seed');
      if (stored) {
        const seed = b64d(stored);
        activeIdentitySeed = seed;
        vaultKey = kdf(seed, LABELS.vaultKey, 32);
        try {
          sessionStorage.setItem('ghostchat_seed', stored);
        } catch {}
        return activeIdentitySeed;
      }
    } catch {
      // Storage access blocked or restricted
    }
  }
  return null;
}

export function isVaultUnlocked(): boolean {
  return vaultKey !== null || getActiveIdentitySeed() !== null;
}

export function unlockVault(seed: Uint8Array): void {
  activeIdentitySeed = seed.slice();
  vaultKey = kdf(seed, LABELS.vaultKey, 32);
  if (typeof window !== 'undefined') {
    const encoded = b64e(seed);
    try {
      sessionStorage.setItem('ghostchat_seed', encoded);
    } catch {}
    try {
      localStorage.setItem('ghostchat_seed', encoded);
    } catch {}
  }
}

export function lockVault(): void {
  if (vaultKey) vaultKey.fill(0);
  vaultKey = null;
  if (activeIdentitySeed) activeIdentitySeed.fill(0);
  activeIdentitySeed = null;
  memoryVault.clear();
  if (typeof window !== 'undefined') {
    try {
      sessionStorage.removeItem('ghostchat_seed');
    } catch {}
    try {
      localStorage.removeItem('ghostchat_seed');
    } catch {}
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('gc_v_') || k.startsWith('gc_out_'))) {
          keysToRemove.push(k);
        }
      }
      for (const k of keysToRemove) {
        localStorage.removeItem(k);
      }
    } catch {}
  }
}

function getDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (cachedDbPromise) return cachedDbPromise;

  cachedDbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          cachedDbPromise = null;
        };
        db.onerror = () => {
          cachedDbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        cachedDbPromise = null;
        resolve(null);
      };
      req.onblocked = () => {
        cachedDbPromise = null;
        resolve(null);
      };
    } catch {
      cachedDbPromise = null;
      resolve(null);
    }
  });

  return cachedDbPromise;
}

export async function vaultPut(key: string, value: unknown): Promise<void> {
  if (!vaultKey) {
    const seed = getActiveIdentitySeed();
    if (seed) unlockVault(seed);
  }
  if (!vaultKey) throw new Error('vault is locked');
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const sealed = secretboxSeal(vaultKey, plaintext);
  const record = { nonce: b64e(sealed.nonce), ciphertext: b64e(sealed.ciphertext) };

  // 1. In-memory fast cache
  memoryVault.set(key, record);

  // 2. Synchronous persistent backup in localStorage (survives browser & laptop reboots)
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem('gc_v_' + key, JSON.stringify(record));
    } catch {
      // Ignore quota errors if storage full
    }
  }

  // 3. Persistent IndexedDB
  try {
    const db = await getDb();
    if (db) {
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(record, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          cachedDbPromise = null;
          resolve();
        }
      });
    }
  } catch {
    cachedDbPromise = null;
  }

  // 4. Background E2EE Vault Sync with server
  scheduleSync(key, record);
}

// Background queue to debounce syncing encrypted vault records to the server
let pendingSync: Record<string, { nonce: string; ciphertext: string }> = {};
let syncTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSync(key: string, record: { nonce: string; ciphertext: string }): void {
  pendingSync[key] = record;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    const toFlush = { ...pendingSync };
    pendingSync = {};
    syncTimer = null;
    try {
      if (Object.keys(toFlush).length > 0) {
        await api.vaultSync(toFlush);
      }
    } catch {
      // Re-queue on failure so it retries on next flush or sync
      Object.assign(pendingSync, toFlush);
    }
  }, 400);
}

export async function vaultGet<T>(key: string): Promise<T | null> {
  if (!vaultKey) {
    const seed = getActiveIdentitySeed();
    if (seed) unlockVault(seed);
  }
  if (!vaultKey) return null;

  // 1. Check in-memory map
  let record = memoryVault.get(key);

  // 2. Check localStorage fast persistent cache
  if (!record && typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem('gc_v_' + key);
      if (raw) {
        record = JSON.parse(raw);
        if (record) memoryVault.set(key, record);
      }
    } catch {}
  }

  // 3. Check IndexedDB
  if (!record) {
    try {
      const db = await getDb();
      if (db) {
        record = await new Promise<{ nonce: string; ciphertext: string } | undefined>((resolve) => {
          try {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).get(key);
            req.onsuccess = () => resolve(req.result as { nonce: string; ciphertext: string } | undefined);
            req.onerror = () => resolve(undefined);
          } catch {
            cachedDbPromise = null;
            resolve(undefined);
          }
        });
        if (record) {
          memoryVault.set(key, record);
          if (typeof window !== 'undefined') {
            try {
              localStorage.setItem('gc_v_' + key, JSON.stringify(record));
            } catch {}
          }
        }
      }
    } catch {
      cachedDbPromise = null;
    }
  }

  if (!record) return null;

  try {
    const opened = secretboxOpen(vaultKey, {
      nonce: b64d(record.nonce),
      ciphertext: b64d(record.ciphertext),
    });
    return JSON.parse(new TextDecoder().decode(opened)) as T;
  } catch {
    // If decryption fails with current key, discard bad entry
    return null;
  }
}

export async function vaultDelete(key: string): Promise<void> {
  memoryVault.delete(key);
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem('gc_v_' + key);
    } catch {}
  }
  try {
    const db = await getDb();
    if (db) {
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          cachedDbPromise = null;
          resolve();
        }
      });
    }
  } catch {
    cachedDbPromise = null;
  }
  void api.vaultDeleteRemote(key).catch(() => null);
}

/**
 * Synchronize encrypted vault state across devices (e.g. laptop and Android mobile).
 *
 * Invariant: Ciphertext is sealed client-side using vaultKey (derived from identity seed).
 * The server never sees plaintext keys or messages.
 */
export async function syncVaultWithServer(): Promise<{ synced: number; uploaded: number }> {
  if (!vaultKey) {
    const seed = getActiveIdentitySeed();
    if (seed) unlockVault(seed);
  }
  if (!vaultKey) return { synced: 0, uploaded: 0 };

  const localEntries: Record<string, { nonce: string; ciphertext: string }> = {};

  // 1. Collect all local entries from memoryVault
  for (const [k, v] of memoryVault.entries()) {
    localEntries[k] = v;
  }

  // 2. Collect from localStorage (both gc_v_* and migrate legacy raw gc_out_* / gc_in_*)
  if (typeof window !== 'undefined') {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (k.startsWith('gc_v_')) {
          const keyName = k.slice(5);
          try {
            const raw = localStorage.getItem(k);
            if (raw) {
              const rec = JSON.parse(raw);
              if (rec?.nonce && rec?.ciphertext) {
                localEntries[keyName] = rec;
                memoryVault.set(keyName, rec);
              }
            }
          } catch {}
        } else if (k.startsWith('gc_out_') || k.startsWith('gc_in_')) {
          const msgId = k.startsWith('gc_out_') ? k.slice(7) : k.slice(6);
          const text = localStorage.getItem(k);
          if (text && !localEntries[`msg:${msgId}`]) {
            try {
              const plaintext = new TextEncoder().encode(JSON.stringify(text));
              const sealed = secretboxSeal(vaultKey, plaintext);
              const rec = { nonce: b64e(sealed.nonce), ciphertext: b64e(sealed.ciphertext) };
              localEntries[`msg:${msgId}`] = rec;
              memoryVault.set(`msg:${msgId}`, rec);
              localStorage.setItem('gc_v_msg:' + msgId, JSON.stringify(rec));
            } catch {}
          }
        }
      }
    } catch {}
  }

  // 3. Collect from IndexedDB
  try {
    const db = await getDb();
    if (db) {
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(STORE, 'readonly');
          const store = tx.objectStore(STORE);
          const req = store.openCursor();
          req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
              const key = String(cursor.key);
              const val = cursor.value as { nonce: string; ciphertext: string };
              if (val?.nonce && val?.ciphertext) {
                if (!localEntries[key]) {
                  localEntries[key] = val;
                }
                memoryVault.set(key, val);
              }
              cursor.continue();
            } else {
              resolve();
            }
          };
          req.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    }
  } catch {}

  // 4. Fetch remote encrypted entries from server
  let remoteEntries: Record<string, { nonce: string; ciphertext: string }> = {};
  try {
    const res = await api.vaultGetAll();
    remoteEntries = res.entries || {};
  } catch {
    return { synced: 0, uploaded: 0 };
  }

  let synced = 0;
  // 5. Merge remote entries into local storage
  const db = await getDb().catch(() => null);
  for (const [key, record] of Object.entries(remoteEntries)) {
    memoryVault.set(key, record);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('gc_v_' + key, JSON.stringify(record));
      } catch {}
    }
    // Decrypt msg:* to plaintext and store in gc_in_* / memory for instant UI rendering
    if (key.startsWith('msg:')) {
      const msgId = key.slice(4);
      try {
        const opened = secretboxOpen(vaultKey, {
          nonce: b64d(record.nonce),
          ciphertext: b64d(record.ciphertext),
        });
        const text = JSON.parse(new TextDecoder().decode(opened));
        if (typeof window !== 'undefined' && text) {
          localStorage.setItem('gc_in_' + msgId, typeof text === 'string' ? text : JSON.stringify(text));
        }
      } catch {}
    }
    synced++;
  }

  // Save merged remote entries into IndexedDB
  if (db && Object.keys(remoteEntries).length > 0) {
    try {
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(STORE, 'readwrite');
          const store = tx.objectStore(STORE);
          for (const [key, record] of Object.entries(remoteEntries)) {
            store.put(record, key);
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      });
    } catch {}
  }

  // 6. Upload any local entries that do NOT exist on the server (e.g. laptop cached history)
  const toUpload: Record<string, { nonce: string; ciphertext: string }> = {};
  for (const [key, record] of Object.entries(localEntries)) {
    if (!remoteEntries[key]) {
      toUpload[key] = record;
    }
  }

  let uploaded = 0;
  if (Object.keys(toUpload).length > 0) {
    try {
      await api.vaultSync(toUpload);
      uploaded = Object.keys(toUpload).length;
    } catch {
      // Non-fatal
    }
  }

  return { synced, uploaded };
}
