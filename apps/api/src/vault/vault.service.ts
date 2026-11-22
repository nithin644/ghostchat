import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface EncryptedVaultRecord {
  nonce: string;
  ciphertext: string;
}

@Injectable()
export class VaultService {
  constructor(private readonly prisma: PrismaService) {}

  async getAll(userId: string): Promise<{ entries: Record<string, EncryptedVaultRecord> }> {
    const rows = await this.prisma.vaultEntry.findMany({
      where: { userId },
      select: { key: true, nonce: true, ciphertext: true },
    });
    const entries: Record<string, EncryptedVaultRecord> = {};
    for (const row of rows) {
      entries[row.key] = { nonce: row.nonce, ciphertext: row.ciphertext };
    }
    return { entries };
  }

  async upsertMany(
    userId: string,
    entries: Record<string, EncryptedVaultRecord>,
  ): Promise<{ count: number }> {
    const keys = Object.keys(entries);
    if (keys.length === 0) return { count: 0 };

    const CHUNK_SIZE = 50;
    let count = 0;
    for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
      const slice = keys.slice(i, i + CHUNK_SIZE);
      const operations = slice
        .map((key) => {
          const item = entries[key];
          if (!item) return null;
          return this.prisma.vaultEntry.upsert({
            where: { userId_key: { userId, key } },
            update: { nonce: item.nonce, ciphertext: item.ciphertext },
            create: { userId, key, nonce: item.nonce, ciphertext: item.ciphertext },
          });
        })
        .filter((op): op is NonNullable<typeof op> => op !== null);

      if (operations.length > 0) {
        await this.prisma.$transaction(operations);
        count += operations.length;
      }
    }
    return { count };
  }

  async delete(userId: string, key: string): Promise<{ ok: boolean }> {
    await this.prisma.vaultEntry.deleteMany({
      where: { userId, key },
    });
    return { ok: true };
  }
}
