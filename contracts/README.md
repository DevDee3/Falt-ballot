# Flat Ballot contracts

The `contracts/` package contains the on-chain election protocol for Flat Ballot. It is built with Foundry and Solidity `0.8.28`.

## What the contracts do

### `FlatBallot`

`FlatBallot` is a permissionless election factory for an ERC-20 `$WIF` token. It has no owner, admin key, upgrade path, or fee recipient.

The constructor receives:

- `wif`: the `$WIF` ERC-20 contract address.
- `bondAmount`: the `$WIF` bond required from each election creator.

An election creator calls `createElection` after approving the bond plus the initial prize. Each election stores its title, options, voting window, vote cost, minimum verified votes, prize slots, resolver, optional beneficiaries, and metadata URI. Anyone can add to the pool with `boost`.

### `VoteBox`

Every option receives a deterministic deposit address from `boxAddress`. Voters send `$WIF` directly to that address, so voting does not require a wallet connection or an app transaction.

After the voting period closes, anyone can call `sweep` for each option. `FlatBallot` deploys that option's `VoteBox`; the box burns its entire `$WIF` balance and the contract records the raw amount burned. These burned amounts are the trustless on-chain tally.

## Election lifecycle

1. The creator approves `$WIF` and calls `createElection`.
2. Voters send `$WIF` to an option's deposit address.
3. Anyone sweeps each option after voting closes, burning the deposited tokens.
4. The resolver runs the public deterministic verifier and commits a Merkle root, rules hash, and verified vote counts with `commitResults`.
5. Anyone calls `finalize` after the commit delay. A future L2 block supplies the prize draw seed.
6. Winners claim Merkle-proven prizes with `claimPrize`; the winning option's beneficiary can claim its bounty.

At finalization, 5% of the pool is burned. The remaining voter pool is divided into the configured prize slots. The creator's bond is returned when the minimum verified vote count is reached; otherwise it is burned. If results are never committed, the election can be cancelled and contributors can be refunded.

The contract limits elections to 2–16 options, 1–100 prize slots, 10 minutes–30 days of voting, and a maximum 50% bounty. The resolver is bounded by the raw amounts burned on-chain, but the one-wallet-one-vote and Sybil rules are computed off-chain by the public verifier. Anyone can independently rerun that verifier and compare the committed root.

## Build and test

```bash
forge build
forge test
forge test -vvv
forge fmt --check
```

## Local Anvil workflow

Start Anvil in one terminal:

```bash
anvil
```

Then run the local deployment/seeding script from the project directory as documented in the repository root. The local chain must be running at `http://127.0.0.1:8545` before the script sends transactions.

## Deploy

`Deploy.s.sol` reads two environment variables:

- `WIF`: an ERC-20 contract deployed on the same network as the RPC.
- `BOND`: the bond amount in the token's base units.

For an encrypted Foundry keystore account:

```bash
export RPC_URL="https://YOUR_RPC_URL"
export WIF="0xWIF_CONTRACT_ON_THIS_NETWORK"
export BOND="1000000000000000000000"

cast wallet address --account 0xdeployer

forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL" \
  --account 0xdeployer \
  --sender "$(cast wallet address --account 0xdeployer)" \
  --broadcast
```

Foundry prompts for the keystore password. `BOND` must use the `$WIF` token's decimals; the example assumes 18 decimals. Check the token's decimals before choosing the amount:

```bash
cast call "$WIF" "decimals()(uint8)" --rpc-url "$RPC_URL"
```

The `$WIF` address must contain contract bytecode on the selected network. A mainnet token address cannot be passed to a testnet deployment unless that token is also deployed on the testnet.

## Important safety note

The contracts are not audited. Test locally, verify the `$WIF` address and chain ID, and review the deployment transaction before using real funds.
