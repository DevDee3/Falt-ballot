# Flat Ballot

A permissionless **$WIF election layer** on Robinhood Chain (chain ID 4663), built for the World is Flat hackathon.

Anyone opens an election, funds a prize pool in $WIF, and shares one deposit address per option. Voters send $WIF to the option they back. **Every vote is burned.** A public, deterministic verifier counts one vote per wallet, rejects contracts and wallet clusters funded by one sender, and commits a Merkle root on-chain. Prize winners are drawn from a block that did not exist when the root was committed and claim with Merkle proofs. No owner, no admin keys.

Categories: Social and Creators, Games, Tools and Infra, Agents and AI, Hooks and DeFi (value burn + prize flow).

## Flywheel
Elections need $WIF (bond + prize + votes) -> votes burn $WIF and 5% of every pool burns -> less supply, more reasons to hold $WIF -> more people run elections and the AI host agent launches new ones on its own.

## Layout
- `contracts/` FlatBallot + VoteBox (Foundry, 43 tests incl. fuzz and supply conservation)
- `verifier/` public verifier (TypeScript), CLI, and the host agent (`src/agent.ts`)
- `web/` Next.js 14 app, Reown AppKit wallet connect

## Run locally
```
cd contracts && forge test
cd ../verifier && npm i && npx vitest run
anvil &                              # local chain
npx tsx scripts/seed-local.ts        # deploys mocks, seeds 2 elections, writes web/.env.local
cd ../web && npm i --legacy-peer-deps && npm run dev
```

## Deploy to Robinhood Chain (mainnet)
1. Contract (needs ETH for gas on chain 4663):
   ```
   cd contracts
   WIF=0x5173b8eA6923c2d40267890D45C46a3480954773 BOND=<bond in WIF base units> \
   forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --private-key $PK --broadcast
   ```
   Check $WIF `decimals()` first and size BOND accordingly (default intent: 1,000 $WIF).
2. Frontend env (Vercel): copy `web/.env.example`, set `NEXT_PUBLIC_BALLOT`, `NEXT_PUBLIC_DEPLOY_BLOCK`, `NEXT_PUBLIC_WIF_DEPLOY_BLOCK`, `NEXT_PUBLIC_CHAIN_ID=4663`, `NEXT_PUBLIC_RPC_URL`, and `NEXT_PUBLIC_REOWN_PROJECT_ID` (free at cloud.reown.com, allowlist your domain). Lower `NEXT_PUBLIC_LOG_CHUNK` if the RPC limits `eth_getLogs`.
3. Agent (keep running until the final closes):
   ```
   cd verifier
   RPC=... BALLOT=... WIF=... PK=... DEPLOY_BLOCK=... WIF_DEPLOY_BLOCK=... npm run agent loop
   ```
   Set `ANTHROPIC_API_KEY` for Claude-written topics; otherwise it uses a built-in list.
4. Real transactions for the submission: launch an election, vote from a few wallets, let it close, then `agent tend` (sweep, commit, finalize, claim). Save the explorer links.

## Verify any result yourself
```
cd verifier && npm run verify -- verify --rpc $RPC --ballot $BALLOT --wif $WIF --id 1 --from-block <block> --funder-from-block <wif deploy block>
```
Exit code 0 means the on-chain commitment was reproduced. The web app has the same check behind "Recompute from the chain".

## Honest limits
- Sybil rules v1 are heuristic (EOA only, one vote per wallet, max 3 wallets per funder). The ruleset hash is committed on-chain so it is auditable, not perfect.
- The resolver is trusted but bounded: it cannot commit more votes than were actually burned, and a wrong root is detectable by anyone re-running the verifier. If it never commits, the election is cancellable and refundable.
- Not audited. Treat as hackathon software.

## License

This project is licensed under the [MIT License](LICENSE).

## Demo video outline (about 2 minutes)
1. Home page: what a tally sheet is. 2. Create an election. 3. Vote from the connected wallet, show the burn. 4. After close: Recompute from the chain, show rejected sybils. 5. Finalize, winner claim. 6. Show the agent log launching and settling an election on its own.
