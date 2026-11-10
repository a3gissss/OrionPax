// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minter strategy interface, shaped like Zora's IMinter1155 (simplified).
interface IFixtureMinter1155 {
    /// @return mintTo recipient decoded from minterArguments
    function requestMint(address sender, uint256 tokenId, uint256 quantity, uint256 ethValueSent, bytes calldata minterArguments)
        external
        returns (address mintTo);
}

/// @title Fixture1155
/// @notice LOCAL TEST FIXTURE ONLY. A simplified Zora-Creator-1155-like collection. The public entry point mirrors
///         Zora's `mint(minter, tokenId, quantity, rewardsRecipients, minterArguments)` where
///         `minterArguments = abi.encode(address mintTo, string comment)` and
///         `msg.value == (salePrice + mintFee) * quantity`.
contract Fixture1155 {
    address public owner;
    uint256 public mintFee;
    uint256 public nextTokenId = 1;

    mapping(uint256 => uint256) public maxSupply;
    mapping(uint256 => uint256) public totalMinted;
    mapping(address => bool) public isMinter;
    mapping(uint256 => mapping(address => uint256)) private _balances;

    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);
    event SetupNewToken(uint256 indexed tokenId, uint256 maxSupply);
    event Purchased(address indexed sender, address indexed minter, uint256 indexed tokenId, uint256 quantity, uint256 value);

    error NotOwner();
    error NotMinter();
    error SoldOut();
    error InvalidQuantity();

    constructor(uint256 mintFee_) {
        owner = msg.sender;
        mintFee = mintFee_;
    }

    function setupNewToken(uint256 maxSupply_) external returns (uint256 tokenId) {
        if (msg.sender != owner) revert NotOwner();
        tokenId = nextTokenId++;
        maxSupply[tokenId] = maxSupply_;
        emit SetupNewToken(tokenId, maxSupply_);
    }

    function setMinter(address minter, bool allowed) external {
        if (msg.sender != owner) revert NotOwner();
        isMinter[minter] = allowed;
    }

    function mint(
        IFixtureMinter1155 minter,
        uint256 tokenId,
        uint256 quantity,
        address[] calldata, /* rewardsRecipients (ignored by the fixture) */
        bytes calldata minterArguments
    ) external payable {
        if (!isMinter[address(minter)]) revert NotMinter();
        if (quantity == 0) revert InvalidQuantity();
        if (totalMinted[tokenId] + quantity > maxSupply[tokenId]) revert SoldOut();
        uint256 fee = mintFee * quantity;
        require(msg.value >= fee, "mint fee");
        address to = minter.requestMint(msg.sender, tokenId, quantity, msg.value - fee, minterArguments);
        totalMinted[tokenId] += quantity;
        _balances[tokenId][to] += quantity;
        emit TransferSingle(msg.sender, address(0), to, tokenId, quantity);
        emit Purchased(msg.sender, address(minter), tokenId, quantity, msg.value);
    }

    function balanceOf(address account, uint256 id) external view returns (uint256) {
        return _balances[id][account];
    }

    /// @dev Only ERC165 is claimed: the fixture implements the mint surface, not full ERC1155 transfers.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7;
    }

    /// @notice Fixture simplification: mint proceeds (price + fees) accrue here; the owner withdraws them.
    function withdraw() external {
        if (msg.sender != owner) revert NotOwner();
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }
}

/// @title FixtureFixedPriceMinter
/// @notice Simplified ZoraCreatorFixedPriceSaleStrategy: per (collection, tokenId) sale window, price and
///         per-address cap, readable through `sale(tokenContract, tokenId)`.
contract FixtureFixedPriceMinter is IFixtureMinter1155 {
    struct SalesConfig {
        uint64 saleStart;
        uint64 saleEnd;
        uint64 maxTokensPerAddress;
        uint96 pricePerToken;
        address fundsRecipient;
    }

    mapping(address => mapping(uint256 => SalesConfig)) private _sales;
    mapping(address => mapping(uint256 => mapping(address => uint256))) public mintedPerAddress;
    mapping(address => address) public collectionOwner;

    event SaleSet(address indexed mediaContract, uint256 indexed tokenId, SalesConfig salesConfig);

    error SaleNotStarted();
    error SaleEnded();
    error WrongValueSent();
    error UserExceedsMintLimit();
    error NotCollectionOwner();

    /// @dev Fixture simplification: the collection's owner configures sales directly on the minter.
    function setSale(address tokenContract, uint256 tokenId, SalesConfig calldata config) external {
        address registered = collectionOwner[tokenContract];
        if (registered == address(0)) {
            (bool ok, bytes memory data) = tokenContract.staticcall(abi.encodeWithSignature("owner()"));
            require(ok && data.length == 32, "no owner()");
            registered = abi.decode(data, (address));
            collectionOwner[tokenContract] = registered;
        }
        if (msg.sender != registered) revert NotCollectionOwner();
        _sales[tokenContract][tokenId] = config;
        emit SaleSet(tokenContract, tokenId, config);
    }

    function sale(address tokenContract, uint256 tokenId) external view returns (SalesConfig memory) {
        return _sales[tokenContract][tokenId];
    }

    function requestMint(address sender, uint256 tokenId, uint256 quantity, uint256 ethValueSent, bytes calldata minterArguments)
        external
        returns (address mintTo)
    {
        SalesConfig memory config = _sales[msg.sender][tokenId];
        if (block.timestamp < config.saleStart) revert SaleNotStarted();
        if (block.timestamp > config.saleEnd) revert SaleEnded();
        if (uint256(config.pricePerToken) * quantity != ethValueSent) revert WrongValueSent();
        (mintTo, ) = abi.decode(minterArguments, (address, string));
        if (config.maxTokensPerAddress > 0) {
            uint256 minted = mintedPerAddress[msg.sender][tokenId][mintTo] + quantity;
            if (minted > config.maxTokensPerAddress) revert UserExceedsMintLimit();
            mintedPerAddress[msg.sender][tokenId][mintTo] = minted;
        }
        sender; // unused in the fixture
    }
}
