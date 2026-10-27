import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveBotKeypair, scanDerivedWallets } from '../wallets.js';

const key = Buffer.from('ab'.repeat(32), 'hex');

test('derived wallets are deterministic and distinct per index', () => {
  assert.equal(deriveBotKeypair(key, 0).publicKey.toBase58(), deriveBotKeypair(key, 0).publicKey.toBase58());
  assert.notEqual(deriveBotKeypair(key, 0).publicKey.toBase58(), deriveBotKeypair(key, 1).publicKey.toBase58());
  assert.notEqual(deriveBotKeypair(key, 0).publicKey.toBase58(), deriveBotKeypair(Buffer.from('cd'.repeat(32), 'hex'), 0).publicKey.toBase58());
});

test('scan recovers funded wallets missing from the database', async () => {
  const addr = i => deriveBotKeypair(key, i).publicKey.toBase58();
  // Wallet 0 is known, 2 holds SOL, 30 holds SOL in the second batch; everything else is empty.
  const funded = { [addr(2)]: 500_000_000, [addr(30)]: 1_000 };
  let calls = 0;
  const connection = { getMultipleAccountsInfo: async pks => { calls++; return pks.map(pk => funded[pk.toBase58()] ? { lamports: funded[pk.toBase58()] } : null); } };
  const { found, nextIndex } = await scanDerivedWallets({ connection, keyBytes: key, knownIndexes: new Set([0]), heldTokens: async () => 0, batch: 25 });
  assert.deepEqual(found.map(f => f.index), [2, 30]);
  assert.equal(found[0].lamports, 500_000_000);
  assert.equal(nextIndex, 31);
  assert.equal(calls, 3, 'one RPC call per batch of 25');
});
