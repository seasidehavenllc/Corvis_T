import { Keypair } from '@solana/web3.js';
import { createHmac } from 'node:crypto';

// Bot wallets are derived from the encryption key, so the same key always rebuilds the same wallets.
export function deriveBotKeypair(keyBytes, index) {
  return Keypair.fromSeed(createHmac('sha256', keyBytes).update(`corvis-bot-wallet:${index}`).digest());
}

// Walk derived wallets in order until `gapLimit` in a row have never been used on-chain.
// Returns the used wallets that are not already known, plus the next unused index.
export async function scanDerivedWallets({ connection, keyBytes, knownIndexes, heldTokens, gapLimit = 20 }) {
  const found = [];
  let nextIndex = 0;
  for (let i = 0, gap = 0; gap < gapLimit; i++) {
    if (knownIndexes.has(i)) { gap = 0; nextIndex = i + 1; continue; }
    const owner = deriveBotKeypair(keyBytes, i).publicKey;
    const history = await connection.getSignaturesForAddress(owner, { limit: 1 }, 'confirmed');
    if (!history.length) { gap++; continue; }
    gap = 0;
    nextIndex = i + 1;
    const lamports = await connection.getBalance(owner, 'confirmed');
    const tokens = await heldTokens(owner);
    if (lamports > 0 || tokens > 0) found.push({ index: i, address: owner.toBase58(), lamports, tokens });
  }
  return { found, nextIndex };
}
