import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveBotKeypair, scanDerivedWallets } from '../wallets.js';

const key = Buffer.from('ab'.repeat(32), 'hex');

test('derived wallets are deterministic and distinct per index', () => {
  assert.equal(deriveBotKeypair(key, 0).publicKey.toBase58(), deriveBotKeypair(key, 0).publicKey.toBase58());
  assert.notEqual(deriveBotKeypair(key, 0).publicKey.toBase58(), deriveBotKeypair(key, 1).publicKey.toBase58());
  assert.notEqual(deriveBotKeypair(key, 0).publicKey.toBase58(), deriveBotKeypair(Buffer.from('cd'.repeat(32), 'hex'), 0).publicKey.toBase58());
});

test('scan recovers funded wallets missing from the database and skips past used ones', async () => {
  const addr = i => deriveBotKeypair(key, i).publicKey.toBase58();
  // Wallet 0 is known, 1 was used and emptied, 2 holds SOL, 4 holds only tokens; 3 and 5+ never used.
  const used = new Set([addr(0), addr(1), addr(2), addr(4)]);
  const sol = { [addr(2)]: 500_000_000 };
  const tok = { [addr(4)]: 1 };
  const connection = {
    getSignaturesForAddress: async pk => used.has(pk.toBase58()) ? [{ signature: 'x' }] : [],
    getBalance: async pk => sol[pk.toBase58()] || 0
  };
  const { found, nextIndex } = await scanDerivedWallets({ connection, keyBytes: key, knownIndexes: new Set([0]), heldTokens: async pk => tok[pk.toBase58()] || 0, gapLimit: 5 });
  assert.deepEqual(found.map(f => f.index), [2, 4]);
  assert.equal(found[0].lamports, 500_000_000);
  assert.equal(nextIndex, 5);
});
