'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AdminKeyRow, AdminStats, AdminUserRow, CreateAccessKeysResponse } from '@ghostchat/shared-types';
import { api } from '../lib/api';

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const points = values
    .map((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * 100;
      const y = 28 - (value / max) * 26;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <svg viewBox="0 0 100 30" className="h-10 w-full" preserveAspectRatio="none" aria-hidden>
      <polyline points={points} fill="none" stroke="#25D366" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="admin-card-enter rounded-lg border border-admin-line bg-admin-panel p-4 transition duration-300 hover:-translate-y-1 hover:border-emerald-500/20 hover:bg-[#151F28] hover:shadow-[0_12px_30px_rgba(0,0,0,0.18)]">
      <p className="text-[11px] uppercase tracking-widest text-white/40">{label}</p>
      <p className="mt-1 font-mono text-2xl text-white">{value}</p>
      {hint && <p className="mt-1 text-[11px] text-white/35">{hint}</p>}
    </div>
  );
}

export function AdminDashboard({ onBack, onLogout }: { onBack: () => void; onLogout?: () => void }) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [keys, setKeys] = useState<AdminKeyRow[]>([]);
  const [minted, setMinted] = useState<CreateAccessKeysResponse | null>(null);
  const [count, setCount] = useState(5);
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [copiedText, setCopiedText] = useState<string | null>(null);

  const handleCopy = (text: string, label: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      } else {
        const el = document.createElement('textarea');
        el.value = text;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
      }
      setCopiedText(label);
      setTimeout(() => setCopiedText(null), 2000);
    } catch {
      // ignore
    }
  };
  const [editingUser, setEditingUser] = useState<AdminUserRow | null>(null);
  const [newNumericId, setNewNumericId] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [editSuccess, setEditSuccess] = useState<string | null>(null);
  const [savingId, setSavingId] = useState(false);

  // Admin credentials state
  const [adminUsername, setAdminUsername] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [credentialMessage, setCredentialMessage] = useState<string | null>(null);
  const [adminCredentialList, setAdminCredentialList] = useState<Array<{ id: number; username: string; createdAt: string }>>([]);
  const [selectedCredentialId, setSelectedCredentialId] = useState<number | null>(null);
  const [newAdminUsername, setNewAdminUsername] = useState('');
  const [newAdminPassword, setNewAdminPassword] = useState('');

  const handleOpenEdit = (user: AdminUserRow) => {
    setEditingUser(user);
    setNewNumericId(user.numericId || '');
    setEditError(null);
  };

  const handleSaveId = async () => {
    if (!editingUser) return;
    const trimmed = newNumericId.trim();
    if (!/^\d{3}$/.test(trimmed)) {
      setEditError('User ID must be exactly 3 digits (e.g. 100-999)');
      return;
    }
    setSavingId(true);
    setEditError(null);
    try {
      await api.adminUpdateNumericId(editingUser.pseudoId, trimmed);
      setEditSuccess(`User ID for ${editingUser.displayName} updated to ${trimmed}`);
      setEditingUser(null);
      await refresh();
      setTimeout(() => setEditSuccess(null), 3000);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : 'Failed to update User ID');
    } finally {
      setSavingId(false);
    }
  };

  const refresh = useCallback(async () => {
    try {
      const [s, u, k] = await Promise.all([api.adminStats(), api.adminUsers(), api.adminKeys()]);
      setStats(s);
      setUsers(u);
      setKeys(k);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load admin data');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const mint = async () => {
    setBusy(true);
    try {
      const result = await api.adminMint({ count, label: label || undefined });
      setMinted(result);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'mint failed');
    } finally {
      setBusy(false);
    }
  };

  const loadAdminCredentials = async () => {
    try {
      const value = await api.adminCredentials();
      setAdminCredentialList(value.credentials);
      if (selectedCredentialId === null && value.credentials.length > 0) {
        setSelectedCredentialId(value.credentials[0].id);
        setAdminUsername(value.credentials[0].username);
      }
    } catch {
      // Credential loading is non-critical to dashboard metrics.
    }
  };

  useEffect(() => {
    void loadAdminCredentials();
  }, []);

  const updateCredentials = async () => {
    if (newPassword !== confirmPassword) {
      setCredentialMessage('New passwords do not match');
      return;
    }
    try {
      if (selectedCredentialId === null) throw new Error('Select an admin credential first');
      const result = await api.updateAdminCredentials({
        credentialId: selectedCredentialId,
        currentPassword,
        username: adminUsername,
        newPassword,
      });
      setAdminUsername(result.username);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setCredentialMessage('Admin credentials updated');
    } catch (e) {
      setCredentialMessage(e instanceof Error ? e.message : 'Could not update credentials');
    }
  };

  const createAdminAccount = async () => {
    try {
      await api.createAdminCredential({
        username: newAdminUsername,
        password: newAdminPassword,
      });
      setNewAdminUsername('');
      setNewAdminPassword('');
      setCredentialMessage('New admin credential created');
      await loadAdminCredentials();
    } catch (e) {
      setCredentialMessage(e instanceof Error ? e.message : 'Could not create admin credential');
    }
  };

  const removeAdminAccount = async (credentialId: number) => {
    if (!window.confirm('Remove this admin login credential?')) return;
    try {
      await api.deleteAdminCredential(credentialId);
      setCredentialMessage('Admin credential removed');
      await loadAdminCredentials();
    } catch (e) {
      setCredentialMessage(e instanceof Error ? e.message : 'Could not remove admin credential');
    }
  };

  const scrollToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="h-screen overflow-y-auto scroll-smooth bg-admin-bg text-white/90">
      <header className="sticky top-0 z-40 border-b border-admin-line/90 bg-admin-bg/95 px-4 py-3 shadow-[0_8px_30px_rgba(0,0,0,0.18)] backdrop-blur-xl md:px-6">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold md:text-lg">GhostChat · Control Plane</h1>
            <p className="mt-0.5 text-[10px] uppercase tracking-widest text-white/35">Administration dashboard</p>
          </div>
          <nav className="order-3 flex w-full gap-1 overflow-x-auto md:order-none md:w-auto" aria-label="Dashboard sections">
            {[
              ['overview', 'Overview'],
              ['admin-keys', 'Access keys'],
              ['admin-users', 'Users'],
              ['admin-security', 'Security'],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => scrollToSection(id)}
                className="shrink-0 rounded-full border border-admin-line px-3 py-1.5 text-xs text-white/60 transition duration-200 hover:-translate-y-0.5 hover:border-emerald-500/30 hover:bg-emerald-500/10 hover:text-emerald-300"
              >
                {label}
              </button>
            ))}
          </nav>
          <button
            onClick={onBack}
            className="rounded-lg border border-admin-line px-3 py-1.5 text-xs text-white/70 transition hover:border-white/20 hover:bg-white/5"
          >
            Back to chat
          </button>
          {onLogout && (
            <button
              type="button"
              onClick={onLogout}
              className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-300 transition hover:border-red-400/50 hover:bg-red-500/20"
            >
              Log out
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] space-y-6 px-4 py-5 pb-10 md:px-6 md:py-6">
        {error && (
          <div className="rounded border border-red-500/40 bg-red-500/10 px-4 py-2 text-xs text-red-300">
            {error}
          </div>
        )}

        <section id="overview" className="scroll-mt-28 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Users" value={String(stats?.users.total ?? '—')} hint={`${stats?.users.active24h ?? 0} active 24h`} />
          <Stat label="Messages" value={String(stats?.messages.total ?? '—')} hint={`${stats?.messages.last24h ?? 0} in 24h`} />
          <Stat label="Keys unclaimed" value={String(stats?.keys.unclaimed ?? '—')} hint={`${stats?.keys.revoked ?? 0} revoked`} />
          <Stat label="Sessions" value={String(stats?.sessions.active ?? '—')} hint="live Redis sessions" />
          <Stat
            label="Storage"
            value={`${((stats?.storage.bytes ?? 0) / 1e6).toFixed(1)} MB`}
            hint={`${stats?.storage.objects ?? 0} ciphertext objects`}
          />
        </section>

        <section className="grid gap-3 lg:grid-cols-3">
          <div className="rounded-lg border border-admin-line bg-admin-panel p-4 lg:col-span-2">
            <div className="mb-2 flex items-baseline justify-between">
              <p className="text-[11px] uppercase tracking-widest text-white/40">Message volume</p>
              <p className="font-mono text-xs text-white/50">
                {stats?.messages.lastHour ?? 0}/h · {stats?.messages.perMinute.at(-1) ?? 0}/min
              </p>
            </div>
            <Sparkline values={stats?.messages.perMinute ?? []} />
          </div>

          <div className="rounded-lg border border-admin-line bg-admin-panel p-4">
            <p className="mb-2 text-[11px] uppercase tracking-widest text-white/40">Server health</p>
            <dl className="space-y-1 font-mono text-xs text-white/60">
              <div className="flex justify-between"><dt>uptime</dt><dd>{Math.floor((stats?.server.uptimeSeconds ?? 0) / 60)}m</dd></div>
              <div className="flex justify-between"><dt>rss</dt><dd>{((stats?.server.memoryRssBytes ?? 0) / 1e6).toFixed(0)} MB</dd></div>
              <div className="flex justify-between"><dt>postgres</dt><dd>{stats?.server.dbLatencyMs ?? 0} ms</dd></div>
              <div className="flex justify-between"><dt>redis</dt><dd>{stats?.server.redisLatencyMs ?? 0} ms</dd></div>
              <div className="flex justify-between"><dt>version</dt><dd>{stats?.server.version ?? '—'}</dd></div>
            </dl>
          </div>
        </section>

        <section id="admin-keys" className="scroll-mt-28 rounded-lg border border-admin-line bg-admin-panel transition duration-300 hover:border-emerald-500/20">
          <div className="flex flex-wrap items-end gap-3 border-b border-admin-line px-4 py-3">
            <div>
              <p className="text-[11px] uppercase tracking-widest text-white/40">Mint access keys</p>
              <p className="text-[11px] text-white/30">Plaintext keys are shown once. Nothing derivable is stored.</p>
            </div>
            <div className="ml-auto flex items-end gap-2">
              <label className="text-[11px] text-white/40">
                count
                <input
                  type="number"
                  min={1}
                  max={25}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                  className="ml-1 w-16 rounded bg-admin-bg px-2 py-1 font-mono text-xs text-white outline-none ring-1 ring-admin-line"
                />
              </label>
              <label className="text-[11px] text-white/40">
                label
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="batch-a"
                  className="ml-1 w-28 rounded bg-admin-bg px-2 py-1 text-xs text-white outline-none ring-1 ring-admin-line"
                />
              </label>
              <button
                onClick={mint}
                disabled={busy}
                className="rounded bg-admin-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              >
                {busy ? 'minting…' : 'Generate'}
              </button>
            </div>
          </div>

          {minted && (
            <div className="border-b border-admin-line bg-black/40 px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[11px] uppercase tracking-widest text-amber-300/80">
                  Copy these access keys now — they cannot be recovered once claimed
                </p>
                <button
                  type="button"
                  onClick={() =>
                    handleCopy(
                      minted.keys.map((k) => k.accessKey).join('\n'),
                      'All Access Keys',
                    )
                  }
                  className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 font-mono text-[11px] text-emerald-300 hover:bg-emerald-500/20 transition"
                >
                  {copiedText === 'All Access Keys' ? '✓ Copied All!' : 'Copy All Keys'}
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {minted.keys.map((k) => (
                  <button
                    key={k.accessKey}
                    type="button"
                    onClick={() => handleCopy(k.accessKey, k.accessKey)}
                    className="flex items-center gap-1.5 rounded border border-emerald-500/30 bg-black/60 px-2 py-1 font-mono text-xs text-emerald-300 hover:border-emerald-400 hover:bg-emerald-500/10 transition"
                    title="Click to copy access key"
                  >
                    <span>{k.accessKey}</span>
                    <span className="text-[10px] text-emerald-400/70">
                      {copiedText === k.accessKey ? '✓' : '📋'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-admin-panel text-[10px] uppercase tracking-widest text-white/35">
                <tr>
                  <th className="px-4 py-2">contact code</th>
                  <th className="px-4 py-2">label</th>
                  <th className="px-4 py-2">status</th>
                  <th className="px-4 py-2">claimant</th>
                  <th className="px-4 py-2">created</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="font-mono">
                {keys.map((key) => (
                  <tr key={key.id} className="border-t border-admin-line/60">
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        onClick={() => handleCopy(key.contactCode, `Contact Code ${key.contactCode.slice(0, 8)}…`)}
                        className="rounded border border-white/10 bg-white/5 px-2 py-0.5 text-white/60 hover:text-white hover:bg-white/10 transition"
                        title="Click to copy full contact code"
                      >
                        {key.contactCode.slice(0, 16)}… 📋
                      </button>
                    </td>
                    <td className="px-4 py-2 text-white/40">{key.label ?? '—'}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          key.status === 'CLAIMED'
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : key.status === 'REVOKED'
                              ? 'bg-red-500/15 text-red-300'
                              : 'bg-white/10 text-white/50'
                        }`}
                      >
                        {key.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-white/40">{key.claimant?.displayName ?? '—'}</td>
                    <td className="px-4 py-2 text-white/30">{new Date(key.createdAt).toLocaleDateString()}</td>
                    <td className="px-4 py-2 text-right">
                      {key.status !== 'REVOKED' && (
                        <button
                          onClick={async () => {
                            if (!window.confirm('Revoke this key and ban its account?')) return;
                            await api.adminRevoke(key.id);
                            await refresh();
                          }}
                          className="rounded border border-red-500/30 px-2 py-0.5 text-[10px] text-red-300 hover:bg-red-500/10"
                        >
                          revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {keys.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-6 text-center text-white/30">
                      no keys minted yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {editSuccess && (
          <div className="rounded border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-300">
            {editSuccess}
          </div>
        )}

        {copiedText && (
          <div className="fixed bottom-6 right-6 z-50 rounded-lg border border-emerald-500/40 bg-admin-panel px-4 py-2 font-mono text-xs text-emerald-300 shadow-2xl animate-in fade-in slide-in-from-bottom-2">
            ✓ Copied {copiedText} to clipboard
          </div>
        )}

        <section id="admin-users" className="scroll-mt-28 rounded-lg border border-admin-line bg-admin-panel transition duration-300 hover:border-sky-500/20">
          <div className="border-b border-admin-line px-4 py-3 flex items-center justify-between">
            <p className="text-[11px] uppercase tracking-widest text-white/40">Active users (anonymous identities & IP tracking)</p>
            <p className="text-[10px] text-white/40">
              Note: E2EE private keys stay exclusively on user devices. Public fingerprints & locators are shown below.
            </p>
          </div>
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-admin-panel text-[10px] uppercase tracking-widest text-white/35">
                <tr>
                  <th className="px-4 py-2">user id</th>
                  <th className="px-4 py-2">display name</th>
                  <th className="px-4 py-2">pseudo id</th>
                  <th className="px-4 py-2">public key fingerprint</th>
                  <th className="px-4 py-2">contact code</th>
                  <th className="px-4 py-2">accessing ip</th>
                  <th className="px-4 py-2">status</th>
                  <th className="px-4 py-2">chats</th>
                  <th className="px-4 py-2">msgs 30d</th>
                  <th className="px-4 py-2">last seen</th>
                  <th className="px-4 py-2 text-right">actions</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {users.map((user) => (
                  <tr key={user.pseudoId} className="border-t border-admin-line/60 hover:bg-white/[0.02]">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-emerald-300 font-bold">
                          {user.numericId || '---'}
                        </span>
                        <button
                          onClick={() => handleOpenEdit(user)}
                          className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-500/20 transition"
                          title="Edit 3-digit User ID"
                        >
                          Edit
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-white/80 font-sans font-medium">
                      {user.displayName}
                    </td>
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        onClick={() => handleCopy(user.pseudoId, `Pseudo ID for ${user.displayName}`)}
                        className="max-w-32 truncate rounded border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[10px] text-white/60 hover:text-white hover:bg-white/10 transition"
                        title="Click to copy Pseudo ID"
                      >
                        {user.pseudoId.slice(0, 14)}… 📋
                      </button>
                    </td>
                    <td className="px-4 py-2">
                      {user.keyFingerprint ? (
                        <button
                          type="button"
                          onClick={() => handleCopy(user.keyFingerprint, `Public Key Fingerprint for ${user.displayName}`)}
                          className="max-w-36 truncate rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] text-emerald-300 hover:bg-emerald-500/20 transition"
                          title="Click to copy Public Key Fingerprint (Ed25519)"
                        >
                          {user.keyFingerprint} 📋
                        </button>
                      ) : (
                        <span className="text-white/30">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {user.accessKeyCode ? (
                        <button
                          type="button"
                          onClick={() => handleCopy(user.accessKeyCode ?? '', `Contact Code for ${user.displayName}`)}
                          className="max-w-36 truncate rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] text-emerald-300 hover:bg-emerald-500/20 transition"
                          title="Click to copy Contact Code"
                        >
                          {user.accessKeyCode.slice(0, 14)}… 📋
                        </button>
                      ) : (
                        <span className="text-white/30">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <span className="rounded border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[11px] font-mono text-sky-300">
                        {user.lastIp || '127.0.0.1'}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-white/40">{user.status}</td>
                    <td className="px-4 py-2 text-white/40">{user.conversationCount}</td>
                    <td className="px-4 py-2 text-white/40">{user.messages30d}</td>
                    <td className="px-4 py-2 text-white/30">
                      {user.lastSeenAt ? new Date(user.lastSeenAt).toLocaleTimeString() : 'never'}
                    </td>
                    <td className="px-4 py-2 text-right flex items-center justify-end gap-1.5">
                      <button
                        onClick={async () => {
                          if (
                            !window.confirm(
                              `Permanently delete and ban ${user.displayName}? All their data, messages, and sessions will be deleted immediately.`,
                            )
                          )
                            return;
                          try {
                            await api.adminBan(user.pseudoId);
                            setEditSuccess(`User ${user.displayName} has been permanently deleted.`);
                            await refresh();
                            setTimeout(() => setEditSuccess(null), 3500);
                          } catch (e) {
                            setError(e instanceof Error ? e.message : 'Failed to delete user');
                          }
                        }}
                        className="rounded border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-300 hover:bg-red-500/20 transition"
                        title="Delete and ban user"
                      >
                        Ban / Delete
                      </button>
                      <button
                        onClick={async () => {
                          await api.adminUpdateVerified(user.pseudoId, !user.isVerified);
                          await refresh();
                        }}
                        className={`rounded border px-2 py-0.5 text-[10px] transition ${
                          user.isVerified
                            ? 'border-sky-400/50 bg-sky-500/20 text-sky-200 hover:bg-sky-500/30'
                            : 'border-sky-500/30 text-sky-300 hover:bg-sky-500/10'
                        }`}
                        title={user.isVerified ? 'Remove blue verification tick' : 'Give blue verification tick'}
                      >
                        {user.isVerified ? '✓ Verified' : 'Verify'}
                      </button>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-4 py-6 text-center text-white/30">
                      no accounts yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Edit Numeric ID Modal */}
        {editingUser && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <div className="w-full max-w-sm rounded-xl border border-admin-line bg-admin-panel p-6 shadow-2xl">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white">Edit User ID</h3>
                <button
                  onClick={() => setEditingUser(null)}
                  className="rounded-full p-1 text-white/40 hover:bg-white/10 hover:text-white"
                >
                  ✕
                </button>
              </div>

              <p className="mb-3 text-xs text-white/50">
                Change the 3-digit User ID for <span className="font-semibold text-white">{editingUser.displayName}</span>:
              </p>

              {editError && (
                <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
                  {editError}
                </div>
              )}

              <div className="space-y-3">
                <div>
                  <label className="block text-[11px] font-medium uppercase tracking-wider text-white/40 mb-1">
                    3-Digit User ID (100–999)
                  </label>
                  <input
                    autoFocus
                    type="text"
                    maxLength={3}
                    value={newNumericId}
                    onChange={(e) => setNewNumericId(e.target.value.replace(/\D/g, ''))}
                    placeholder="482"
                    className="w-full rounded-lg border border-admin-line bg-black/40 px-3 py-2 font-mono text-base font-bold text-emerald-300 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 tracking-widest text-center"
                  />
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setEditingUser(null)}
                    className="flex-1 rounded-lg border border-admin-line py-2 text-xs font-medium text-white/60 hover:bg-white/5"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={savingId || newNumericId.length !== 3}
                    onClick={handleSaveId}
                    className="flex-1 rounded-lg bg-emerald-600 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 transition"
                  >
                    {savingId ? 'Saving…' : 'Save ID'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Update Admin Credentials */}
        <section id="admin-security" className="scroll-mt-28 rounded-lg border border-emerald-500/30 bg-admin-panel ring-1 ring-emerald-500/10">
          <div className="border-b border-emerald-500/20 px-4 py-3">
            <p className="text-[11px] uppercase tracking-widest text-emerald-300/80">Admin credentials · Change username or password</p>
          </div>
          <div className="px-4 py-3">
            {credentialMessage && (
              <div className="mb-3 rounded border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-300">
                {credentialMessage}
              </div>
            )}
            <div className="space-y-3">
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-wider text-white/40 mb-1">
                  Username
                </label>
                <input
                  type="text"
                  value={adminUsername}
                  onChange={(e) => setAdminUsername(e.target.value)}
                  className="w-full rounded-lg border border-admin-line bg-black/40 px-3 py-2 font-mono text-base text-white outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-wider text-white/40 mb-1">
                  Current Password
                </label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full rounded-lg border border-admin-line bg-black/40 px-3 py-2 font-mono text-base text-white outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-wider text-white/40 mb-1">
                  New Password
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full rounded-lg border border-admin-line bg-black/40 px-3 py-2 font-mono text-base text-white outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-wider text-white/40 mb-1">
                  Confirm New Password
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full rounded-lg border border-admin-line bg-black/40 px-3 py-2 font-mono text-base text-white outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                />
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  onClick={updateCredentials}
                  disabled={busy}
                  className="flex-1 rounded-lg bg-emerald-600 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 transition"
                >
                  {busy ? 'Updating…' : 'Update Credentials'}
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Admin Credential Management */}
        <section className="rounded-lg border border-admin-line bg-admin-panel">
          <div className="border-b border-admin-line px-4 py-3">
            <p className="text-[11px] uppercase tracking-widest text-white/40">Admin credential management</p>
          </div>
          <div className="px-4 py-3">
            <div className="mb-4 grid gap-3 lg:grid-cols-2">
              <div className="rounded-lg border border-admin-line bg-black/20 p-3">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-white/40">Admin accounts</p>
                <div className="space-y-2">
                  {adminCredentialList.map((credential) => (
                    <div key={credential.id} className="flex items-center justify-between gap-2 rounded border border-white/5 px-2 py-2">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedCredentialId(credential.id);
                          setAdminUsername(credential.username);
                          setCurrentPassword('');
                          setNewPassword('');
                          setConfirmPassword('');
                        }}
                        className={`min-w-0 flex-1 text-left text-xs font-mono ${selectedCredentialId === credential.id ? 'text-emerald-300' : 'text-white/60 hover:text-white'}`}
                      >
                        {credential.username}
                      </button>
                      {adminCredentialList.length > 1 && (
                        <button
                          type="button"
                          onClick={() => void removeAdminAccount(credential.id)}
                          className="rounded border border-red-500/30 px-2 py-1 text-[10px] text-red-300 hover:bg-red-500/10"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-admin-line bg-black/20 p-3">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-white/40">Add another admin</p>
                <input
                  type="text"
                  value={newAdminUsername}
                  onChange={(e) => setNewAdminUsername(e.target.value)}
                  placeholder="New admin username"
                  className="mb-2 w-full rounded border border-admin-line bg-black/40 px-3 py-2 text-xs text-white outline-none focus:border-emerald-500"
                />
                <input
                  type="password"
                  value={newAdminPassword}
                  onChange={(e) => setNewAdminPassword(e.target.value)}
                  placeholder="New admin password (8+ characters)"
                  className="mb-2 w-full rounded border border-admin-line bg-black/40 px-3 py-2 text-xs text-white outline-none focus:border-emerald-500"
                />
                <button
                  type="button"
                  onClick={() => void createAdminAccount()}
                  disabled={newAdminUsername.trim().length < 3 || newAdminPassword.length < 8}
                  className="w-full rounded bg-emerald-600 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  Create Admin Login
                </button>
              </div>
            </div>
          </div>
          <div className="max-h-60 overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-admin-panel text-[10px] uppercase tracking-widest text-white/35">
                <tr>
                  <th className="px-4 py-2">ID</th>
                  <th className="px-4 py-2">Username</th>
                  <th className="px-4 py-2">Created At</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {adminCredentialList.map((credential) => (
                  <tr key={credential.id} className="border-t border-admin-line/60 hover:bg-white/[0.02]">
                    <td className="px-4 py-2 text-white/60">{credential.id}</td>
                    <td className="px-4 py-2 text-white/80 font-sans font-medium">
                      {credential.username}
                    </td>
                    <td className="px-4 py-2 text-white/30">
                      {new Date(credential.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => removeAdminAccount(credential.id)}
                        className="rounded border border-red-500/30 px-2 py-0.5 text-[10px] text-red-300 hover:bg-red-500/10"
                        title="Remove admin credential"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {adminCredentialList.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-white/30">
                      no admin credentials found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
