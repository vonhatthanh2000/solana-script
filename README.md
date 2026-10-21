# solana-mint-token

Devnet helper scripts for the FamilySpace Solana program (`Gx82CdkxU4X6HYiXJXY5MUwAWUfwYbA13Q1Jbobg9Fst`):

- **`mint-test-token.ts`** creates a test SPL token that FamilySpace can spend with `SendToken`, and funds spaces and recipients with it.
- **`generate-backend-keys.ts`** prepares the guardian and relayer keys for `tonpass-wallet-be` and prints them as `.env` lines.

## Setup

Requires Node.js 18+.

```bash
npm install
```

The scripts use devnet (`https://api.devnet.solana.com`) unless you set `RPC_URL`.

## Mint a test token

```bash
npm run mint
```

This creates a new mint (classic SPL Token, 6 decimals) and mints 1,000,000 tokens to the payer. The result is saved to `mint.devnet.json`, and the script prints an Explorer link.

**Payer keypair.** The script uses the first keypair file it finds:

1. `PAYER_KEYPAIR`
2. `~/.config/solana/id.json`
3. `./payer.json`

If none exists, it generates `./payer.json`. When the payer has less than 0.1 SOL, the script requests a 1 SOL airdrop. The devnet faucet is rate-limited; if the airdrop fails, fund the payer at https://faucet.solana.com and run the script again.

### Examples

```bash
# Fund a space's vault with 1,000 tokens
SPACE_ADDRESS=<spacePda> SPACE_AMOUNT=1000 npm run mint

# Same, but derive the space PDA from its id and creator
SPACE_ID=<decimal|0xhex> SPACE_CREATOR=<pubkey> SPACE_AMOUNT=1000 npm run mint

# Create token accounts for SendToken recipients
RECIPIENTS=<pubkey1>,<pubkey2> npm run mint

# Mint 500 more of an existing token instead of creating a new one
EXISTING_MINT=<mintAddress> MINT_AMOUNT=500 npm run mint
```

### Environment variables

| Variable        | Default                                        | Meaning                                                  |
| --------------- | ---------------------------------------------- | -------------------------------------------------------- |
| `RPC_URL`       | `https://api.devnet.solana.com`                | Solana RPC endpoint                                      |
| `PAYER_KEYPAIR` | `~/.config/solana/id.json`, then `./payer.json` | Keypair that pays fees and becomes the mint authority    |
| `PROGRAM_ID`    | FamilySpace devnet program                     | Program the space PDA belongs to                         |
| `NETWORK_ID`    | `0`                                            | Program build (0 = devnet), recorded in the output only  |
| `DECIMALS`      | `6`                                            | Decimals for a new mint (0–9)                            |
| `MINT_AMOUNT`   | `1000000`                                      | Whole tokens minted to the payer                         |
| `EXISTING_MINT` | –                                              | Reuse this mint instead of creating one                  |
| `SPACE_ADDRESS` | –                                              | Space PDA whose vault to fund                            |
| `SPACE_ID`      | –                                              | Space id; with `SPACE_CREATOR`, derives the space PDA    |
| `SPACE_CREATOR` | –                                              | Creator pubkey used in that derivation                   |
| `SPACE_AMOUNT`  | `0`                                            | Whole tokens minted to the space vault                   |
| `RECIPIENTS`    | –                                              | Comma-separated pubkeys that get token accounts          |

Amounts are whole tokens and may include a fraction, such as `12.5`.

### Program requirements

- **Classic SPL Token only.** FamilySpace refuses Token-2022 mints.
- **Space vault.** A space holds its tokens in the associated token account of the space PDA. You can fund it before the space is initialized.
- **Recipients.** `SendToken` does not create the recipient's token account, so create it first with `RECIPIENTS`.

## Generate backend keys

```bash
npm run generate-keys
```

The script prints two lines to paste into `tonpass-wallet-be/.env`:

```
GUARDIAN_PRIVKEY_SOL=<128 hex chars>
FAMILY_RELAYER_PRIVKEY_SOL=<128 hex chars>
```

- **Relayer.** Pays transaction fees and rent. It reuses the funded `./payer.json`; point `RELAYER_KEYPAIR` at another file to use a different wallet. Keep at least 0.05 SOL in it.
- **Guardian.** Co-signs space actions. It is generated on the first run, saved to `./guardian-sol.json`, and reused on every later run. **Never fund it.**

> ⚠️ Never delete or regenerate `guardian-sol.json` once a space has been opened. Each space stores the guardian pubkey on chain, and a space whose guardian key is lost is frozen.

Also set `SOLANA_NETWORK_ID` in the backend to the same `NETWORK_ID`: `0` for the devnet build (the default), `1` for the mainnet build.

The status messages go to stderr and only the env lines go to stdout, so you can append the keys directly:

```bash
npm run -s generate-keys >> ../tonpass-wallet-be/.env
```

## Secrets

`payer.json` and `guardian-sol.json` hold private keys. Both are gitignored. Never commit them, or the `.env` lines the script prints. `mint.devnet.json` holds only public addresses and is safe to commit.
