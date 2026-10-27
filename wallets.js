import { Keypair } from '@solana/web3.js';
import { createHmac } from 'node:crypto';

// Bot wallets are derived from the encryption key, so the same key always rebuilds the same wallets.
export function deriveBotKeypair(keyBytes, index) {
  return Keypair.fromSeed(createHmac('sha256', keyBytes).update(`corvis-bot-wallet:${index}`).digest());
}

// Walk derived wallets in batches (one RPC call per 25 wallets, so public RPCs don't rate-limit it) until a
// whole batch is empty. Returns funded wallets that are not already known, plus the next unused index.
export async function scanDerivedWallets({ connection, keyBytes, knownIndexes, heldTokens, batch = 25 }) {
  const found = [];
  let nextIndex = Math.max(0, ...[...knownIndexes].map(i => i + 1));
  for (let start = 0; ; start += batch) {
    const indexes = Array.from({ length: batch }, (_, k) => start + k);
    const keys = indexes.map(i => deriveBotKeypair(keyBytes, i).publicKey);
    const infos = await connection.getMultipleAccountsInfo(keys, 'confirmed');
    let any = false;
    for (let k = 0; k < batch; k++) {
      const i = indexes[k];
      if (knownIndexes.has(i)) { any = true; continue; }
      if (!infos[k]) continue;
      any = true;
      nextIndex = Math.max(nextIndex, i + 1);
      const tokens = await heldTokens(keys[k]);
      found.push({ index: i, address: keys[k].toBase58(), lamports: infos[k].lamports, tokens });
    }
    if (!any) break;
  }
  return { found, nextIndex };
}
