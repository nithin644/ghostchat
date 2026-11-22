/**
 * Mint the first admin access key.
 *
 * Run once, with ADMIN_BOOTSTRAP_KEY set, then claim the printed key through the
 * normal onboarding flow and promote that account. The bootstrap credential is
 * never stored; it only gates execution of this script.
 */
import { PrismaClient } from '@prisma/client';
import {
  generateAccessKey,
  deriveContactCode,
  deriveClaimVerifier,
  b64e,
  ready,
} from '@ghostchat/crypto';
import { randomBytes } from 'node:crypto';

async function main(): Promise<void> {
  const bootstrap = process.env.ADMIN_BOOTSTRAP_KEY;
  if (!bootstrap || bootstrap.length < 32) {
    throw new Error('ADMIN_BOOTSTRAP_KEY must be set to a 32+ character value');
  }

  await ready();
  const prisma = new PrismaClient();

  try {
    const accessKey = generateAccessKey();
    const contactCode = await deriveContactCode(accessKey);
    const verifier = await deriveClaimVerifier(accessKey);

    await prisma.accessKey.create({
      data: {
        contactCode,
        identitySalt: b64e(randomBytes(16)),
        verifier,
        label: 'bootstrap-admin',
      },
    });

    const promote = process.env.ADMIN_PROMOTE_PSEUDO_ID;
    if (promote) {
      const user = await prisma.user.findUnique({ where: { pseudoId: promote } });
      if (!user) throw new Error(`no such user: ${promote}`);
      await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
      process.stdout.write(`promoted ${promote} to ADMIN\n`);
    }

    process.stdout.write('\n=== ADMIN ACCESS KEY (shown once) ===\n');
    process.stdout.write(`${accessKey}\n`);
    process.stdout.write(`contact code: ${contactCode}\n`);
    process.stdout.write('====================================\n\n');
    process.stdout.write('Claim it at /onboarding, then re-run with ADMIN_PROMOTE_PSEUDO_ID=<your pseudoId>\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
