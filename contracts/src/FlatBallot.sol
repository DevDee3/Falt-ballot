// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VoteBox} from "./VoteBox.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

/// @dev Arbitrum precompile (Robinhood Chain is an Arbitrum Orbit chain).
interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
    function arbBlockHash(uint256 arbBlockNum) external view returns (bytes32);
}

/// @title FlatBallot
/// @notice A permissionless election factory for $WIF on Robinhood Chain: the "decentralized voting
///         layer" made into an actual layer. Anyone can launch an election in one transaction.
///
/// HOW A VOTE WORKS (unchanged from the World is Flat UX)
///   Each option has a deposit address (see {boxAddress}). A voter sends `voteCost` $WIF to it.
///   No wallet connect, nothing to sign on a dApp. After voting closes, anyone calls {sweep} for each
///   option; that deploys the option's VoteBox at the deposit address, which burns every token in it.
///
/// WHAT IS TRUSTLESS AND WHAT IS NOT (be honest, read this)
///   * Trustless: raw tallies. The burned amount per option is read from the chain at {sweep}.
///   * Not trustless: "1 wallet = 1 vote" and sybil collapse cannot be computed on-chain because a
///     contract cannot read transfer logs. A `resolver` (the creator unless set otherwise) computes the
///     verified tally and the list of eligible voters off-chain with a PUBLIC, DETERMINISTIC ruleset and
///     commits a Merkle root of that list plus `rulesHash`. Anyone can re-run the verifier and compare.
///   * The contract bounds a resolver: verified votes per option can never exceed what was actually burned
///     for that option, and the resolver cannot change the list after committing. The draw seed is a
///     future L2 block hash that does not exist yet when the root is committed.
///   * A resolver who misreports can at most misdirect the prize pool of that single election.
///     There is no owner, no admin key, no upgrade path, and no fee recipient: protocol fees are burned.
///
/// MONEY FLOW
///   creator -> bond + initial prize ; anyone -> boosts ; voters -> burn `voteCost` per vote.
///   Finalize: 5% of the pool is burned, `bountyBps` goes to the winning option's beneficiary (if any),
///   the rest is split into `slots` equal prizes drawn (with replacement) among verified voters.
///   Bond: returned if verified votes >= `minVotes`, burned otherwise.
contract FlatBallot {
    // ------------------------------------------------------------------ constants

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal constant ARBSYS = address(0x64);

    uint256 public constant MAX_OPTIONS = 16;
    uint256 public constant MAX_SLOTS = 100;
    uint256 public constant MIN_DURATION = 10 minutes;
    uint256 public constant MAX_DURATION = 30 days;
    uint256 public constant COMMIT_WINDOW = 3 days;
    uint256 public constant CLAIM_WINDOW = 30 days;
    uint256 public constant FEE_BPS = 500; // burned
    uint256 public constant MAX_BOUNTY_BPS = 5000;
    uint256 public constant SEED_DELAY = 40; // L2 blocks between commit and the seed block
    uint256 public constant SEED_WINDOW = 200; // L2 blocks the seed hash stays readable (< 256)

    // ------------------------------------------------------------------ immutables

    address public immutable wif;
    /// @notice one whole token (10 ** decimals); the minimum price of a vote.
    uint256 public immutable unit;
    /// @notice WIF each election creator must lock as a bond.
    uint256 public immutable bondAmount;
    bytes32 public immutable boxInitCodeHash;

    // ------------------------------------------------------------------ types

    enum Status {
        None,
        Open,
        Committed,
        Finalized,
        Cancelled
    }

    struct CreateParams {
        string title;
        string[] labels;
        address[] beneficiaries; // one per option; address(0) = no beneficiary
        address resolver; // address(0) = creator
        uint40 voteStart; // 0 = now
        uint40 voteEnd;
        uint256 voteCost; // >= unit
        uint256 minVotes; // verified votes needed to get the bond back
        uint16 slots; // number of prize draws, 1..MAX_SLOTS
        uint16 bountyBps; // share of pool for the winning option's beneficiary
        uint256 initialPrize; // WIF seeded into the prize pool (in addition to the bond)
        string metadataURI; // optional (ipfs://, https://); not interpreted on-chain
    }

    struct Election {
        address creator;
        address resolver;
        Status status;
        uint8 optionCount;
        uint16 slots;
        uint16 bountyBps;
        uint40 voteStart;
        uint40 voteEnd;
        uint256 voteCost;
        uint256 minVotes;
        uint256 pool; // creator seed + boosts
        // commit
        bytes32 root;
        bytes32 rulesHash;
        uint256 entryCount;
        uint256 seedBlock;
        // finalize
        bytes32 seed;
        uint40 finalizedAt;
        uint8 winnerOption;
        uint256 voterPool;
        uint256 prizePerSlot;
        uint256 bounty;
        address bountyTo;
        uint256 claimedTotal;
        bool bountyClaimed;
        bool unclaimedSwept;
    }

    // ------------------------------------------------------------------ storage

    uint256 public nextElectionId;
    /// @notice running total of $WIF burned by this contract's elections (votes + fees + bonds).
    uint256 public totalBurned;

    mapping(uint256 => Election) internal _elections;
    mapping(uint256 => address[]) internal _beneficiaries;
    mapping(uint256 => uint256[]) internal _optionVotes; // verified votes per option (committed)
    mapping(uint256 => uint256[]) internal _sweptAmount; // WIF burned per option at sweep
    mapping(uint256 => uint256) internal _sweptMask;
    mapping(uint256 => mapping(address => uint256)) public contributed;
    mapping(uint256 => mapping(uint256 => bool)) public slotClaimed;

    uint256 private _lock = 1;

    // ------------------------------------------------------------------ events

    event ElectionCreated(uint256 indexed id, address indexed creator, address resolver, uint40 start, CreateParams params);
    event Boosted(uint256 indexed id, address indexed from, uint256 amount, uint256 pool);
    event Swept(uint256 indexed id, uint256 indexed option, address box, uint256 burned);
    event ResultsCommitted(
        uint256 indexed id, bytes32 root, bytes32 rulesHash, uint256 entryCount, uint256[] optionVotes, uint256 seedBlock
    );
    event Reseeded(uint256 indexed id, uint256 seedBlock);
    event Finalized(
        uint256 indexed id, uint8 winnerOption, bytes32 seed, uint256 entryCount, uint256 voterPool, bool bondReturned
    );
    event PrizeClaimed(uint256 indexed id, uint256 indexed slot, address indexed voter, uint256 amount);
    event BountyClaimed(uint256 indexed id, address indexed to, uint256 amount);
    event UnclaimedSwept(uint256 indexed id, address indexed to, uint256 amount);
    event Cancelled(uint256 indexed id);
    event Refunded(uint256 indexed id, address indexed to, uint256 amount);

    // ------------------------------------------------------------------ errors

    error BadParams();
    error BadState();
    error TooEarly();
    error TooLate();
    error NotResolver();
    error AlreadySwept();
    error NotAllSwept();
    error BadResults();
    error BadProof();
    error AlreadyClaimed();
    error TransferFailed();
    error Reentrancy();
    error SeedExpired();
    error SeedUnavailable();
    error NothingToDo();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address wif_, uint256 bondAmount_) {
        if (wif_ == address(0) || wif_.code.length == 0) revert BadParams();
        wif = wif_;
        unit = 10 ** uint256(IERC20(wif_).decimals());
        bondAmount = bondAmount_;
        boxInitCodeHash = keccak256(type(VoteBox).creationCode);
    }

    // ------------------------------------------------------------------ create / boost

    /// @notice Launch an election. Caller must have approved `bondAmount + p.initialPrize` WIF.
    function createElection(CreateParams calldata p) external nonReentrant returns (uint256 id) {
        uint256 n = p.labels.length;
        if (n < 2 || n > MAX_OPTIONS || p.beneficiaries.length != n) revert BadParams();
        uint256 tl = bytes(p.title).length;
        if (tl == 0 || tl > 140) revert BadParams();
        for (uint256 i; i < n; ++i) {
            uint256 l = bytes(p.labels[i]).length;
            if (l == 0 || l > 64) revert BadParams();
        }
        if (p.voteCost < unit || p.minVotes == 0) revert BadParams();
        if (p.slots == 0 || p.slots > MAX_SLOTS || p.bountyBps > MAX_BOUNTY_BPS) revert BadParams();

        uint256 start = p.voteStart == 0 ? block.timestamp : uint256(p.voteStart);
        if (start < block.timestamp) revert BadParams();
        if (p.voteEnd < start + MIN_DURATION || p.voteEnd > start + MAX_DURATION) revert BadParams();

        address resolver = p.resolver == address(0) ? msg.sender : p.resolver;

        id = ++nextElectionId;
        Election storage e = _elections[id];
        e.creator = msg.sender;
        e.resolver = resolver;
        e.status = Status.Open;
        e.optionCount = uint8(n);
        e.slots = p.slots;
        e.bountyBps = p.bountyBps;
        e.voteStart = uint40(start);
        e.voteEnd = p.voteEnd;
        e.voteCost = p.voteCost;
        e.minVotes = p.minVotes;
        for (uint256 i; i < n; ++i) {
            _beneficiaries[id].push(p.beneficiaries[i]);
        }

        if (p.initialPrize > 0) {
            contributed[id][msg.sender] = p.initialPrize;
            e.pool = p.initialPrize;
        }

        emit ElectionCreated(id, msg.sender, resolver, uint40(start), p);
        if (p.initialPrize > 0) emit Boosted(id, msg.sender, p.initialPrize, p.initialPrize);

        _pull(msg.sender, bondAmount + p.initialPrize);
    }

    /// @notice Add WIF to an election's prize pool. Allowed until the resolver commits results, so
    ///         nobody can add (or front-run) money after the draw inputs are fixed.
    function boost(uint256 id, uint256 amount) external nonReentrant {
        Election storage e = _elections[id];
        if (e.status != Status.Open) revert BadState();
        if (amount == 0) revert BadParams();
        contributed[id][msg.sender] += amount;
        e.pool += amount;
        emit Boosted(id, msg.sender, amount, e.pool);
        _pull(msg.sender, amount);
    }

    // ------------------------------------------------------------------ vote boxes

    /// @notice Deposit address for `option` of election `id`. Send `voteCost` WIF here to vote.
    function boxAddress(uint256 id, uint256 option) public view returns (address) {
        bytes32 salt = keccak256(abi.encode(id, option));
        bytes32 h = keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, boxInitCodeHash));
        return address(uint160(uint256(h)));
    }

    /// @notice After voting closes: deploy the option's VoteBox, burning every WIF in it.
    ///         Callable by anyone, once per option. Records the burned amount (the raw, trustless tally).
    function sweep(uint256 id, uint256 option) external nonReentrant {
        Election storage e = _elections[id];
        if (e.status == Status.None) revert BadState();
        if (option >= e.optionCount) revert BadParams();
        if (block.timestamp <= e.voteEnd) revert TooEarly();
        uint256 bit = 1 << option;
        if (_sweptMask[id] & bit != 0) revert AlreadySwept();
        _sweptMask[id] |= bit;

        address box = boxAddress(id, option);
        uint256 burned = IERC20(wif).balanceOf(box);

        uint256[] storage swept = _sweptAmount[id];
        if (swept.length == 0) {
            for (uint256 i; i < e.optionCount; ++i) {
                swept.push(0);
            }
        }
        swept[option] = burned;
        totalBurned += burned;

        VoteBox deployed = new VoteBox{salt: keccak256(abi.encode(id, option))}();
        if (address(deployed) != box) revert BadState();
        if (IERC20(wif).balanceOf(box) != 0) revert TransferFailed();

        emit Swept(id, option, box, burned);
    }

    // ------------------------------------------------------------------ results

    /// @notice Resolver commits the verified tally.
    /// @param root Merkle root over eligible voters, leaf = keccak256(abi.encodePacked(index, voter, option)),
    ///        indices 0..entryCount-1, sorted-pair keccak256 hashing, odd nodes promoted unchanged.
    /// @param rulesHash keccak256 of the exact ruleset the verifier ran (published, reproducible).
    /// @param votes verified votes per option. Each verified vote is one eligible voter, so the sum is the
    ///        number of draw entries. Each entry is bounded by what was really burned for that option.
    function commitResults(uint256 id, bytes32 root, bytes32 rulesHash, uint256[] calldata votes) external nonReentrant {
        Election storage e = _elections[id];
        if (msg.sender != e.resolver) revert NotResolver();
        if (e.status != Status.Open) revert BadState();
        if (block.timestamp <= e.voteEnd) revert TooEarly();
        if (block.timestamp > uint256(e.voteEnd) + COMMIT_WINDOW) revert TooLate();
        uint256 n = e.optionCount;
        if (_sweptMask[id] != (uint256(1) << n) - 1) revert NotAllSwept();
        if (votes.length != n) revert BadResults();

        uint256 total;
        uint256[] storage swept = _sweptAmount[id];
        uint256 cost = e.voteCost;
        for (uint256 i; i < n; ++i) {
            if (votes[i] > swept[i] / cost) revert BadResults();
            total += votes[i];
            _optionVotes[id].push(votes[i]);
        }
        if (total > 0 && root == bytes32(0)) revert BadResults();

        e.root = root;
        e.rulesHash = rulesHash;
        e.entryCount = total;
        e.seedBlock = _l2Block() + SEED_DELAY;
        e.status = Status.Committed;

        emit ResultsCommitted(id, root, rulesHash, total, votes, e.seedBlock);
    }

    /// @notice If nobody finalized inside the seed window, move the seed block forward. The committed
    ///         root is untouched, so this only re-rolls randomness for an unfinalized election.
    function reseed(uint256 id) external {
        Election storage e = _elections[id];
        if (e.status != Status.Committed) revert BadState();
        if (_l2Block() <= e.seedBlock + SEED_WINDOW) revert TooEarly();
        e.seedBlock = _l2Block() + SEED_DELAY;
        emit Reseeded(id, e.seedBlock);
    }

    /// @notice Fix the draw seed from the (previously future) block and settle money. Anyone can call it
    ///         once `seedBlock` has passed and while the block hash is still readable.
    function finalize(uint256 id) external nonReentrant {
        Election storage e = _elections[id];
        if (e.status != Status.Committed) revert BadState();
        uint256 cur = _l2Block();
        if (cur <= e.seedBlock) revert TooEarly();
        if (cur > e.seedBlock + SEED_WINDOW) revert SeedExpired();
        bytes32 seed = _l2BlockHash(e.seedBlock);
        if (seed == bytes32(0)) revert SeedUnavailable();

        if (e.entryCount == 0) {
            _cancel(id, e);
            return;
        }
        _settle(id, e, seed);
    }

    /// @dev Effects first, then token movements.
    function _settle(uint256 id, Election storage e, bytes32 seed) internal {
        uint8 winner = _winningOption(id);
        address bountyTo = _beneficiaries[id][winner];
        uint256 fee = (e.pool * FEE_BPS) / 10_000;
        uint256 bounty = bountyTo == address(0) ? 0 : (e.pool * e.bountyBps) / 10_000;

        e.status = Status.Finalized;
        e.seed = seed;
        e.finalizedAt = uint40(block.timestamp);
        e.winnerOption = winner;
        e.voterPool = e.pool - fee - bounty;
        e.prizePerSlot = e.voterPool / e.slots;
        e.bounty = bounty;
        e.bountyTo = bountyTo;

        bool bondReturned = e.entryCount >= e.minVotes;
        if (bondReturned) _send(e.creator, bondAmount);
        else _burn(bondAmount);
        _burn(fee);

        emit Finalized(id, winner, seed, e.entryCount, e.voterPool, bondReturned);
    }

    /// @dev Option with the most verified votes; ties go to the lowest option index.
    function _winningOption(uint256 id) internal view returns (uint8 winner) {
        uint256[] storage votes = _optionVotes[id];
        uint256 best;
        for (uint256 i; i < votes.length; ++i) {
            if (votes[i] > best) {
                best = votes[i];
                winner = uint8(i);
            }
        }
    }

    // ------------------------------------------------------------------ claims

    /// @notice Which verified-voter index wins prize `slot`. Draws are with replacement.
    function winnerIndex(uint256 id, uint256 slot) public view returns (uint256) {
        Election storage e = _elections[id];
        if (e.status != Status.Finalized) revert BadState();
        return uint256(keccak256(abi.encode(e.seed, slot))) % e.entryCount;
    }

    /// @notice Pay prize `slot` to its winner. Anyone may call it (the money always goes to `voter`).
    function claimPrize(uint256 id, uint256 slot, uint256 index, address voter, uint8 option, bytes32[] calldata proof)
        external
        nonReentrant
    {
        Election storage e = _elections[id];
        if (e.status != Status.Finalized) revert BadState();
        if (slot >= e.slots) revert BadParams();
        if (block.timestamp > uint256(e.finalizedAt) + CLAIM_WINDOW) revert TooLate();
        if (slotClaimed[id][slot]) revert AlreadyClaimed();
        if (index != winnerIndex(id, slot)) revert BadProof();
        if (option >= e.optionCount) revert BadProof();
        bytes32 leaf = keccak256(abi.encodePacked(index, voter, option));
        if (!_verify(proof, e.root, leaf)) revert BadProof();

        slotClaimed[id][slot] = true;
        uint256 amount = e.prizePerSlot;
        e.claimedTotal += amount;
        _send(voter, amount);
        emit PrizeClaimed(id, slot, voter, amount);
    }

    /// @notice Pay the winning option's beneficiary. Callable by anyone, never expires.
    function claimBounty(uint256 id) external nonReentrant {
        Election storage e = _elections[id];
        if (e.status != Status.Finalized) revert BadState();
        if (e.bounty == 0 || e.bountyClaimed) revert NothingToDo();
        e.bountyClaimed = true;
        _send(e.bountyTo, e.bounty);
        emit BountyClaimed(id, e.bountyTo, e.bounty);
    }

    /// @notice After the claim window, return prizes nobody claimed (and rounding dust) to the creator.
    function sweepUnclaimed(uint256 id) external nonReentrant {
        Election storage e = _elections[id];
        if (e.status != Status.Finalized) revert BadState();
        if (block.timestamp <= uint256(e.finalizedAt) + CLAIM_WINDOW) revert TooEarly();
        if (e.unclaimedSwept) revert NothingToDo();
        e.unclaimedSwept = true;
        uint256 remaining = e.voterPool - e.claimedTotal;
        _send(e.creator, remaining);
        emit UnclaimedSwept(id, e.creator, remaining);
    }

    // ------------------------------------------------------------------ cancel / refund

    /// @notice If the resolver never committed in time, anyone can cancel. The bond is burned and every
    ///         contributor can {refund} their own contribution.
    function cancelUncommitted(uint256 id) external nonReentrant {
        Election storage e = _elections[id];
        if (e.status != Status.Open) revert BadState();
        if (block.timestamp <= uint256(e.voteEnd) + COMMIT_WINDOW) revert TooEarly();
        _cancel(id, e);
    }

    function refund(uint256 id) external nonReentrant {
        Election storage e = _elections[id];
        if (e.status != Status.Cancelled) revert BadState();
        uint256 amount = contributed[id][msg.sender];
        if (amount == 0) revert NothingToDo();
        contributed[id][msg.sender] = 0;
        _send(msg.sender, amount);
        emit Refunded(id, msg.sender, amount);
    }

    // ------------------------------------------------------------------ views

    function getElection(uint256 id) external view returns (Election memory) {
        return _elections[id];
    }

    function getBeneficiaries(uint256 id) external view returns (address[] memory) {
        return _beneficiaries[id];
    }

    function getOptionVotes(uint256 id) external view returns (uint256[] memory) {
        return _optionVotes[id];
    }

    /// @notice WIF burned per option at sweep (the trustless raw tally, in token units).
    function getSweptAmounts(uint256 id) external view returns (uint256[] memory) {
        return _sweptAmount[id];
    }

    function sweptMask(uint256 id) external view returns (uint256) {
        return _sweptMask[id];
    }

    /// @notice Live raw tally in token units for an option that has not been swept yet.
    function pendingRaw(uint256 id, uint256 option) external view returns (uint256) {
        return IERC20(wif).balanceOf(boxAddress(id, option));
    }

    function l2Block() external view returns (uint256) {
        return _l2Block();
    }

    // ------------------------------------------------------------------ internals

    function _cancel(uint256 id, Election storage e) internal {
        e.status = Status.Cancelled;
        _burn(bondAmount);
        emit Cancelled(id);
    }

    function _verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        if (proof.length > 32) return false;
        bytes32 h = leaf;
        for (uint256 i; i < proof.length; ++i) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == root;
    }

    function _isArbitrum() internal view returns (bool) {
        return ARBSYS.code.length > 0;
    }

    /// @dev On Arbitrum `block.number` is an L1 estimate; the real L2 height comes from ArbSys.
    function _l2Block() internal view returns (uint256) {
        if (_isArbitrum()) {
            (bool ok, bytes memory ret) = ARBSYS.staticcall(abi.encodeWithSelector(IArbSys.arbBlockNumber.selector));
            if (!ok || ret.length != 32) revert SeedUnavailable();
            return abi.decode(ret, (uint256));
        }
        return block.number;
    }

    /// @dev On Arbitrum `blockhash` is pseudo-random and insecure; use the precompile. Never fall back.
    function _l2BlockHash(uint256 n) internal view returns (bytes32) {
        if (_isArbitrum()) {
            (bool ok, bytes memory ret) = ARBSYS.staticcall(abi.encodeWithSelector(IArbSys.arbBlockHash.selector, n));
            if (!ok || ret.length != 32) revert SeedUnavailable();
            return abi.decode(ret, (bytes32));
        }
        return blockhash(n);
    }

    function _pull(address from, uint256 amount) internal {
        if (amount == 0) return;
        uint256 before = IERC20(wif).balanceOf(address(this));
        _call(abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));
        if (IERC20(wif).balanceOf(address(this)) - before != amount) revert TransferFailed();
    }

    function _send(address to, uint256 amount) internal {
        if (amount == 0) return;
        _call(abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function _burn(uint256 amount) internal {
        if (amount == 0) return;
        totalBurned += amount;
        _call(abi.encodeCall(IERC20.transfer, (DEAD, amount)));
    }

    function _call(bytes memory data) internal {
        (bool ok, bytes memory ret) = wif.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
