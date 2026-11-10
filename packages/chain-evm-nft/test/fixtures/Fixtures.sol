// SPDX-License-Identifier: MIT
// Minimal local-only fixture contracts for chain-evm-nft e2e tests. NOT production code.
pragma solidity ^0.8.20;

// ---------------- ERC721A-style public mint ----------------

contract PublicMint721 {
    uint256 public price;
    uint256 public maxPerWallet;
    uint256 public maxSupply;
    uint256 public totalSupply;
    bool public saleActive;
    address public owner;
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public numberMinted;
    mapping(uint256 => address) public ownerOf;

    constructor(uint256 price_, uint256 maxPerWallet_, uint256 maxSupply_) {
        price = price_;
        maxPerWallet = maxPerWallet_;
        maxSupply = maxSupply_;
        owner = msg.sender;
    }

    function setSaleActive(bool active) external {
        require(msg.sender == owner, "not owner");
        saleActive = active;
    }

    function mint(uint256 quantity) external payable {
        require(saleActive, "Sale not active");
        require(quantity > 0, "zero quantity");
        require(numberMinted[msg.sender] + quantity <= maxPerWallet, "Exceeds max per wallet");
        require(totalSupply + quantity <= maxSupply, "Sold out");
        require(msg.value == price * quantity, "Wrong value");
        for (uint256 i = 0; i < quantity; i++) ownerOf[totalSupply + i] = msg.sender;
        totalSupply += quantity;
        numberMinted[msg.sender] += quantity;
        balanceOf[msg.sender] += quantity;
    }
}

// ---------------- Zora-1155-like fixed price minter ----------------

struct SalesConfig {
    uint64 saleStart;
    uint64 saleEnd;
    uint64 maxTokensPerAddress;
    uint96 pricePerToken;
    address fundsRecipient;
}

contract FixedPriceStrategy {
    error SaleHasNotStarted();
    error SaleEnded();
    error WrongValueSent();
    error UserExceedsMintLimit(address user, uint256 limit, uint256 requestedAmount);

    mapping(address => mapping(uint256 => SalesConfig)) internal sales;
    mapping(address => mapping(uint256 => mapping(address => uint256))) internal minted;

    /// Called by the token contract to configure its own sale.
    function setSale(uint256 tokenId, SalesConfig calldata config) external {
        sales[msg.sender][tokenId] = config;
    }

    function sale(address tokenContract, uint256 tokenId) external view returns (SalesConfig memory) {
        return sales[tokenContract][tokenId];
    }

    function getMintedPerWallet(address tokenContract, uint256 tokenId, address wallet) external view returns (uint256) {
        return minted[tokenContract][tokenId][wallet];
    }

    function requestMint(uint256 tokenId, uint256 quantity, uint256 ethValueSent, bytes calldata minterArguments)
        external
        returns (address mintTo)
    {
        SalesConfig memory c = sales[msg.sender][tokenId];
        if (block.timestamp < c.saleStart) revert SaleHasNotStarted();
        if (block.timestamp > c.saleEnd) revert SaleEnded();
        if (uint256(c.pricePerToken) * quantity != ethValueSent) revert WrongValueSent();
        (mintTo,) = abi.decode(minterArguments, (address, string));
        uint256 total = minted[msg.sender][tokenId][mintTo] + quantity;
        if (c.maxTokensPerAddress > 0 && total > c.maxTokensPerAddress) {
            revert UserExceedsMintLimit(mintTo, c.maxTokensPerAddress, total);
        }
        minted[msg.sender][tokenId][mintTo] = total;
    }
}

