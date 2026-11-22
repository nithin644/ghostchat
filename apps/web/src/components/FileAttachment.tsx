'use client';

import { useEffect, useState } from 'react';
import {
  decryptBlob,
  descriptorToKeyMaterial,
  decodeMediaDescriptor,
  type MediaDescriptor,
} from '@ghostchat/crypto';
import { api, resolveApiUrl } from '../lib/api';
import type { ThemeType } from '../lib/theme';

export interface FileAttachmentProps {
  text: string;
  isMine: boolean;
  theme: ThemeType;
}

function getFileIcon(mime: string, name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime === 'application/pdf' || ext === 'pdf') return '📕';
  if (['zip', 'tar', 'gz', 'bz2', '7z', 'rar'].includes(ext)) return '📦';
  if (['doc', 'docx', 'odt', 'rtf', 'txt', 'md'].includes(ext)) return '📄';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  if (['ppt', 'pptx'].includes(ext)) return '📑';
  return '📎';
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function triggerBrowserDownload(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function FileAttachment({ text, isMine, theme }: FileAttachmentProps) {
  const isHacker = theme === 'hacker';
  const isPro = theme === 'pro' || theme === 'midnight';

  let descriptor: MediaDescriptor | null = null;
  try {
    const raw = text.startsWith('[file] ') ? text.slice(7) : text;
    descriptor = decodeMediaDescriptor(raw);
  } catch {
    // If not a valid media descriptor, fallback to plain text
    return <p className="break-words whitespace-pre-wrap">{text}</p>;
  }

  const [downloading, setDownloading] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isImage = descriptor.mime.startsWith('image/');
  const isAudio = descriptor.mime.startsWith('audio/') || descriptor.fileName.startsWith('voice-note');

  // For images and audio under 15 MB, auto-fetch and decrypt inline
  useEffect(() => {
    let cancelled = false;
    if (!descriptor || (!isImage && !isAudio) || descriptor.bytes > 15 * 1024 * 1024) return;

    (async () => {
      try {
        const ticket = await api.downloadUrl(descriptor.objectKey);
        const res = await fetch(resolveApiUrl(ticket.url));
        if (!res.ok) throw new Error('Failed to fetch blob');
        const ciphertext = new Uint8Array(await res.arrayBuffer());
        const { key, header, contentHash } = descriptorToKeyMaterial(descriptor);
        const plaintext = await decryptBlob(key, header, ciphertext, contentHash);
        if (cancelled) return;
        const blob = new Blob([plaintext as unknown as BlobPart], { type: descriptor.mime });
        const url = URL.createObjectURL(blob);
        setObjectUrl(url);
      } catch {
        // Preview failure is non-fatal: user can still click Download
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [descriptor?.objectKey, isImage, isAudio]);

  const handleDownload = async () => {
    if (!descriptor) return;
    if (objectUrl) {
      triggerBrowserDownload(objectUrl, descriptor.fileName);
      return;
    }

    setDownloading(true);
    setError(null);
    try {
      const ticket = await api.downloadUrl(descriptor.objectKey);
      const res = await fetch(resolveApiUrl(ticket.url));
      if (!res.ok) throw new Error('File download rejected by server');
      const ciphertext = new Uint8Array(await res.arrayBuffer());
      const { key, header, contentHash } = descriptorToKeyMaterial(descriptor);
      const plaintext = await decryptBlob(key, header, ciphertext, contentHash);
      const blob = new Blob([plaintext as unknown as BlobPart], { type: descriptor.mime });
      const url = URL.createObjectURL(blob);
      setObjectUrl(url);
      triggerBrowserDownload(url, descriptor.fileName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decryption failed');
    } finally {
      setDownloading(false);
    }
  };

  const icon = getFileIcon(descriptor.mime, descriptor.fileName);

  return (
    <div className="flex flex-col gap-2 max-w-sm">
      {/* Inline Image Preview */}
      {isImage && objectUrl && (
        <div className="relative group overflow-hidden rounded-lg border border-black/10 dark:border-white/10 max-h-72">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={objectUrl}
            alt={descriptor.fileName}
            className="w-full h-auto object-cover rounded-lg cursor-pointer transition transform group-hover:scale-[1.02]"
            onClick={handleDownload}
            title="Click to download full-resolution image"
          />
        </div>
      )}

      {/* Inline Audio / Voice Note Player */}
      {isAudio && objectUrl && (
        <div
          className={`flex items-center gap-3 rounded-2xl p-2.5 border shadow-sm transition ${
            isHacker
              ? 'bg-[#040F06] border-[#00FF66]/30 text-[#00FF66]'
              : isPro
              ? 'bg-[#0B132B] border-slate-700/80 text-white'
              : isMine
              ? 'bg-[#E7F8E8] border-[#25D366]/30 text-[#111B21]'
              : 'bg-white border-[#E9EDEF] text-[#111B21]'
          }`}
        >
          <span className="text-xl shrink-0">🎙️</span>
          <audio controls src={objectUrl} className="h-9 w-60 sm:w-68 max-w-full outline-none" />
        </div>
      )}

      {/* File Card info bar */}
      <div
        className={`flex items-center justify-between gap-3 rounded-xl p-2.5 transition border ${
          isHacker
            ? 'bg-[#040F06] border-[#00FF66]/30 text-[#00FF66]'
            : isPro
            ? 'bg-[#0B132B] border-slate-700/80 text-white'
            : isMine
            ? 'bg-black/5 border-black/10 text-[#111B21]'
            : 'bg-[#F0F2F5] border-[#E9EDEF] text-[#111B21]'
        }`}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-2xl shrink-0">{icon}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-bold leading-tight" title={descriptor.fileName}>
              {descriptor.fileName}
            </p>
            <p className="text-[10px] opacity-60 leading-normal mt-0.5">
              {formatBytes(descriptor.bytes)} • End-to-end encrypted
            </p>
          </div>
        </div>

        <button
          type="button"
          disabled={downloading}
          onClick={handleDownload}
          className={`shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-semibold flex items-center gap-1 transition shadow disabled:opacity-50 ${
            isHacker
              ? 'bg-[#00FF66] text-black hover:bg-[#00CC52]'
              : isPro
              ? 'bg-blue-600 hover:bg-blue-500 text-white'
              : 'bg-emerald-600 hover:bg-emerald-500 text-white'
          }`}
          title="Download and decrypt file"
        >
          {downloading ? (
            <>
              <span className="animate-spin text-[10px]">⏳</span>
              <span className="text-[11px]">Decrypting…</span>
            </>
          ) : (
            <>
              <span>⬇️</span>
              <span className="text-[11px]">{objectUrl ? 'Save' : 'Download'}</span>
            </>
          )}
        </button>
      </div>

      {error && (
        <p className="text-[10px] text-red-400 font-medium px-1">
          ⚠️ {error} — click Download to retry
        </p>
      )}
    </div>
  );
}
