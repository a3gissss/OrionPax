// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title LaunchToken
/// @notice LOCAL TEST FIXTURE ONLY. Minimal ERC20; the full supply is minted to the launchpad at creation.
contract LaunchToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint256 supply, address holder) {
        name = name_;
        symbol = symbol_;
        totalSupply = supply;
        balanceOf[holder] = supply;
        emit Transfer(address(0), holder, supply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

/// @title BondingCurveLaunchpad
/// @notice LOCAL TEST FIXTURE ONLY. pump.fun-style constant-product curve over virtual reserves:
///         tokensOut = vToken - (vEth * vToken) / (vEth + ethInAfterFee).
///         A token "graduates" (curve closes) once real ETH raised reaches `graduationEth`.
contract BondingCurveLaunchpad {
    struct Curve {
        uint256 virtualEth;
        uint256 virtualToken;
        uint256 realEth;
        uint256 realTokenRemaining;
        bool graduated;
        bool exists;
    }

    uint256 public constant FEE_BPS = 100; // 1%
    uint256 public constant TOKEN_SUPPLY = 1_000_000_000e18;
    uint256 public constant CURVE_TOKENS = 800_000_000e18;
    uint256 public constant INITIAL_VIRTUAL_ETH = 30 ether;
    uint256 public constant INITIAL_VIRTUAL_TOKEN = 1_073_000_000e18;

    address public owner;
    uint256 public graduationEth;
    uint256 public feesCollected;
    mapping(address => Curve) public curves;

    event TokenCreated(address indexed token, address indexed creator, string name, string symbol);
    event Trade(address indexed token, address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 realEth);
    event Graduated(address indexed token, uint256 realEth);

    error UnknownToken();
    error AlreadyGraduated();
    error Expired();
    error ZeroIn();
    error SlippageExceeded(uint256 out, uint256 minOut);

    constructor(uint256 graduationEth_) {
        owner = msg.sender;
        graduationEth = graduationEth_;
    }

    function createToken(string calldata name_, string calldata symbol_) external returns (address token) {
        token = address(new LaunchToken(name_, symbol_, TOKEN_SUPPLY, address(this)));
        curves[token] = Curve({
            virtualEth: INITIAL_VIRTUAL_ETH,
            virtualToken: INITIAL_VIRTUAL_TOKEN,
            realEth: 0,
            realTokenRemaining: CURVE_TOKENS,
            graduated: false,
            exists: true
        });
        emit TokenCreated(token, msg.sender, name_, symbol_);
    }

    function isGraduated(address token) external view returns (bool) {
        return curves[token].graduated;
    }

    /// @notice Tokens received for `ethIn` wei (fee included in ethIn). 0 if unknown or graduated.
    function getBuyQuote(address token, uint256 ethIn) public view returns (uint256 tokensOut) {
        Curve storage c = curves[token];
        if (!c.exists || c.graduated || ethIn == 0) return 0;
        uint256 net = ethIn - (ethIn * FEE_BPS) / 10_000;
        uint256 k = c.virtualEth * c.virtualToken;
        tokensOut = c.virtualToken - k / (c.virtualEth + net);
        if (tokensOut > c.realTokenRemaining) tokensOut = c.realTokenRemaining;
    }

    function buy(address token, uint256 minOut, uint256 deadline) external payable returns (uint256 tokensOut) {
        if (block.timestamp > deadline) revert Expired();
        Curve storage c = curves[token];
        if (!c.exists) revert UnknownToken();
        if (c.graduated) revert AlreadyGraduated();
        if (msg.value == 0) revert ZeroIn();

        tokensOut = getBuyQuote(token, msg.value);
        if (tokensOut < minOut) revert SlippageExceeded(tokensOut, minOut);

        uint256 gross = msg.value;
        uint256 net = gross - (gross * FEE_BPS) / 10_000;
        uint256 refund;
        if (tokensOut == c.realTokenRemaining) {
            // Final buy is capped by the remaining curve tokens: charge only what those tokens cost, refund the rest.
            uint256 k = c.virtualEth * c.virtualToken;
            uint256 netNeeded = _ceilDiv(k, c.virtualToken - tokensOut) - c.virtualEth;
            if (netNeeded < net) {
                uint256 grossNeeded = _ceilDiv(netNeeded * 10_000, 10_000 - FEE_BPS);
                if (grossNeeded < gross) {
                    refund = gross - grossNeeded;
                    gross = grossNeeded;
                    net = gross - (gross * FEE_BPS) / 10_000;
                }
            }
        }
        uint256 fee = gross - net;
        feesCollected += fee;
        c.virtualEth += net;
        c.virtualToken -= tokensOut;
        c.realEth += net;
        c.realTokenRemaining -= tokensOut;

        require(LaunchToken(token).transfer(msg.sender, tokensOut), "transfer");
        emit Trade(token, msg.sender, gross, tokensOut, c.realEth);

        if (c.realEth >= graduationEth || c.realTokenRemaining == 0) {
            c.graduated = true;
            emit Graduated(token, c.realEth);
        }
        if (refund > 0) {
            (bool ok, ) = msg.sender.call{value: refund}("");
            require(ok, "refund failed");
        }
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
