/**
 * Prepare the backend's Solana keys and print them as the env lines to paste into
 * tonpass-wallet-be/.env:
 *   GUARDIAN_PRIVKEY_SOL       — co-signs space actions; generated once, NEVER funded
 *   FAMILY_RELAYER_PRIVKEY_SOL — pays fees + rent; reuses the funded ./payer.json
 * Both are 64-byte Ed25519 secret keys as 128 hex chars.
 *
 * Usage:
 *   npm run generate-keys
 *
 * The guardian is generated on the first run and saved to ./guardian-sol.json; later runs reuse
 * that file and print the same lines again. Never delete or regenerate it once a space is open:
 * each space stores the guardian pubkey on chain, and a space whose guardian key is lost freezes.
 *
 * Other env:
 *   RELAYER_KEYPAIR   default ./payer.json
 *   GUARDIAN_KEYPAIR  default ./guardian-sol.json
 *   RPC_URL           default https://api.devnet.solana.com
 *   NETWORK_ID        default 0 (devnet build), 1 for the mainnet build
 */
import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import nacl from 'tweetnacl';

const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const NETWORK_ID = Number(process.env.NETWORK_ID ?? 0);
const RELAYER_KEYPAIR_FILE = path.resolve(process.env.RELAYER_KEYPAIR ?? 'payer.json');
const GUARDIAN_KEYPAIR_FILE = path.resolve(process.env.GUARDIAN_KEYPAIR ?? 'guardian-sol.json');
const MIN_RELAYER_BALANCE_SOL = 0.05;

function readKeypairFile(filePath: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(filePath, 'utf8'))));
}

function loadOrCreateGuardian(): Keypair {
  if (fs.existsSync(GUARDIAN_KEYPAIR_FILE)) {
    console.error(`Guardian: reusing ${GUARDIAN_KEYPAIR_FILE}`);
    return readKeypairFile(GUARDIAN_KEYPAIR_FILE);
  }
  const guardian = Keypair.generate();
  fs.writeFileSync(GUARDIAN_KEYPAIR_FILE, JSON.stringify(Array.from(guardian.secretKey)), { mode: 0o600 });
  console.error(`Guardian: generated ${GUARDIAN_KEYPAIR_FILE} (keep it; it cannot be replaced by regenerating)`);
  return guardian;
}

/**
 * The backend loads the hex with keyPairFromSecretKey, which SLICES the last 32 bytes as the
 * pubkey instead of deriving it, so a key whose tail is wrong would never verify its own signatures.
 */
function assertKeyUsableByBackend(role: string, keypair: Keypair) {
  if (keypair.secretKey.length !== 64) throw new Error(`${role}: secret key is not 64 bytes`);
  if (!Buffer.from(keypair.secretKey.subarray(32)).equals(keypair.publicKey.toBuffer())) {
    throw new Error(`${role}: secret key tail is not its public key`);
  }
  const testMessage = nacl.randomBytes(32);
  const testSignature = nacl.sign.detached(testMessage, keypair.secretKey);
  if (testSignature.length !== 64 || !nacl.sign.detached.verify(testMessage, testSignature, keypair.publicKey.toBytes())) {
    throw new Error(`${role}: test signature does not verify`);
  }
}

function toSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

async function main() {
  if (NETWORK_ID !== 0 && NETWORK_ID !== 1) throw new Error('NETWORK_ID must be 0 (devnet build) or 1 (mainnet build)');
  if (!fs.existsSync(RELAYER_KEYPAIR_FILE)) {
    throw new Error(
      `Relayer keypair ${RELAYER_KEYPAIR_FILE} not found; set RELAYER_KEYPAIR to your funded wallet's id.json`,
    );
  }
  const relayer = readKeypairFile(RELAYER_KEYPAIR_FILE);
  console.error(`Relayer:  reusing ${RELAYER_KEYPAIR_FILE}`);
  const guardian = loadOrCreateGuardian();

  assertKeyUsableByBackend('guardian', guardian);
  assertKeyUsableByBackend('relayer', relayer);
  if (guardian.publicKey.equals(relayer.publicKey)) {
    throw new Error('Guardian and relayer are the same key; they must be separate');
  }

  const connection = new Connection(RPC_URL, 'confirmed');
  const [relayerBalanceLamports, guardianBalanceLamports] = await Promise.all([
    connection.getBalance(relayer.publicKey),
    connection.getBalance(guardian.publicKey),
  ]);

  console.error(`\nNetwork id ${NETWORK_ID} — the backend needs SOLANA_NETWORK_ID=${NETWORK_ID} too`);
  console.error(`Guardian address ${guardian.publicKey.toBase58()} (${toSol(guardianBalanceLamports)} SOL, never fund it)`);
  console.error(`Guardian pubkey  0x${guardian.publicKey.toBuffer().toString('hex')}`);
  console.error(`Relayer address  ${relayer.publicKey.toBase58()} (${toSol(relayerBalanceLamports)} SOL)`);
  if (relayerBalanceLamports < MIN_RELAYER_BALANCE_SOL * LAMPORTS_PER_SOL) {
    console.error(`  ! relayer has under ${MIN_RELAYER_BALANCE_SOL} SOL; top it up at https://faucet.solana.com`);
  }

  // Status goes to stderr and only the env lines go to stdout, so `npm run -s generate-keys >> .env` works.
  console.error('\n# Paste into tonpass-wallet-be/.env (replace any existing empty lines; never commit)');
  console.log(`GUARDIAN_PRIVKEY_SOL=${Buffer.from(guardian.secretKey).toString('hex')}`);
  console.log(`FAMILY_RELAYER_PRIVKEY_SOL=${Buffer.from(relayer.secretKey).toString('hex')}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
