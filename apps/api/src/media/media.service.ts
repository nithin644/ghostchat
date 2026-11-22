import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { CONFIG, type AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Media storage, with a swappable backend.
 *
 * Both drivers store the exact same thing: an opaque blob produced by the
 * client's `crypto_secretstream` routine. The server cannot read it either way,
 * so the driver is purely an operational choice.
 *
 *   MEDIA_DRIVER=local   blobs on the API's own disk, served over tokenised URLs
 *   MEDIA_DRIVER=s3      presigned URLs against any S3-compatible store
 *
 * Why a local driver exists: single-node deployments behind Tor do not need an
 * object store, and pinning one turned out to be a liability — the previous
 * default (MinIO) stopped publishing public images, which broke `run.sh` for
 * reasons unrelated to this application. Local disk has no vendor to disappear.
 */
export type MediaDriver = 'local' | 's3';

export interface UploadTicket {
  objectKey: string;
  /** Absolute or origin-relative URL the browser PUTs ciphertext to. */
  uploadUrl: string;
  /** How the client should issue the upload. */
  method: 'PUT';
  expiresIn: number;
  maxBytes: number;
}

export interface DownloadTicket {
  url: string;
  expiresIn: number;
  bytes: number;
}

@Injectable()
export class MediaService {
  private s3: S3Client | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  get driver(): MediaDriver {
    return this.config.MEDIA_DRIVER === 's3' ? 's3' : 'local';
  }

  private get bucket(): string {
    return this.config.S3_BUCKET;
  }

  /** Lazily built so a local-disk deployment never needs AWS credentials. */
  private s3Client(): S3Client {
    if (this.s3) return this.s3;
    const c = this.config;
    this.s3 = new S3Client({
      region: c.S3_REGION,
      endpoint: c.S3_ENDPOINT,
      forcePathStyle: c.S3_FORCE_PATH_STYLE,
      credentials:
        c.S3_ACCESS_KEY && c.S3_SECRET_KEY
          ? { accessKeyId: c.S3_ACCESS_KEY, secretAccessKey: c.S3_SECRET_KEY }
          : undefined,
    });
    return this.s3;
  }

  /* ---------------------------------------------------------------------- */
  /* Local driver internals                                                 */
  /* ---------------------------------------------------------------------- */

  private mediaRoot(): string {
    return resolve(this.config.MEDIA_DIR);
  }

  private pathFor(objectKey: string): string {
    // Object keys are generated server-side and validated on the way in; this
    // check is belt-and-braces against a crafted key escaping the media root.
    if (!/^[A-Za-z0-9_-]{16,64}\.blob$/.test(objectKey)) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'Invalid object key' });
    }
    return join(this.mediaRoot(), objectKey);
  }

  /**
   * Capability token for a blob URL.
   *
   * The uploaded ciphertext is useless without the file key that travels inside
   * the E2EE message, but an unauthenticated blob endpoint would still let
   * anyone overwrite or delete another user's object. This HMAC makes each URL
   * a short-lived capability: purpose-bound, key-bound and expiring.
   */
  private signToken(purpose: 'up' | 'down', objectKey: string, expiresAt: number): string {
    return createHmac('sha256', this.config.SESSION_SECRET)
      .update(`${purpose}:${objectKey}:${expiresAt}`)
      .digest('base64url');
  }

  verifyToken(
    purpose: 'up' | 'down',
    objectKey: string,
    expiresAt: number,
    token: string,
  ): boolean {
    if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return false;

    const expected = Buffer.from(this.signToken(purpose, objectKey, expiresAt));
    const supplied = Buffer.from(token);
    if (expected.length !== supplied.length) return false;
    return timingSafeEqual(expected, supplied);
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.mediaRoot(), { recursive: true });
  }

  /** Streams a request body to disk, enforcing the size cap as it goes. */
  async saveBlob(objectKey: string, source: Readable): Promise<number> {
    await this.ensureRoot();
    const target = this.pathFor(objectKey);
    const limit = this.config.MEDIA_MAX_BYTES;

    let written = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        written += chunk.length;
        if (written > limit) {
          done(new BadRequestException({ code: 'PAYLOAD_TOO_LARGE', message: 'Upload too large' }));
          return;
        }
        done(null, chunk);
      },
    });

    try {
      await pipeline(source, limiter as never, createWriteStream(target));
      return written;
    } catch (error) {
      // `pipeline` destroys the streams, but createWriteStream has already
      // created the file — so a rejected oversize upload would otherwise leave
      // an orphaned partial blob behind. Remove it before rethrowing.
      await unlink(target).catch(() => undefined);
      throw error;
    }
  }

  /** Caller must have checked `blobInfo` first; a missing file surfaces as a stream error. */
  readBlob(objectKey: string): Readable {
    return createReadStream(this.pathFor(objectKey));
  }

  blobInfo(objectKey: string): Promise<{ size: number } | null> {
    return stat(this.pathFor(objectKey))
      .then((s) => ({ size: s.size }))
      .catch(() => null);
  }

  /* ---------------------------------------------------------------------- */
  /* Public API                                                             */
  /* ---------------------------------------------------------------------- */

  async presignUpload(userId: string, bytes: number, sha256: string): Promise<UploadTicket> {
    if (bytes <= 0 || bytes > this.config.MEDIA_MAX_BYTES) {
      throw new BadRequestException({
        code: 'PAYLOAD_TOO_LARGE',
        message: `File must be 1 byte - ${this.config.MEDIA_MAX_BYTES} bytes`,
      });
    }

    // Random and unrelated to owner, conversation or filename: an object key
    // must never become a metadata channel.
    const objectKey = `${randomBytes(18).toString('base64url')}.blob`;
    const expiresIn = 900;

    await this.prisma.mediaObject.create({
      data: { objectKey, ownerId: userId, bytes, sha256, deleteAfter: null },
    });

    if (this.driver === 's3') {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        ContentType: 'application/octet-stream',
        ContentLength: bytes,
        Metadata: { sha256 },
      });
      const uploadUrl = await getSignedUrl(this.s3Client(), command, { expiresIn });
      return { objectKey, uploadUrl, method: 'PUT', expiresIn, maxBytes: this.config.MEDIA_MAX_BYTES };
    }

    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
    const token = this.signToken('up', objectKey, expiresAt);
    const uploadUrl = `/api/blob/${objectKey}?p=up&exp=${expiresAt}&sig=${token}`;
    return { objectKey, uploadUrl, method: 'PUT', expiresIn, maxBytes: this.config.MEDIA_MAX_BYTES };
  }

  async presignDownload(userId: string, objectKey: string): Promise<DownloadTicket> {
    const object = await this.prisma.mediaObject.findUnique({ where: { objectKey } });
    if (!object) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Object not found' });

    // Any authenticated user may fetch a blob: recipients need it, and it is
    // useless without the E2EE file key. Ciphertext is the access control.
    void userId;

    const expiresIn = 300;
    if (this.driver === 's3') {
      const command = new GetObjectCommand({ Bucket: this.bucket, Key: objectKey });
      const url = await getSignedUrl(this.s3Client(), command, { expiresIn });
      return { url, expiresIn, bytes: object.bytes };
    }

    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
    const token = this.signToken('down', objectKey, expiresAt);
    return {
      url: `/api/blob/${objectKey}?p=down&exp=${expiresAt}&sig=${token}`,
      expiresIn,
      bytes: object.bytes,
    };
  }

  async complete(userId: string, objectKey: string) {
    const object = await this.prisma.mediaObject.findUnique({ where: { objectKey } });
    if (!object || object.ownerId !== userId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Object not found' });
    }

    if (this.driver === 's3') {
      try {
        const head = await this.s3Client().send(
          new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
        );
        return { objectKey, bytes: head.ContentLength ?? object.bytes, verified: true };
      } catch {
        // Upload never landed, or the bucket is unreachable. Say so rather than
        // letting the sender believe the file was delivered.
        return { objectKey, bytes: object.bytes, verified: false };
      }
    }

    const info = await this.blobInfo(objectKey);
    return {
      objectKey,
      bytes: info?.size ?? object.bytes,
      verified: info !== null && info.size > 0,
    };
  }

  async remove(objectKey: string): Promise<void> {
    if (this.driver === 's3') {
      await this.s3Client()
        .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }))
        .catch(() => undefined);
    } else {
      await unlink(this.pathFor(objectKey)).catch(() => undefined);
    }
    await this.prisma.mediaObject.deleteMany({ where: { objectKey } });
  }
}
