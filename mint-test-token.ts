/**
 * Mint a custom test SPL token on Solana devnet that the FamilySpace program
 * (Gx82CdkxU4X6HYiXJXY5MUwAWUfwYbA13Q1Jbobg9Fst, NETWORK_ID 0) can spend with SendToken.
 *
 * What the program requires (programs/family-space/src/lib.rs `send_token` / `Execute`):
 *   - CLASSIC SPL Token program only. Token-2022 mints are refused by `Program<'info, Token>`.
 *   - The space's tokens sit in the associated token account (ATA) of the space PDA,
 *     which is an off-curve owner.
 *   - The destination token account must already exist and be owned by the signed `to`;
 *     the program does not create it, so we pre-create recipients' ATAs here.
 *   - Any decimals work: `transfer_checked` reads them from the mint.
 *
 * Usage:
 *   npm run mint                                                # new mint, 1,000,000 tokens to the payer
 *   SPACE_ADDRESS=<spacePda> SPACE_AMOUNT=1000 npm run mint     # also fund a space's vault ATA
 *   SPACE_ID=<decimal|0xhex> SPACE_CREATOR=<pubkey> ...         # derive the space PDA instead of passing SPACE_ADDRESS
 *   RECIPIENTS=<pubkey1,pubkey2> npm run mint                   # pre-create ATAs for SendToken recipients
 *   EXISTING_MINT=<mintAddress> MINT_AMOUNT=500 npm run mint    # mint more of a token you already made
 *
 * Other env:
 *   RPC_URL        default https://api.devnet.solana.com
 *   PAYER_KEYPAIR  default ~/.config/solana/id.json, else ./payer.json (generated if missing)
 *   PROGRAM_ID     default the FamilySpace devnet program above
 *   NETWORK_ID     default 0 (devnet build)
 *   DECIMALS       default 6
 *   MINT_AMOUNT    whole tokens minted to the payer, default 1000000
 *   SPACE_AMOUNT   whole tokens minted to the space vault, default 0
 *
 * The result is written to ./mint.devnet.json.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token';

const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const FAMILY_SPACE_PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? 'Gx82CdkxU4X6HYiXJXY5MUwAWUfwYbA13Q1Jbobg9Fst',
);
// The program's compile-time NETWORK_ID byte (constants.rs). It only enters signed digests,
// not token accounts, so a mint made here works for any build; it is recorded for the BE config.
const NETWORK_ID = Number(process.env.NETWORK_ID ?? 0);

const TOKEN_DECIMALS = Number(process.env.DECIMALS ?? 6);
const PAYER_MINT_AMOUNT = process.env.MINT_AMOUNT ?? '1000000';
const SPACE_MINT_AMOUNT = process.env.SPACE_AMOUNT ?? '0';
const OUTPUT_FILE = path.resolve('mint.devnet.json');
const DEFAULT_PAYER_FILE = 'payer.json';

const SPACE_PDA_SEED = Buffer.from('space');
const SPACE_ID_BYTE_LENGTH = 16;
const MIN_PAYER_BALANCE_SOL = 0.1;

function readKeypairFile(filePath: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(filePath, 'utf8'))));
}

function loadOrCreatePayer(): Keypair {
  const candidateFiles = [
    process.env.PAYER_KEYPAIR,
    path.join(os.homedir(), '.config/solana/id.json'),
    DEFAULT_PAYER_FILE,
  ];
  for (const filePath of candidateFiles) {
    if (filePath && fs.existsSync(filePath)) {
      console.log(`Payer keypair: ${filePath}`);
      return readKeypairFile(filePath);
    }
  }
  const payer = Keypair.generate();
  fs.writeFileSync(DEFAULT_PAYER_FILE, JSON.stringify(Array.from(payer.secretKey)), { mode: 0o600 });
  console.log(`Payer keypair: generated ./${DEFAULT_PAYER_FILE} (devnet only, keep it out of git)`);
  return payer;
}

/** Whole tokens ("12.5") to base units, exactly, without floating point. */
function toBaseUnits(amount: string, decimals: number): bigint {
  const [wholePart, fractionPart = ''] = amount.trim().split('.');
  if (!/^\d+$/.test(wholePart) || !/^\d*$/.test(fractionPart) || fractionPart.length > decimals) {
    throw new Error(`Bad amount "${amount}" for ${decimals} decimals`);
  }
  return BigInt(wholePart + fractionPart.padEnd(decimals, '0'));
}

