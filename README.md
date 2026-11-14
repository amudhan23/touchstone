# Touchstone

**Verifiable AI trading vaults.** A touchstone is the stone used to test whether gold is real, without taking the seller's word for it.

AI trading vaults on NEAR where the strategy's parameters stay sealed in Intel TDX hardware, while every claim an investor needs (which code ran, that no trade was back-filled, that risk limits held, that returns are real) can be checked by anyone, in a browser, without trusting us.

Built at NEAR HACKATHON (Nov 2026), solo. Live on NEAR testnet. A 16-page product document with diagrams is in [`docs/Product-Document.pdf`](docs/Product-Document.pdf).

## The problem

- **Investors can't verify AI fund managers.** They can't see which code runs, whether the track record was back-filled, or whether "max 3x leverage" was ever enforced.
- **Managers can't prove themselves without leaking the edge.** Publishing a strategy gets it copied; hiding it means nobody can trust it.

## The solution in one paragraph

The strategy's **code is public** (anyone can read it and check its hash), its **parameters are sealed** in an Intel TDX enclave on OutLayer, and its **behaviour is provable**:

- Every decision is hashed on NEAR before it executes.
- The vault contract refuses anything outside its risk limits.
- Bulletproofs show private risk metrics stayed in range.
- The vault signs its own Uniswap trades through NEAR Chain Signatures, at the size the enclave chose.
- Value comes back as NEAR through NEAR Intents.

## Try it: do X, see Y

