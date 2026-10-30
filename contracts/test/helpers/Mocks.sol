// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Plain 18-decimals ERC-20 standing in for $WIF in tests.
contract MockWIF {
    string public constant name = "World is Flat";
    string public constant symbol = "WIF";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "ALLOWANCE");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(to != address(0), "ZERO_TO");
        require(balanceOf[from] >= amount, "BALANCE");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @dev Behaves like the Arbitrum ArbSys precompile: only recent past blocks are hashable.
contract MockArbSys {
    function arbBlockNumber() external view returns (uint256) {
        return block.number;
    }

    function arbBlockHash(uint256 n) external view returns (bytes32) {
        require(n < block.number && block.number - n <= 256, "invalid block number");
        return keccak256(abi.encode("arbhash", n));
    }
}

/// @dev Same merkle scheme as the off-chain verifier: leaf = keccak(index, voter, option),
///      sorted-pair keccak256, odd node promoted unchanged.
library TestMerkle {
    function leaf(uint256 index, address voter, uint8 option) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(index, voter, option));
    }

    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function nextLevel(bytes32[] memory level) internal pure returns (bytes32[] memory next) {
        uint256 m = (level.length + 1) / 2;
        next = new bytes32[](m);
        for (uint256 i; i < m; ++i) {
            uint256 l = 2 * i;
            uint256 r = l + 1;
            next[i] = r < level.length ? hashPair(level[l], level[r]) : level[l];
        }
    }

    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        require(leaves.length > 0, "EMPTY");
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            level = nextLevel(level);
        }
        return level[0];
    }

    function proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory out) {
        bytes32[] memory tmp = new bytes32[](32);
        uint256 count;
        bytes32[] memory level = leaves;
        uint256 idx = index;
        while (level.length > 1) {
            uint256 sib = idx ^ 1;
            if (sib < level.length) tmp[count++] = level[sib];
            level = nextLevel(level);
            idx /= 2;
        }
        out = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            out[i] = tmp[i];
        }
    }
}