/** Same derivation as the BE (sol-space.constants.ts): space_id is the 16 low bytes. */
function deriveSpaceAddress(spaceId: string, creator: PublicKey): PublicKey {
  const spaceIdNumber = BigInt(spaceId);
  if (spaceIdNumber < 0n || spaceIdNumber >> 128n) {
    throw new Error(`SPACE_ID ${spaceId} does not fit ${SPACE_ID_BYTE_LENGTH} bytes`);
  }
  const spaceIdBytes = Buffer.from(spaceIdNumber.toString(16).padStart(SPACE_ID_BYTE_LENGTH * 2, '0'), 'hex');
  const [spaceAddress] = PublicKey.findProgramAddressSync(
    [SPACE_PDA_SEED, spaceIdBytes, creator.toBuffer()],
    FAMILY_SPACE_PROGRAM_ID,
  );
  return spaceAddress;
}

function resolveSpaceAddress(): PublicKey | undefined {
  if (process.env.SPACE_ADDRESS) return new PublicKey(process.env.SPACE_ADDRESS);
  if (process.env.SPACE_ID && process.env.SPACE_CREATOR) {
    return deriveSpaceAddress(process.env.SPACE_ID, new PublicKey(process.env.SPACE_CREATOR));
  }
  return undefined;
}

async function assertProgramDeployed(connection: Connection) {
  const programAccount = await connection.getAccountInfo(FAMILY_SPACE_PROGRAM_ID);
  if (!programAccount?.executable) {
    throw new Error(`${FAMILY_SPACE_PROGRAM_ID.toBase58()} is not a deployed program on ${RPC_URL}`);
  }
}

/** Warns (does not fail) when the space is not yet initialized: tokens can arrive before init. */
async function checkSpaceAccount(connection: Connection, spaceAddress: PublicKey) {
  const spaceAccount = await connection.getAccountInfo(spaceAddress);
  const familySpaceDiscriminator = createHash('sha256').update('account:FamilySpace').digest().subarray(0, 8);
  if (!spaceAccount) {
    console.warn(`  ! space ${spaceAddress.toBase58()} is not initialized yet; its token account is still valid`);
  } else if (
    !spaceAccount.owner.equals(FAMILY_SPACE_PROGRAM_ID) ||
    !spaceAccount.data.subarray(0, 8).equals(familySpaceDiscriminator)
  ) {
    throw new Error(
      `${spaceAddress.toBase58()} exists but is not a FamilySpace account of ${FAMILY_SPACE_PROGRAM_ID.toBase58()}`,
    );
  }
}

async function ensurePayerHasSol(connection: Connection, payer: Keypair) {
  const balanceLamports = await connection.getBalance(payer.publicKey);
  console.log(`Payer ${payer.publicKey.toBase58()}: ${balanceLamports / LAMPORTS_PER_SOL} SOL`);
  if (balanceLamports >= MIN_PAYER_BALANCE_SOL * LAMPORTS_PER_SOL) return;
  try {
    console.log('Requesting 1 SOL devnet airdrop...');
    const airdropSignature = await connection.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL);
    await connection.confirmTransaction({ signature: airdropSignature, ...(await connection.getLatestBlockhash()) });
  } catch (error) {
    throw new Error(
      `Airdrop failed (devnet faucet is rate-limited). Fund ${payer.publicKey.toBase58()} at ` +
        `https://faucet.solana.com and run again.\n${(error as Error).message}`,
    );
  }
}

