// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FixtureERC721A
/// @notice LOCAL TEST FIXTURE ONLY. A trimmed ERC721A-style collection with the public-mint surface
///         most EVM drops expose: `mint(quantity)` payable, `price`, `maxPerWallet`, `maxSupply`,
///         `saleActive`, `numberMinted(owner)` and a `SaleStarted` event the watcher can trigger on.
///         Ownership is stored ERC721A-style (one slot per batch, `ownerOf` scans backwards).
///         Transfers are intentionally not implemented: the fixture only exercises minting.
contract FixtureERC721A {
    string public name;
    string public symbol;
    address public owner;

    uint256 public price;
    uint256 public maxPerWallet;
    uint256 public maxSupply;
    bool public saleActive;

    uint256 private _nextTokenId;
    mapping(uint256 => address) private _batchOwner;
    mapping(address => uint256) private _balance;
    mapping(address => uint256) private _minted;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event SaleStarted(uint256 price, uint256 maxPerWallet, uint256 timestamp);
    event SalePaused(uint256 timestamp);

    error NotOwner();
    error SaleNotActive();
    error InvalidQuantity();
    error ExceedsMaxPerWallet();
    error SoldOut();
    error WrongPayment();
    error NonexistentToken();

    constructor(string memory name_, string memory symbol_, uint256 price_, uint256 maxPerWallet_, uint256 maxSupply_) {
        name = name_;
        symbol = symbol_;
        owner = msg.sender;
        price = price_;
        maxPerWallet = maxPerWallet_;
        maxSupply = maxSupply_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setSaleActive(bool active) external onlyOwner {
        saleActive = active;
        if (active) emit SaleStarted(price, maxPerWallet, block.timestamp);
        else emit SalePaused(block.timestamp);
    }

    function setPrice(uint256 price_) external onlyOwner {
        price = price_;
    }

    function mint(uint256 quantity) external payable {
        if (!saleActive) revert SaleNotActive();
        if (quantity == 0) revert InvalidQuantity();
        if (_minted[msg.sender] + quantity > maxPerWallet) revert ExceedsMaxPerWallet();
        if (_nextTokenId + quantity > maxSupply) revert SoldOut();
        if (msg.value != price * quantity) revert WrongPayment();

        uint256 start = _nextTokenId;
        _batchOwner[start] = msg.sender;
        _nextTokenId = start + quantity;
        _minted[msg.sender] += quantity;
        _balance[msg.sender] += quantity;
        for (uint256 i = 0; i < quantity; i++) {
            emit Transfer(address(0), msg.sender, start + i);
        }
    }

    function totalSupply() external view returns (uint256) {
        return _nextTokenId;
    }

    function remainingSupply() external view returns (uint256) {
        return maxSupply - _nextTokenId;
    }

    function numberMinted(address who) external view returns (uint256) {
        return _minted[who];
    }

    function balanceOf(address who) external view returns (uint256) {
        return _balance[who];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        if (tokenId >= _nextTokenId) revert NonexistentToken();
        uint256 id = tokenId;
        while (true) {
            address o = _batchOwner[id];
            if (o != address(0)) return o;
            id--;
        }
        return address(0);
    }

    /// @dev Only ERC165 is claimed: the fixture implements the mint surface, not full ERC721 transfers/metadata.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7;
    }

    function withdraw() external onlyOwner {
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }
}