| Do | See |
|---|---|
| `./scripts/judge-check.sh` | 56 Rust tests (incl. a property-based fuzz of the money rules) and 4 executor tests pass; one full decision cycle runs offline; then six read-only checks run against the live testnet vault. Ends with a PASS/FAIL summary. |
| Open the site ([hosted](https://amudhan23.github.io/verifiable-alpha-vaults/) or `cd frontend && python3 -m http.server 8080`), open `vault.alpha-vaults-23.testnet`, press **Run all checks** | Four seals turn green, computed in your browser: TDX attestations match the approved code, every decision recomputes to its earlier on-chain hash, Bulletproofs verify, enclave inputs match their attested hashes. |
| On the site, open the **Counterfeit Bureau** and try a cheat: back-fill a trade, demand 10x leverage, swap the code | Each attempt is refused, and the page shows which rule caught it. |
| `cd executor && npm ci && node verify.mjs --vault vault2.alpha-vaults-23.testnet` | 5/5 checks pass, including a swap on Sepolia whose calldata ends in the hash of the decision committed before it. |
| Open [the attested swap on Sepolia](https://sepolia.etherscan.io/tx/0xa7ca6d0ebe7144bb829194832ea047c9c7a6594dbada642bbbd5a97fc19f13a1) | A sell of 0.01308 ETH sent from the vault's own address; the size and the 38.46 USDC floor were chosen inside the enclave; the input data ends in commitment `55b77309…`. |
| `node executor/run.mjs` | One full cycle against a local enclave: decide, commit, reveal, guardrail check, Bulletproofs. No network or keys needed. |

Every claim with its code, its test and a live transaction: [`VERIFY.md`](VERIFY.md).

![Running all checks against the live testnet vault: TDX attestations fetched, commitments recomputed, Bulletproofs verified, in the browser](docs/img/checks-live.gif)

## What's live, and what isn't

| Piece | Status |
|---|---|
| Vault contract (v5) with shares, guardrails, commit-then-reveal, timelocks, emergency exit | **Live** on testnet (`vault.alpha-vaults-23.testnet`, `vault2.alpha-vaults-23.testnet`) |
| Strategy in Intel TDX (OutLayer) with sealed parameters | **Live** (relayed over HTTPS on the main vault) |
| Attested mode: the vault requests the run on-chain and receives it in its own callback | **Live** on the rehearsal vault (full cycle with a swap); switched on for the main vault 14 Nov |
| Vault-signed Uniswap swaps via Chain Signatures | **Live** on Ethereum Sepolia |
| NEAR Intents way back (USDC to NEAR) | Arrival half **live** on testnet; send half built and tested but mainnet-only, because NEAR Intents has no testnet; live 1Click quotes |
| Mainnet (trading on Base) | Built and tested, **not deployed** |
| Professional audit | **No**. Two independent AI-assisted reviews, see [`docs/SECURITY.md`](docs/SECURITY.md) |

## How NEAR is used

- **Vault contract on NEAR** (near-sdk, Rust): holds the money and enforces every rule.
- **OutLayer** (NEAR's TEE network, Intel TDX): runs the sealed strategy. Its on-chain `request_execution` can only be resolved by DCAP-verified TDX workers, so a decision delivered to the vault's callback is attested by construction.
- **Chain Signatures** (NEAR MPC): the vault contract controls its own Ethereum address and signs its own swaps; no relayer wallet ever holds the funds.
- **NEAR Intents** (1Click): brings cross-chain value back to the vault as NEAR.
- **NEP-171**: the strategy is an NFT. Its holder earns the performance fee and proposes changes; a pending proposal lapses if the NFT is sold.

## What broke, and what we learned

Things that went wrong while building, each found by a test, a rehearsal or a review, and fixed:

- **We blamed OutLayer, and the bug was ours.** On-chain enclave runs never came back, and for a day we thought OutLayer's testnet worker was down. The cause: our vault sent no compute budget, so OutLayer used its default of 1 billion instructions, and the Bulletproofs need about 2.3 billion. One line fixed it ([`180c5a2`](https://github.com/amudhan23/verifiable-alpha-vaults/commit/180c5a2)), and the docs now say the fault was ours.
- **A live rehearsal caught a launch-day bug.** The first fully attested trade on a test vault reverted on `approve`: our new gas cap (120k) was below what Sepolia's WETH needs. Fixed before the main vault ever traded on it ([`f82b407`](https://github.com/amudhan23/verifiable-alpha-vaults/commit/f82b407)).
- **We had the pool's mispricing backwards.** Sepolia's Uniswap pool prices ETH about 10× above the oracle, not below. So buys can never meet the enclave's 2% floor, and only sells fill. The executor now checks the quote before spending gas.
- **Our own checker raised a false tamper alarm.** When OutLayer's API was rate-limited, the error response was read as "different code ran". It now reports "unreachable right now" instead ([`85f37b0`](https://github.com/amudhan23/verifiable-alpha-vaults/commit/85f37b0)).
- **The vault was briefly short of spare balance.** The unstripped contract (853 KB) locked more storage deposit than the vault had spare above what it owed holders. The stripped build is 413 KB, and a solvency check now guards it ([`eab8ad4`](https://github.com/amudhan23/verifiable-alpha-vaults/commit/eab8ad4)).
- **Fuzzing found two money bugs** before any review did: an accumulator overflow and a 1-yocto over-credit ([`aff2f4c`](https://github.com/amudhan23/verifiable-alpha-vaults/commit/aff2f4c)). The full list from two independent security reviews is in [`docs/SECURITY.md`](docs/SECURITY.md).

## Repository

| Path | What it is |
|---|---|
| `contracts/vault` | The vault contract (Rust, near-sdk): shares, guardrails, commit-then-reveal, timelocks, Chain Signatures, NEAR Intents exit |
| `strategy` | The strategy (Rust to WASM): public code; parameters are sealed in OutLayer |
| `crates/proofs` | Pedersen commitments and Bulletproofs, also compiled to WASM for the browser |
| `executor` | The relayer, plus `verify.mjs` (read-only checks) and `intents.mjs` (NEAR Intents) |
| `frontend` | The site: registry, vault pages, in-browser checks, wallet, Counterfeit Bureau |
| `docs` | [`SECURITY.md`](docs/SECURITY.md), [`DEPLOYMENT.md`](docs/DEPLOYMENT.md), [`DETAILS.md`](docs/DETAILS.md), the product PDF |

Trust model in one line: the relayer is trusted only to run on time and to report the valuation shown on the chart, and attested mode removes even that. Full detail in [`docs/DETAILS.md`](docs/DETAILS.md#trust-model-stated-plainly) and [`docs/SECURITY.md`](docs/SECURITY.md).

## Where this goes

- **Who pays.** Strategy creators earn a 20% performance fee on realized gains above a high-water mark, paid to whoever holds the strategy NFT. A protocol share of that fee is the natural business model. Investors pay nothing to deposit or withdraw.
- **Why it can grow.** Every vault builds a track record nobody can fake. Strategy NFTs carry that record and the future fees, so good strategies become tradable assets, and new strategies can enter without a brand, just with proofs.
- **Next steps:**
  1. A manager-only mainnet vault on Base; the build is ready.
  2. An enclave that fetches its own prices.
  3. A factory contract and web form, so designers launch vaults without the command line.
  4. A professional audit before outside deposits.

## Built with, and disclosure

- **Everything here was written during the hackathon window.** The first commit is 11 Nov 2026; there is no pre-hackathon code.
- **AI-assisted.** Most of the code and docs were written with an AI coding assistant (Claude, by Anthropic) directed by the author, which is allowed by the rules. Both security reviews were also AI-assisted and are documented in [`docs/SECURITY.md`](docs/SECURITY.md).
- **Main libraries.** These are the direct dependencies; `Cargo.toml` and `package.json` have the full lists.
  - Rust: `near-sdk`, `near-contract-standards`, `bulletproofs`, `curve25519-dalek-ng`, `merlin`, `sha2`, `chacha20poly1305`, `uint`, `proptest`.
  - JavaScript: `near-api-js`, `chainsig.js`, `viem`, `@noble/ciphers`, `@near-wallet-selector`.
- **External services:** OutLayer (TDX enclaves), NEAR MPC (Chain Signatures), NEAR Intents 1Click API, Uniswap v3, Pyth and CoinGecko price feeds.

## License

MIT, see [`LICENSE`](LICENSE).
