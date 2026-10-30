// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IWifSource {
    function wif() external view returns (address);
}

/// @title VoteBox
/// @notice Counterfactual deposit address for ONE option of ONE election.
///
/// Voters never interact with this contract. They send $WIF (a plain ERC-20 transfer, no wallet
/// connect, nothing to sign on a dApp) to the *address* this contract will have once deployed.
/// The address is known from the moment the election exists (CREATE2 from FlatBallot), but the
/// contract itself is only deployed by `FlatBallot.sweep` after voting closes. Its constructor
/// burns everything it holds, so every vote is burned and nobody can ever withdraw it.
///
/// The runtime `sweep()` exists only so tokens that arrive AFTER deployment are not stuck forever
/// (they are burned too, and are never counted as votes).
contract VoteBox {
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address private immutable WIF;

    constructor() {
        address token = IWifSource(msg.sender).wif();
        WIF = token;
        uint256 bal = IERC20Min(token).balanceOf(address(this));
        if (bal > 0) _burn(token, bal);
    }

    /// @notice Burn any $WIF that arrived after this box was deployed. Callable by anyone.
    function sweep() external {
        uint256 bal = IERC20Min(WIF).balanceOf(address(this));
        if (bal > 0) _burn(WIF, bal);
    }

    function _burn(address token, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20Min.transfer.selector, DEAD, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "BURN_FAILED");
    }
}
