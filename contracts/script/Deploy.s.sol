// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Script.sol";
import {FlatBallot} from "../src/FlatBallot.sol";

/// Usage (Robinhood Chain mainnet, chain id 4663):
///   WIF=0x5173b8eA6923c2d40267890D45C46a3480954773 BOND=1000000000000000000000000 \
///   forge script script/Deploy.s.sol --rpc-url $RPC --private-key $PK --broadcast
/// BOND is in WIF base units (the token has `decimals` decimals).
contract Deploy is Script {
    function run() external returns (FlatBallot b) {
        address wif = vm.envAddress("WIF");
        uint256 bond = vm.envUint("BOND");
        require(wif.code.length > 0, "WIF is not a contract on this chain");
        vm.startBroadcast();
        b = new FlatBallot(wif, bond);
        vm.stopBroadcast();
        console2.log("FlatBallot:", address(b));
        console2.log("deployBlock:", block.number);
        console2.log("unit:", b.unit());
    }
}