async function main() {
  if (!Number.isInteger(TOKEN_DECIMALS) || TOKEN_DECIMALS < 0 || TOKEN_DECIMALS > 9) {
    throw new Error('DECIMALS must be 0..9');
  }
  const connection = new Connection(RPC_URL, 'confirmed');
  console.log(`RPC ${RPC_URL} | program ${FAMILY_SPACE_PROGRAM_ID.toBase58()} | networkId ${NETWORK_ID}`);
  await assertProgramDeployed(connection);

  const payer = loadOrCreatePayer();
  await ensurePayerHasSol(connection, payer);

  let mintAddress: PublicKey;
  if (process.env.EXISTING_MINT) {
    mintAddress = new PublicKey(process.env.EXISTING_MINT);
    console.log(`Reusing mint ${mintAddress.toBase58()}`);
  } else {
    // Classic SPL Token on purpose: the program refuses Token-2022.
    mintAddress = await createMint(
      connection,
      payer,
      payer.publicKey, // mint authority
      null, // no freeze authority
      TOKEN_DECIMALS,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID,
    );
    console.log(`Created mint ${mintAddress.toBase58()} (${TOKEN_DECIMALS} decimals, classic SPL Token)`);
  }
  // An existing mint keeps its own decimals, which may differ from DECIMALS.
  const { decimals } = await getMint(connection, mintAddress, 'confirmed', TOKEN_PROGRAM_ID);

  const payerTokenAccount = await getOrCreateAssociatedTokenAccount(connection, payer, mintAddress, payer.publicKey);
  await mintTo(connection, payer, mintAddress, payerTokenAccount.address, payer, toBaseUnits(PAYER_MINT_AMOUNT, decimals));
  console.log(`Minted ${PAYER_MINT_AMOUNT} to payer token account ${payerTokenAccount.address.toBase58()}`);

  const summary: Record<string, unknown> = {
    cluster: 'devnet',
    rpc: RPC_URL,
    programId: FAMILY_SPACE_PROGRAM_ID.toBase58(),
    networkId: NETWORK_ID,
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    mint: mintAddress.toBase58(),
    decimals,
    mintAuthority: payer.publicKey.toBase58(),
    payerAta: payerTokenAccount.address.toBase58(),
  };

  const spaceAddress = resolveSpaceAddress();
  if (spaceAddress) {
    await checkSpaceAccount(connection, spaceAddress);
    // allowOwnerOffCurve: the space is a PDA, so the token account owner is off the ed25519 curve.
    const spaceVaultAccount = await getOrCreateAssociatedTokenAccount(connection, payer, mintAddress, spaceAddress, true);
    const spaceAmountBaseUnits = toBaseUnits(SPACE_MINT_AMOUNT, decimals);
    if (spaceAmountBaseUnits > 0n) {
      await mintTo(connection, payer, mintAddress, spaceVaultAccount.address, payer, spaceAmountBaseUnits);
    }
    console.log(
      `Space ${spaceAddress.toBase58()} vault token account ${spaceVaultAccount.address.toBase58()} (+${SPACE_MINT_AMOUNT})`,
    );
    summary.space = spaceAddress.toBase58();
    summary.spaceAta = spaceVaultAccount.address.toBase58();
  }

  const recipientAddresses = (process.env.RECIPIENTS ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean);
  if (recipientAddresses.length) {
    const recipientTokenAccounts: Record<string, string> = {};
    for (const recipientAddress of recipientAddresses) {
      const recipient = new PublicKey(recipientAddress);
      const isPda = !PublicKey.isOnCurve(recipient);
      const recipientTokenAccount = await getOrCreateAssociatedTokenAccount(connection, payer, mintAddress, recipient, isPda);
      recipientTokenAccounts[recipientAddress] = recipientTokenAccount.address.toBase58();
      console.log(`Recipient ${recipientAddress} token account ${recipientTokenAccount.address.toBase58()} (ready for SendToken)`);
    }
    summary.recipientAtas = recipientTokenAccounts;
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(summary, null, 2) + '\n');
  console.log(`\nSaved ${OUTPUT_FILE}`);
  console.log(`Explorer: https://explorer.solana.com/address/${mintAddress.toBase58()}?cluster=devnet`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
