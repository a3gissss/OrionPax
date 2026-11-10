// SPDX-License-Identifier: MIT
// Local e2e fixture only. A minimal constant-product (virtual reserves) bonding-curve launchpad
// matching the generic definition: buy(token, minTokensOut, deadline) / getBuyQuote / isGraduated.
pragma solidity ^0.8.24;

contract LaunchToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint256 supply, address holder) {
        name = n;
        symbol = s;
        totalSupply = supply;
        balanceOf[holder] = supply;
        emit Transfer(address(0), holder, supply);
    }

    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        emit Transfer(msg.sender, to, v);
        return true;
    }

    function approve(address sp, uint256 v) external returns (bool) {
        allowance[msg.sender][sp] = v;
        emit Approval(msg.sender, sp, v);
        return true;
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        allowance[f][msg.sender] -= v;
        balanceOf[f] -= v;
        balanceOf[to] += v;
        emit Transfer(f, to, v);
        return true;
    }
}

contract BondingCurveLaunchpad {
    struct Curve {
        uint256 virtualEth;
        uint256 virtualTokens;
        bool graduated;
        bool exists;
    }

    error SlippageExceeded(uint256 tokensOut, uint256 minTokensOut);
    error DeadlineExpired(uint256 deadline, uint256 timestamp);
    error AlreadyGraduated(address token);
    error UnknownToken(address token);

    event TokenCreated(address indexed token);
    event Bought(address indexed token, address indexed buyer, uint256 ethIn, uint256 tokensOut);

    address public immutable owner;
    mapping(address => Curve) public curves;

    constructor() {
        owner = msg.sender;
    }

    function createToken(string calldata n, string calldata s, uint256 supply, uint256 virtualEth)
        external
        returns (address token)
    {
        token = address(new LaunchToken(n, s, supply, address(this)));
        curves[token] = Curve(virtualEth, supply, false, true);
        emit TokenCreated(token);
    }

    function getBuyQuote(address token, uint256 ethIn) public view returns (uint256) {
        Curve storage c = curves[token];
        if (!c.exists) revert UnknownToken(token);
        return (c.virtualTokens * ethIn) / (c.virtualEth + ethIn);
    }

    function isGraduated(address token) external view returns (bool) {
        return curves[token].graduated;
    }

    function buy(address token, uint256 minTokensOut, uint256 deadline) external payable {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
        Curve storage c = curves[token];
        if (!c.exists) revert UnknownToken(token);
        if (c.graduated) revert AlreadyGraduated(token);
        uint256 out = getBuyQuote(token, msg.value);
        if (out < minTokensOut) revert SlippageExceeded(out, minTokensOut);
        c.virtualEth += msg.value;
        c.virtualTokens -= out;
        LaunchToken(token).transfer(msg.sender, out);
        emit Bought(token, msg.sender, msg.value, out);
    }

    /// Fixture helper: mark a token as migrated to an AMM.
    function graduate(address token) external {
        require(msg.sender == owner, "owner");
        curves[token].graduated = true;
    }
}
