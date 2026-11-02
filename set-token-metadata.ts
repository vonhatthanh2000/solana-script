/**
 * Attach Metaplex metadata to an existing classic SPL token mint.
 *
 * This command never creates or mints tokens. The mint authority must sign the
 * metadata creation transaction.
 *
 * Usage:
 *   npm run metadata
 *   TOKEN_NAME="Devnet USDT" TOKEN_SYMBOL=dUSDT npm run metadata
 *
 * Other env:
 *   MINT_ADDRESS   defaults to the mint in ./mint.devnet.json
 *   METADATA_URI   optional off-chain JSON metadata URL (default: empty)
 *   RPC_URL        defaults to the rpc in ./mint.devnet.json, then devnet
 *   PAYER_KEYPAIR  optional mint-authority keypair path
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID,
  createCreateMetadataAccountV3Instruction,
} from '@metaplex-foundation/mpl-token-metadata';
import { getMint, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

type MintSummary = {
  mint?: string;
  rpc?: string;
};

const SUMMARY_FILE = path.resolve('mint.devnet.json');
const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';
const DEFAULT_PAYER_FILE = 'payer.json';

function readSummary(): MintSummary {
  if (!fs.existsSync(SUMMARY_FILE)) return {};
  return JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8')) as MintSummary;
}

function readKeypairFile(filePath: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(filePath, 'utf8'))));
}

function loadMintAuthority(expectedAuthority: PublicKey): { keypair: Keypair; filePath: string } {
  const candidateFiles = [
    process.env.PAYER_KEYPAIR,
    path.join(os.homedir(), '.config/solana/id.json'),
    DEFAULT_PAYER_FILE,
  ].filter((filePath): filePath is string => Boolean(filePath));

  const checked: string[] = [];
  for (const filePath of candidateFiles) {
    if (!fs.existsSync(filePath)) continue;
    const keypair = readKeypairFile(filePath);
    checked.push(`${filePath} (${keypair.publicKey.toBase58()})`);
    if (keypair.publicKey.equals(expectedAuthority)) return { keypair, filePath };
  }

  throw new Error(
    `No available keypair matches mint authority ${expectedAuthority.toBase58()}.` +
      (checked.length ? ` Checked: ${checked.join(', ')}` : ' No keypair files were found.') +
      '\nSet PAYER_KEYPAIR to the mint-authority keypair file.',
  );
}

function assertMetadataField(name: string, value: string, maxBytes: number) {
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (!value && name !== 'METADATA_URI') throw new Error(`${name} must not be empty`);
  if (byteLength > maxBytes) throw new Error(`${name} must be at most ${maxBytes} UTF-8 bytes (received ${byteLength})`);
}

async function main() {
  const summary = readSummary();
  const mintValue = process.env.MINT_ADDRESS ?? summary.mint;
  if (!mintValue) throw new Error('Set MINT_ADDRESS or create mint.devnet.json first');

  const tokenName = process.env.TOKEN_NAME ?? 'Devnet USDT';
  const tokenSymbol = process.env.TOKEN_SYMBOL ?? 'dUSDT';
  const metadataUri = process.env.METADATA_URI ?? '';
  assertMetadataField('TOKEN_NAME', tokenName, 32);
  assertMetadataField('TOKEN_SYMBOL', tokenSymbol, 10);
  assertMetadataField('METADATA_URI', metadataUri, 200);

  const rpcUrl = process.env.RPC_URL ?? summary.rpc ?? DEFAULT_RPC_URL;
  const connection = new Connection(rpcUrl, 'confirmed');
  const mint = new PublicKey(mintValue);
  const mintAccount = await getMint(connection, mint, 'confirmed', TOKEN_PROGRAM_ID);
  if (!mintAccount.mintAuthority) throw new Error(`Mint ${mint.toBase58()} has no mint authority`);

  const { keypair: authority, filePath } = loadMintAuthority(mintAccount.mintAuthority);
  const [metadataAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  );

  if (await connection.getAccountInfo(metadataAddress, 'confirmed')) {
    throw new Error(
      `Metadata already exists at ${metadataAddress.toBase58()}. ` +
        'This command only creates metadata and will not overwrite it.',
    );
  }

  console.log(`RPC: ${rpcUrl}`);
  console.log(`Mint: ${mint.toBase58()}`);
  console.log(`Mint authority: ${authority.publicKey.toBase58()} (${filePath})`);
  console.log(`Metadata: ${tokenName} (${tokenSymbol})${metadataUri ? ` | ${metadataUri}` : ''}`);

  const instruction = createCreateMetadataAccountV3Instruction(
    {
      metadata: metadataAddress,
      mint,
      mintAuthority: authority.publicKey,
      payer: authority.publicKey,
      updateAuthority: authority.publicKey,
    },
    {
      createMetadataAccountArgsV3: {
        data: {
          name: tokenName,
          symbol: tokenSymbol,
          uri: metadataUri,
          sellerFeeBasisPoints: 0,
          creators: null,
          collection: null,
          uses: null,
        },
        isMutable: true,
        collectionDetails: null,
      },
    },
  );

  const signature = await sendAndConfirmTransaction(connection, new Transaction().add(instruction), [authority], {
    commitment: 'confirmed',
  });

  console.log(`Metadata account: ${metadataAddress.toBase58()}`);
  console.log(`Transaction: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