contract Simple1155 {
    struct TokenData {
        string uri;
        uint256 maxSupply;
        uint256 totalMinted;
    }

    error WrongValueSent();
    error CannotMintMoreTokens(uint256 tokenId, uint256 quantity, uint256 totalMinted, uint256 maxSupply);

    uint256 public constant mintFee = 0.000777 ether;
    address public owner;
    mapping(uint256 => TokenData) internal tokens;
    mapping(uint256 => mapping(address => uint256)) internal balances;

    constructor() {
        owner = msg.sender;
    }

    function setupToken(uint256 tokenId, uint256 maxSupply, FixedPriceStrategy strategy, SalesConfig calldata config) external {
        require(msg.sender == owner, "not owner");
        tokens[tokenId] = TokenData("ipfs://fixture", maxSupply, 0);
        strategy.setSale(tokenId, config);
    }

    function getTokenInfo(uint256 tokenId) external view returns (TokenData memory) {
        return tokens[tokenId];
    }

    function balanceOf(address account, uint256 tokenId) external view returns (uint256) {
        return balances[tokenId][account];
    }

    function mintWithRewards(
        address minter,
        uint256 tokenId,
        uint256 quantity,
        bytes calldata minterArguments,
        address /* mintReferral */
    ) external payable {
        uint256 fee = mintFee * quantity;
        if (msg.value < fee) revert WrongValueSent();
        address to = FixedPriceStrategy(minter).requestMint(tokenId, quantity, msg.value - fee, minterArguments);
        TokenData storage t = tokens[tokenId];
        if (t.totalMinted + quantity > t.maxSupply) revert CannotMintMoreTokens(tokenId, quantity, t.totalMinted, t.maxSupply);
        t.totalMinted += quantity;
        balances[tokenId][to] += quantity;
    }
}

// ---------------- SeaDrop-like shared drop contract ----------------

struct PublicDrop {
    uint80 mintPrice;
    uint48 startTime;
    uint48 endTime;
    uint16 maxTotalMintableByWallet;
    uint16 feeBps;
    bool restrictFeeRecipients;
}

contract MiniSeaDrop {
    error NotActive(uint256 currentTimestamp, uint256 startTimestamp, uint256 endTimestamp);
    error MintQuantityExceedsMaxMintedPerWallet(uint256 total, uint256 allowed);
    error IncorrectPayment(uint256 got, uint256 want);
    error FeeRecipientCannotBeZeroAddress();

    mapping(address => PublicDrop) internal drops;

    function updatePublicDrop(PublicDrop calldata drop) external {
        drops[msg.sender] = drop;
    }

    function getPublicDrop(address nftContract) external view returns (PublicDrop memory) {
        return drops[nftContract];
    }

    function getAllowedFeeRecipients(address) external pure returns (address[] memory) {
        return new address[](0);
    }

    function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) external payable {
        PublicDrop memory d = drops[nftContract];
        if (block.timestamp < d.startTime || block.timestamp > d.endTime) revert NotActive(block.timestamp, d.startTime, d.endTime);
        if (feeRecipient == address(0)) revert FeeRecipientCannotBeZeroAddress();
        address minter = minterIfNotPayer == address(0) ? msg.sender : minterIfNotPayer;
        uint256 want = uint256(d.mintPrice) * quantity;
        if (msg.value != want) revert IncorrectPayment(msg.value, want);
        (uint256 n,,) = MiniSeaDropNFT(nftContract).getMintStats(minter);
        if (n + quantity > d.maxTotalMintableByWallet) {
            revert MintQuantityExceedsMaxMintedPerWallet(n + quantity, d.maxTotalMintableByWallet);
        }
        MiniSeaDropNFT(nftContract).mintSeaDrop(minter, quantity);
    }
}

contract MiniSeaDropNFT {
    address public immutable seaDrop;
    uint256 public maxSupply;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) internal numMinted;

    constructor(address seaDrop_, uint256 maxSupply_, PublicDrop memory drop) {
        seaDrop = seaDrop_;
        maxSupply = maxSupply_;
        MiniSeaDrop(seaDrop_).updatePublicDrop(drop);
    }

    function getMintStats(address minter) external view returns (uint256, uint256, uint256) {
        return (numMinted[minter], totalSupply, maxSupply);
    }

    function mintSeaDrop(address minter, uint256 quantity) external {
        require(msg.sender == seaDrop, "only SeaDrop");
        require(totalSupply + quantity <= maxSupply, "sold out");
        totalSupply += quantity;
        numMinted[minter] += quantity;
        balanceOf[minter] += quantity;
    }
}
