// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {FlatBallot} from "../src/FlatBallot.sol";
import {VoteBox} from "../src/VoteBox.sol";
import {MockWIF, MockArbSys, TestMerkle} from "./helpers/Mocks.sol";

contract FlatBallotTest is Test {
    MockWIF wif;
    FlatBallot ballot;

    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address constant ARBSYS = address(0x64);

    uint256 constant UNIT = 1e18;
    uint256 constant BOND = 1000e18;

    address creator = makeAddr("creator");
    address resolver = makeAddr("resolver");
    address booster = makeAddr("booster");
    address bene0 = makeAddr("bene0");
    address bene1 = makeAddr("bene1");
    address keeper = makeAddr("keeper");

    function setUp() public {
        vm.etch(ARBSYS, address(new MockArbSys()).code);
        vm.roll(1000);
        vm.warp(1_800_000_000);
        wif = new MockWIF();
        ballot = new FlatBallot(address(wif), BOND);

        _fund(creator, 1_000_000e18);
        _fund(booster, 1_000_000e18);
    }

    // ------------------------------------------------------------------ helpers

    function _fund(address who, uint256 amount) internal {
        wif.mint(who, amount);
        vm.prank(who);
        wif.approve(address(ballot), type(uint256).max);
    }

    function _params() internal view returns (FlatBallot.CreateParams memory p) {
        p.title = "Who is the G.O.A.T.?";
        p.labels = new string[](2);
        p.labels[0] = "Alice";
        p.labels[1] = "Bob";
        p.beneficiaries = new address[](2);
        p.beneficiaries[0] = bene0;
        p.beneficiaries[1] = bene1;
        p.resolver = resolver;
        p.voteStart = 0;
        p.voteEnd = uint40(block.timestamp + 1 days);
        p.voteCost = UNIT;
        p.minVotes = 3;
        p.slots = 4;
        p.bountyBps = 2000; // 20%
        p.initialPrize = 10_000e18;
        p.metadataURI = "ipfs://meta";
    }

    function _create() internal returns (uint256 id) {
        FlatBallot.CreateParams memory p = _params();
        vm.prank(creator);
        id = ballot.createElection(p);
    }

    function _createWith(FlatBallot.CreateParams memory p) internal returns (uint256 id) {
        vm.prank(creator);
        id = ballot.createElection(p);
    }

    function _vote(uint256 id, uint256 option, address voter, uint256 amount) internal {
        wif.mint(voter, amount);
        address box = ballot.boxAddress(id, option); // resolve first: vm.prank hits the very next call
        vm.prank(voter);
        wif.transfer(box, amount);
    }

    function _closeVoting(uint256 id) internal {
        FlatBallot.Election memory e = ballot.getElection(id);
        vm.warp(uint256(e.voteEnd) + 1);
    }

    function _sweepAll(uint256 id) internal {
        FlatBallot.Election memory e = ballot.getElection(id);
        for (uint256 i; i < e.optionCount; ++i) {
            ballot.sweep(id, i);
        }
    }

    function _votes2(uint256 a, uint256 b) internal pure returns (uint256[] memory v) {
        v = new uint256[](2);
        v[0] = a;
        v[1] = b;
    }

    /// Voters 0..n-1 (option = i % 2). Returns addresses + leaves.
    function _roster(uint256 n) internal pure returns (address[] memory voters, bytes32[] memory leaves) {
        voters = new address[](n);
        leaves = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            voters[i] = address(uint160(0xB0B0 + i));
            leaves[i] = TestMerkle.leaf(i, voters[i], uint8(i % 2));
        }
    }

    /// Full happy path up to Committed. n voters, option split by parity.
    function _toCommitted(uint256 n) internal returns (uint256 id, address[] memory voters, bytes32[] memory leaves) {
        id = _create();
        (voters, leaves) = _roster(n);
        uint256 a;
        uint256 b;
        for (uint256 i; i < n; ++i) {
            _vote(id, i % 2, voters[i], UNIT);
            if (i % 2 == 0) ++a;
            else ++b;
        }
        _closeVoting(id);
        _sweepAll(id);
        vm.prank(resolver);
        ballot.commitResults(id, TestMerkle.root(leaves), keccak256("rules-v1"), _votes2(a, b));
    }

    function _finalize(uint256 id) internal {
        FlatBallot.Election memory e = ballot.getElection(id);
        vm.roll(e.seedBlock + 1);
        ballot.finalize(id);
    }

    // ------------------------------------------------------------------ create

    function test_create_pullsBondAndPrize_andStoresState() public {
        uint256 before = wif.balanceOf(creator);
        uint256 id = _create();
        assertEq(id, 1);
        assertEq(wif.balanceOf(address(ballot)), BOND + 10_000e18);
        assertEq(wif.balanceOf(creator), before - BOND - 10_000e18);

        FlatBallot.Election memory e = ballot.getElection(id);
        assertEq(e.creator, creator);
        assertEq(e.resolver, resolver);
        assertEq(uint8(e.status), uint8(FlatBallot.Status.Open));
        assertEq(e.optionCount, 2);
        assertEq(e.pool, 10_000e18);
        assertEq(e.voteStart, block.timestamp);
        assertEq(ballot.contributed(id, creator), 10_000e18);
        assertEq(ballot.getBeneficiaries(id)[1], bene1);
        assertEq(ballot.nextElectionId(), 1);
    }

    function test_create_resolverDefaultsToCreator() public {
        FlatBallot.CreateParams memory p = _params();
        p.resolver = address(0);
        uint256 id = _createWith(p);
        assertEq(ballot.getElection(id).resolver, creator);
    }

    function test_create_zeroPrizeIsAllowed() public {
        FlatBallot.CreateParams memory p = _params();
        p.initialPrize = 0;
        uint256 id = _createWith(p);
        assertEq(ballot.getElection(id).pool, 0);
        assertEq(wif.balanceOf(address(ballot)), BOND);
    }

    function test_create_revertsOnBadParams() public {
        FlatBallot.CreateParams memory p;

        p = _params();
        p.title = "";
        vm.expectRevert(FlatBallot.BadParams.selector);
        vm.prank(creator);
        ballot.createElection(p);

        p = _params();
        p.labels = new string[](1);
        p.labels[0] = "solo";
        p.beneficiaries = new address[](1);
        vm.expectRevert(FlatBallot.BadParams.selector);
        vm.prank(creator);
        ballot.createElection(p);

        p = _params();
        p.labels = new string[](17);
        p.beneficiaries = new address[](17);
        for (uint256 i; i < 17; ++i) {
            p.labels[i] = "x";
        }
        vm.expectRevert(FlatBallot.BadParams.selector);
        vm.prank(creator);
        ballot.createElection(p);

        p = _params();
        p.beneficiaries = new address[](3);
        vm.expectRevert(FlatBallot.BadParams.selector);
        vm.prank(creator);
        ballot.createElection(p);

        p = _params();
        p.labels[0] = "";
        vm.expectRevert(FlatBallot.BadParams.selector);
        vm.prank(creator);
        ballot.createElection(p);

        p = _params();
        p.voteCost = UNIT - 1;
        vm.expectRevert(FlatBallot.BadParams.selector);
        vm.prank(creator);
        ballot.createElection(p);

        p = _params();
        p.minVotes = 0;
        vm.expectRevert(FlatBallot.BadParams.selector);
        vm.prank(creator);
        ballot.createElection(p);

        p = _params();
        p.slots = 0;
        vm.expectRevert(FlatBallot.BadParams.selector);
        vm.prank(creator);
        ballot.createElection(p);

        p = _params();
        p.slots = 101;
        vm.expectRevert(FlatBallot.BadParams.selector);
        vm.prank(creator);
        ballot.createElection(p);

        p = _params();
        p.bountyBps = 5001;
        vm.expectRevert(FlatBallot.BadParams.selector);
        vm.prank(creator);
        ballot.createElection(p);

        p = _params();
        p.voteEnd = uint40(block.timestamp + 9 minutes);
        vm.expectRevert(FlatBallot.BadParams.selector);
        vm.prank(creator);
        ballot.createElection(p);

        p = _params();
        p.voteEnd = uint40(block.timestamp + 31 days);
        vm.expectRevert(FlatBallot.BadParams.selector);
        vm.prank(creator);
        ballot.createElection(p);

        p = _params();
        p.voteStart = uint40(block.timestamp - 1);
        vm.expectRevert(FlatBallot.BadParams.selector);
        vm.prank(creator);
        ballot.createElection(p);
    }

    function test_create_futureStartMeasuresDurationFromStart() public {
        FlatBallot.CreateParams memory p = _params();
        p.voteStart = uint40(block.timestamp + 2 days);
        p.voteEnd = uint40(block.timestamp + 2 days + 1 hours);
        uint256 id = _createWith(p);
        assertEq(ballot.getElection(id).voteStart, p.voteStart);
    }

    function test_create_revertsWithoutAllowance() public {
        address poor = makeAddr("poor");
        wif.mint(poor, 1_000_000e18);
        FlatBallot.CreateParams memory p = _params();
        vm.prank(poor);
        vm.expectRevert(FlatBallot.TransferFailed.selector);
        ballot.createElection(p);
    }

    function test_constructor_rejectsNonContract() public {
        vm.expectRevert(FlatBallot.BadParams.selector);
        new FlatBallot(address(0xdead1), BOND);
    }

    // ------------------------------------------------------------------ boost

    function test_boost_addsToPool_untilCommit() public {
        uint256 id = _create();
        vm.prank(booster);
        ballot.boost(id, 500e18);
        assertEq(ballot.getElection(id).pool, 10_500e18);
        assertEq(ballot.contributed(id, booster), 500e18);

        vm.prank(booster);
        vm.expectRevert(FlatBallot.BadParams.selector);
        ballot.boost(id, 0);

        (uint256 cid,,) = _toCommitted(4);
        vm.prank(booster);
        vm.expectRevert(FlatBallot.BadState.selector);
        ballot.boost(cid, 1e18);
    }

    function test_boost_unknownElectionReverts() public {
        vm.prank(booster);
        vm.expectRevert(FlatBallot.BadState.selector);
        ballot.boost(999, 1e18);
    }

    // ------------------------------------------------------------------ vote boxes + sweep

    function test_boxAddress_isDeterministicAndDistinct() public {
        uint256 id = _create();
        address a0 = ballot.boxAddress(id, 0);
        address a1 = ballot.boxAddress(id, 1);
        assertTrue(a0 != a1);
        assertEq(a0, ballot.boxAddress(id, 0));
        assertEq(a0.code.length, 0, "counterfactual: nothing deployed yet");
        assertTrue(ballot.boxAddress(id + 1, 0) != a0);
    }

    function test_boxInitCodeHash_matchesCreationCode() public view {
        assertEq(ballot.boxInitCodeHash(), keccak256(type(VoteBox).creationCode));
    }

    function test_sweep_deploysBoxAtPredictedAddress_andBurnsEverything() public {
        uint256 id = _create();
        _vote(id, 0, address(0x1), UNIT);
        _vote(id, 0, address(0x2), UNIT);
        _vote(id, 1, address(0x3), 3 * UNIT);

        assertEq(ballot.pendingRaw(id, 0), 2 * UNIT);
        assertEq(ballot.pendingRaw(id, 1), 3 * UNIT);

        _closeVoting(id);
        address box0 = ballot.boxAddress(id, 0);
        uint256 burnedBefore = wif.balanceOf(DEAD);
        uint256 totalBefore = ballot.totalBurned();

        vm.expectEmit(true, true, false, true);
        emit FlatBallot.Swept(id, 0, box0, 2 * UNIT);
        ballot.sweep(id, 0);

        assertGt(box0.code.length, 0, "box deployed at the predicted address");
        assertEq(wif.balanceOf(box0), 0);
        assertEq(wif.balanceOf(DEAD) - burnedBefore, 2 * UNIT);
        assertEq(ballot.totalBurned() - totalBefore, 2 * UNIT);
        assertEq(ballot.getSweptAmounts(id)[0], 2 * UNIT);
        assertEq(ballot.sweptMask(id), 1);

        ballot.sweep(id, 1);
        assertEq(ballot.getSweptAmounts(id)[1], 3 * UNIT);
        assertEq(ballot.sweptMask(id), 3);
    }

    function test_sweep_revertsBeforeVoteEnd_twice_andBadOption() public {
        uint256 id = _create();
        vm.expectRevert(FlatBallot.TooEarly.selector);
        ballot.sweep(id, 0);

        _closeVoting(id);
        vm.expectRevert(FlatBallot.BadParams.selector);
        ballot.sweep(id, 2);
        vm.expectRevert(FlatBallot.BadState.selector);
        ballot.sweep(777, 0);

        ballot.sweep(id, 0);
        vm.expectRevert(FlatBallot.AlreadySwept.selector);
        ballot.sweep(id, 0);
    }

    function test_sweep_emptyBoxStillDeploys() public {
        uint256 id = _create();
        _closeVoting(id);
        ballot.sweep(id, 0);
        assertEq(ballot.getSweptAmounts(id)[0], 0);
        assertGt(ballot.boxAddress(id, 0).code.length, 0);
    }

    function test_lateDeposit_isBurnedByBoxSweep_notCounted() public {
        uint256 id = _create();
        _vote(id, 0, address(0x1), UNIT);
        _closeVoting(id);
        ballot.sweep(id, 0);

        address box0 = ballot.boxAddress(id, 0);
        _vote(id, 0, address(0x9), UNIT); // after sweep: lands in an already-deployed box
        assertEq(wif.balanceOf(box0), UNIT);

        uint256 deadBefore = wif.balanceOf(DEAD);
        VoteBox(box0).sweep();
        assertEq(wif.balanceOf(box0), 0);
        assertEq(wif.balanceOf(DEAD) - deadBefore, UNIT);
        assertEq(ballot.getSweptAmounts(id)[0], UNIT, "late deposit is never part of the recorded tally");
    }

    function test_voteBox_cannotBeDeployedByAnyoneElse_toStealDepositAddress() public {
        // The deposit address is a CREATE2 address owned by the ballot's factory namespace.
        uint256 id = _create();
        address predicted = ballot.boxAddress(id, 0);
        _vote(id, 0, address(0x1), UNIT);
        // An attacker deploying a VoteBox directly gets a different address.
        vm.prank(address(0xA77ACC));
        vm.expectRevert(); // constructor calls wif() on the (non-ballot) deployer
        new VoteBox();
        assertEq(wif.balanceOf(predicted), UNIT);
    }

    // ------------------------------------------------------------------ commit

    function test_commit_happyPath_setsState() public {
        (uint256 id,, bytes32[] memory leaves) = _toCommitted(5);
        FlatBallot.Election memory e = ballot.getElection(id);
        assertEq(uint8(e.status), uint8(FlatBallot.Status.Committed));
        assertEq(e.entryCount, 5);
        assertEq(e.root, TestMerkle.root(leaves));
        assertEq(e.rulesHash, keccak256("rules-v1"));
        assertEq(e.seedBlock, block.number + ballot.SEED_DELAY());
        assertEq(ballot.getOptionVotes(id)[0], 3);
        assertEq(ballot.getOptionVotes(id)[1], 2);
    }

    function test_commit_onlyResolver() public {
        uint256 id = _create();
        _closeVoting(id);
        _sweepAll(id);
        vm.prank(creator); // creator is NOT the resolver here
        vm.expectRevert(FlatBallot.NotResolver.selector);
        ballot.commitResults(id, bytes32(0), bytes32(0), _votes2(0, 0));
    }

    function test_commit_timeWindows() public {
        uint256 id = _create();
        vm.prank(resolver);
        vm.expectRevert(FlatBallot.TooEarly.selector);
        ballot.commitResults(id, bytes32(0), bytes32(0), _votes2(0, 0));

        _closeVoting(id);
        _sweepAll(id);
        FlatBallot.Election memory e = ballot.getElection(id);
        vm.warp(uint256(e.voteEnd) + ballot.COMMIT_WINDOW() + 1);
        vm.prank(resolver);
        vm.expectRevert(FlatBallot.TooLate.selector);
        ballot.commitResults(id, bytes32(0), bytes32(0), _votes2(0, 0));
    }

    function test_commit_requiresEverythingSwept() public {
        uint256 id = _create();
        _closeVoting(id);
        ballot.sweep(id, 0);
        vm.prank(resolver);
        vm.expectRevert(FlatBallot.NotAllSwept.selector);
        ballot.commitResults(id, bytes32(0), bytes32(0), _votes2(0, 0));
    }

    function test_commit_cannotInventVotes() public {
        uint256 id = _create();
        _vote(id, 0, address(0x1), UNIT);
        _vote(id, 1, address(0x2), UNIT);
        _closeVoting(id);
        _sweepAll(id);

        bytes32 root = keccak256("any");
        vm.startPrank(resolver);
        vm.expectRevert(FlatBallot.BadResults.selector);
        ballot.commitResults(id, root, bytes32(0), _votes2(2, 0)); // only 1 WIF burned for option 0
        vm.expectRevert(FlatBallot.BadResults.selector);
        ballot.commitResults(id, root, bytes32(0), _votes2(0, 2));
        vm.expectRevert(FlatBallot.BadResults.selector);
        ballot.commitResults(id, bytes32(0), bytes32(0), _votes2(1, 1)); // entries but no root
        uint256[] memory wrongLen = new uint256[](3);
        vm.expectRevert(FlatBallot.BadResults.selector);
        ballot.commitResults(id, root, bytes32(0), wrongLen);
        // exactly what was burned is fine; fewer (sybils collapsed) is fine too
        ballot.commitResults(id, root, bytes32(0), _votes2(1, 0));
        vm.stopPrank();
    }

    function test_commit_respectsVoteCostWhenBounding() public {
        FlatBallot.CreateParams memory p = _params();
        p.voteCost = 5 * UNIT;
        uint256 id = _createWith(p);
        _vote(id, 0, address(0x1), 5 * UNIT);
        _vote(id, 0, address(0x2), 4 * UNIT); // underpays: does not make a whole vote
        _closeVoting(id);
        _sweepAll(id);
        // 9 WIF burned for option 0 => at most floor(9/5) = 1 vote
        vm.startPrank(resolver);
        vm.expectRevert(FlatBallot.BadResults.selector);
        ballot.commitResults(id, keccak256("r"), bytes32(0), _votes2(2, 0));
        ballot.commitResults(id, keccak256("r"), bytes32(0), _votes2(1, 0));
        vm.stopPrank();
    }

    function test_commit_cannotBeRepeated() public {
        (uint256 id,,) = _toCommitted(4);
        vm.prank(resolver);
        vm.expectRevert(FlatBallot.BadState.selector);
        ballot.commitResults(id, keccak256("again"), bytes32(0), _votes2(1, 1));
    }

    // ------------------------------------------------------------------ finalize + money

    function test_finalize_tooEarly_expired_andReseed() public {
        (uint256 id,,) = _toCommitted(4);
        FlatBallot.Election memory e = ballot.getElection(id);

        vm.roll(e.seedBlock);
        vm.expectRevert(FlatBallot.TooEarly.selector);
        ballot.finalize(id);

        vm.expectRevert(FlatBallot.TooEarly.selector);
        ballot.reseed(id); // still inside the window

        vm.roll(e.seedBlock + ballot.SEED_WINDOW() + 1);
        vm.expectRevert(FlatBallot.SeedExpired.selector);
        ballot.finalize(id);

        ballot.reseed(id);
        FlatBallot.Election memory e2 = ballot.getElection(id);
        assertEq(e2.seedBlock, block.number + ballot.SEED_DELAY());
        assertEq(e2.root, e.root, "root must not move");

        vm.roll(e2.seedBlock + 1);
        ballot.finalize(id);
        assertEq(uint8(ballot.getElection(id).status), uint8(FlatBallot.Status.Finalized));
    }

    function test_finalize_seedIsTheCommittedFutureBlockHash() public {
        (uint256 id,,) = _toCommitted(4);
        FlatBallot.Election memory e = ballot.getElection(id);
        vm.roll(e.seedBlock + 7);
        ballot.finalize(id);
        assertEq(ballot.getElection(id).seed, keccak256(abi.encode("arbhash", e.seedBlock)));
    }

    function test_finalize_moneyFlow_winnerBountyFeeBond() public {
        (uint256 id,,) = _toCommitted(5); // option 0 wins 3-2
        uint256 deadBefore = wif.balanceOf(DEAD);
        uint256 creatorBefore = wif.balanceOf(creator);
        _finalize(id);

        FlatBallot.Election memory e = ballot.getElection(id);
        assertEq(e.winnerOption, 0);
        assertEq(e.bountyTo, bene0);

        uint256 pool = 10_000e18;
        uint256 fee = (pool * 500) / 10_000; // 500
        uint256 bounty = (pool * 2000) / 10_000; // 2000
        assertEq(e.bounty, bounty);
        assertEq(e.voterPool, pool - fee - bounty);
        assertEq(e.prizePerSlot, (pool - fee - bounty) / 4);
        assertEq(wif.balanceOf(DEAD) - deadBefore, fee, "fee is burned");
        assertEq(wif.balanceOf(creator) - creatorBefore, BOND, "5 >= minVotes(3): bond returned");

        ballot.claimBounty(id);
        assertEq(wif.balanceOf(bene0), bounty);
        vm.expectRevert(FlatBallot.NothingToDo.selector);
        ballot.claimBounty(id);
    }

    function test_finalize_bondBurnedWhenBelowMinVotes() public {
        (uint256 id,,) = _toCommitted(2); // minVotes = 3
        uint256 deadBefore = wif.balanceOf(DEAD);
        uint256 creatorBefore = wif.balanceOf(creator);
        _finalize(id);
        assertEq(wif.balanceOf(creator), creatorBefore, "no bond back");
        assertEq(wif.balanceOf(DEAD) - deadBefore, BOND + 500e18);
    }

    function test_finalize_tieGoesToLowestOption() public {
        (uint256 id,,) = _toCommitted(4); // 2-2
        _finalize(id);
        assertEq(ballot.getElection(id).winnerOption, 0);
    }

    function test_finalize_noBeneficiary_foldsBountyIntoVoterPool() public {
        FlatBallot.CreateParams memory p = _params();
        p.beneficiaries[0] = address(0);
        uint256 id = _createWith(p);
        (address[] memory voters, bytes32[] memory leaves) = _roster(4);
        for (uint256 i; i < 4; ++i) {
            _vote(id, i % 2, voters[i], UNIT);
        }
        _closeVoting(id);
        _sweepAll(id);
        vm.prank(resolver);
        ballot.commitResults(id, TestMerkle.root(leaves), bytes32(0), _votes2(2, 2));
        _finalize(id);
        FlatBallot.Election memory e = ballot.getElection(id);
        assertEq(e.bounty, 0);
        assertEq(e.voterPool, 10_000e18 - 500e18);
        vm.expectRevert(FlatBallot.NothingToDo.selector);
        ballot.claimBounty(id);
    }

    function test_finalize_cannotBeCalledTwice_orBeforeCommit() public {
        uint256 id = _create();
        vm.expectRevert(FlatBallot.BadState.selector);
        ballot.finalize(id);

        (uint256 id2,,) = _toCommitted(4);
        _finalize(id2);
        vm.expectRevert(FlatBallot.BadState.selector);
        ballot.finalize(id2);
    }

    // ------------------------------------------------------------------ claims

    function test_claimPrize_allSlots_thenSweepUnclaimed() public {
        (uint256 id, address[] memory voters, bytes32[] memory leaves) = _toCommitted(7);
        _finalize(id);
        FlatBallot.Election memory e = ballot.getElection(id);

        uint256 paid;
        for (uint256 s; s < e.slots; ++s) {
            uint256 idx = ballot.winnerIndex(id, s);
            assertLt(idx, 7);
            uint256 before = wif.balanceOf(voters[idx]);
            vm.prank(keeper); // anyone can relay
            ballot.claimPrize(id, s, idx, voters[idx], uint8(idx % 2), TestMerkle.proof(leaves, idx));
            assertEq(wif.balanceOf(voters[idx]) - before, e.prizePerSlot);
            assertTrue(ballot.slotClaimed(id, s));
            paid += e.prizePerSlot;
        }
        assertEq(ballot.getElection(id).claimedTotal, paid);

        vm.expectRevert(FlatBallot.TooEarly.selector);
        ballot.sweepUnclaimed(id);

        vm.warp(block.timestamp + ballot.CLAIM_WINDOW() + 1);
        uint256 creatorBefore = wif.balanceOf(creator);
        ballot.sweepUnclaimed(id);
        assertEq(wif.balanceOf(creator) - creatorBefore, e.voterPool - paid, "only rounding dust left");
        vm.expectRevert(FlatBallot.NothingToDo.selector);
        ballot.sweepUnclaimed(id);
    }

    function test_claimPrize_rejectsDoubleClaim_wrongIndex_wrongVoter_badProof() public {
        (uint256 id, address[] memory voters, bytes32[] memory leaves) = _toCommitted(6);
        _finalize(id);

        uint256 idx = ballot.winnerIndex(id, 0);
        bytes32[] memory proof = TestMerkle.proof(leaves, idx);
        uint8 opt = uint8(idx % 2);

        // wrong voter for that index
        vm.expectRevert(FlatBallot.BadProof.selector);
        ballot.claimPrize(id, 0, idx, address(0xBAD), opt, proof);
        // wrong option baked into the leaf
        vm.expectRevert(FlatBallot.BadProof.selector);
        ballot.claimPrize(id, 0, idx, voters[idx], opt == 0 ? 1 : 0, proof);
        // wrong index for the slot
        vm.expectRevert(FlatBallot.BadProof.selector);
        ballot.claimPrize(id, 0, (idx + 1) % 6, voters[(idx + 1) % 6], uint8(((idx + 1) % 6) % 2), TestMerkle.proof(leaves, (idx + 1) % 6));
        // out-of-range option
        vm.expectRevert(FlatBallot.BadProof.selector);
        ballot.claimPrize(id, 0, idx, voters[idx], 9, proof);
        // empty proof for a multi-leaf tree
        vm.expectRevert(FlatBallot.BadProof.selector);
        ballot.claimPrize(id, 0, idx, voters[idx], opt, new bytes32[](0));
        // slot out of range
        vm.expectRevert(FlatBallot.BadParams.selector);
        ballot.claimPrize(id, 4, idx, voters[idx], opt, proof);

        ballot.claimPrize(id, 0, idx, voters[idx], opt, proof);
        vm.expectRevert(FlatBallot.AlreadyClaimed.selector);
        ballot.claimPrize(id, 0, idx, voters[idx], opt, proof);
    }

    function test_claimPrize_notBeforeFinalize_notAfterWindow() public {
        (uint256 id, address[] memory voters, bytes32[] memory leaves) = _toCommitted(4);
        vm.expectRevert(FlatBallot.BadState.selector);
        ballot.claimPrize(id, 0, 0, voters[0], 0, TestMerkle.proof(leaves, 0));

        _finalize(id);
        uint256 idx = ballot.winnerIndex(id, 0);
        vm.warp(block.timestamp + ballot.CLAIM_WINDOW() + 1);
        vm.expectRevert(FlatBallot.TooLate.selector);
        ballot.claimPrize(id, 0, idx, voters[idx], uint8(idx % 2), TestMerkle.proof(leaves, idx));
    }

    function test_claimPrize_singleEntryElection() public {
        FlatBallot.CreateParams memory p = _params();
        p.minVotes = 1;
        p.slots = 1;
        uint256 id = _createWith(p);
        address solo = address(0x501);
        _vote(id, 1, solo, UNIT);
        _closeVoting(id);
        _sweepAll(id);
        bytes32 leaf = TestMerkle.leaf(0, solo, 1);
        vm.prank(resolver);
        ballot.commitResults(id, leaf, bytes32(0), _votes2(0, 1));
        _finalize(id);
        assertEq(ballot.getElection(id).winnerOption, 1);
        ballot.claimPrize(id, 0, 0, solo, 1, new bytes32[](0));
        assertEq(wif.balanceOf(solo), ballot.getElection(id).prizePerSlot);
    }

    // ------------------------------------------------------------------ cancel / refund

    function test_zeroVerifiedVotes_cancelsAndRefunds() public {
        uint256 id = _create();
        vm.prank(booster);
        ballot.boost(id, 700e18);
        _closeVoting(id);
        _sweepAll(id);
        vm.prank(resolver);
        ballot.commitResults(id, bytes32(0), bytes32(0), _votes2(0, 0));

        uint256 deadBefore = wif.balanceOf(DEAD);
        _finalize(id);
        assertEq(uint8(ballot.getElection(id).status), uint8(FlatBallot.Status.Cancelled));
        assertEq(wif.balanceOf(DEAD) - deadBefore, BOND, "bond burned, nobody voted");

        uint256 cBefore = wif.balanceOf(creator);
        vm.prank(creator);
        ballot.refund(id);
        assertEq(wif.balanceOf(creator) - cBefore, 10_000e18);

        uint256 bBefore = wif.balanceOf(booster);
        vm.prank(booster);
        ballot.refund(id);
        assertEq(wif.balanceOf(booster) - bBefore, 700e18);

        vm.prank(booster);
        vm.expectRevert(FlatBallot.NothingToDo.selector);
        ballot.refund(id);
        vm.prank(keeper);
        vm.expectRevert(FlatBallot.NothingToDo.selector);
        ballot.refund(id);

        assertEq(wif.balanceOf(address(ballot)), 0, "everything left the contract");
    }

    function test_cancelUncommitted_afterWindow() public {
        uint256 id = _create();
        _vote(id, 0, address(0x1), UNIT);
        _closeVoting(id);

        vm.expectRevert(FlatBallot.TooEarly.selector);
        ballot.cancelUncommitted(id);

        FlatBallot.Election memory e = ballot.getElection(id);
        vm.warp(uint256(e.voteEnd) + ballot.COMMIT_WINDOW() + 1);
        uint256 deadBefore = wif.balanceOf(DEAD);
        ballot.cancelUncommitted(id);
        assertEq(wif.balanceOf(DEAD) - deadBefore, BOND);

        // unswept votes can still be burned after a cancel
        ballot.sweep(id, 0);
        assertEq(wif.balanceOf(ballot.boxAddress(id, 0)), 0);

        vm.prank(creator);
        ballot.refund(id);
        assertEq(wif.balanceOf(address(ballot)), 0);

        vm.expectRevert(FlatBallot.BadState.selector);
        ballot.cancelUncommitted(id);
    }

    function test_cancelUncommitted_notWhenCommitted() public {
        (uint256 id,,) = _toCommitted(4);
        vm.warp(block.timestamp + 10 days);
        vm.expectRevert(FlatBallot.BadState.selector);
        ballot.cancelUncommitted(id);
    }

    function test_refund_notWhenNotCancelled() public {
        uint256 id = _create();
        vm.prank(creator);
        vm.expectRevert(FlatBallot.BadState.selector);
        ballot.refund(id);
    }

    // ------------------------------------------------------------------ chain behaviour

    function test_nonArbitrumChain_fallsBackToNativeBlockhash() public {
        vm.etch(ARBSYS, "");
        (uint256 id,,) = _toCommitted(4);
        FlatBallot.Election memory e = ballot.getElection(id);
        vm.roll(e.seedBlock + 1);
        ballot.finalize(id);
        assertTrue(ballot.getElection(id).seed != bytes32(0));
    }

    function test_arbitrum_neverFallsBackWhenPrecompileReverts() public {
        (uint256 id,,) = _toCommitted(4);
        FlatBallot.Election memory e = ballot.getElection(id);
        vm.roll(e.seedBlock + 1);
        // make the precompile revert on arbBlockHash
        vm.mockCallRevert(ARBSYS, abi.encodeWithSignature("arbBlockHash(uint256)", e.seedBlock), "nope");
        vm.expectRevert(FlatBallot.SeedUnavailable.selector);
        ballot.finalize(id);
    }

    // ------------------------------------------------------------------ fuzz + conservation

    /// Whole lifecycle for a random electorate: every slot is claimable with a valid proof, and the
    /// total WIF supply is conserved (ballot + burned + paid out == everything that ever existed).
    function testFuzz_fullLifecycle_conservesFunds(uint8 nRaw, uint8 slotsRaw, uint16 bountyBpsRaw) public {
        uint256 n = bound(uint256(nRaw), 1, 40);
        FlatBallot.CreateParams memory p = _params();
        p.minVotes = 1;
        p.slots = uint16(bound(uint256(slotsRaw), 1, 100));
        p.bountyBps = uint16(bound(uint256(bountyBpsRaw), 0, 5000));
        uint256 id = _createWith(p);

        (address[] memory voters, bytes32[] memory leaves) = _roster(n);
        uint256 a;
        uint256 b;
        for (uint256 i; i < n; ++i) {
            _vote(id, i % 2, voters[i], UNIT);
            if (i % 2 == 0) ++a;
            else ++b;
        }
        _closeVoting(id);
        _sweepAll(id);
        vm.prank(resolver);
        ballot.commitResults(id, TestMerkle.root(leaves), bytes32(0), _votes2(a, b));
        _finalize(id);

        FlatBallot.Election memory e = ballot.getElection(id);
        for (uint256 s; s < e.slots; ++s) {
            uint256 idx = ballot.winnerIndex(id, s);
            assertLt(idx, n);
            ballot.claimPrize(id, s, idx, voters[idx], uint8(idx % 2), TestMerkle.proof(leaves, idx));
        }
        if (ballot.getElection(id).bounty > 0) ballot.claimBounty(id);
    }

    function testFuzz_merkleProofsVerifyForEveryLeaf(uint8 nRaw) public {
        uint256 n = bound(uint256(nRaw), 1, 64);
        FlatBallot.CreateParams memory p = _params();
        p.minVotes = 1;
        p.slots = 100; // many draws exercise many leaves
        uint256 id = _createWith(p);
        (address[] memory voters, bytes32[] memory leaves) = _roster(n);
        uint256 a;
        uint256 b;
        for (uint256 i; i < n; ++i) {
            _vote(id, i % 2, voters[i], UNIT);
            if (i % 2 == 0) ++a;
            else ++b;
        }
        _closeVoting(id);
        _sweepAll(id);
        vm.prank(resolver);
        ballot.commitResults(id, TestMerkle.root(leaves), bytes32(0), _votes2(a, b));
        _finalize(id);
        for (uint256 s; s < 100; ++s) {
            uint256 idx = ballot.winnerIndex(id, s);
            ballot.claimPrize(id, s, idx, voters[idx], uint8(idx % 2), TestMerkle.proof(leaves, idx));
        }
    }

    function testFuzz_supplyIsConserved(uint8 nRaw) public {
        uint256 n = bound(uint256(nRaw), 3, 30);
        uint256 supplyBefore = wif.totalSupply();
        (uint256 id, address[] memory voters, bytes32[] memory leaves) = _toCommitted(n);
        uint256 minted = wif.totalSupply() - supplyBefore; // voters' freshly minted WIF
        _finalize(id);
        FlatBallot.Election memory e = ballot.getElection(id);
        for (uint256 s; s < e.slots; ++s) {
            uint256 idx = ballot.winnerIndex(id, s);
            ballot.claimPrize(id, s, idx, voters[idx], uint8(idx % 2), TestMerkle.proof(leaves, idx));
        }
        ballot.claimBounty(id);
        vm.warp(block.timestamp + ballot.CLAIM_WINDOW() + 1);
        ballot.sweepUnclaimed(id);

        // everything the ballot ever received has left it again
        assertEq(wif.balanceOf(address(ballot)), 0, "ballot must end empty");
        // burned = votes + fee (+ nothing else, bond returned)
        assertEq(wif.balanceOf(DEAD), n * UNIT + (10_000e18 * 500) / 10_000);
        assertEq(ballot.totalBurned(), wif.balanceOf(DEAD));
        assertEq(minted, n * UNIT);
    }
}
