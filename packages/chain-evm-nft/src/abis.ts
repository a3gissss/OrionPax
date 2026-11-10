import { parseAbi } from "viem";

/** SeaDrop (OpenSea) shared drop contract. Same address on every chain it is deployed to. */
export const SEADROP_ADDRESS = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5" as const;
/** OpenSea's default fee recipient for public drops. */
export const OPENSEA_FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719" as const;
/** Zora `ZoraCreatorFixedPriceSaleStrategy` (deterministic address on Zora-supported chains). */
export const ZORA_FIXED_PRICE_STRATEGY = "0x04E2516A2c207E84a1839755675dfd8eF6302F0a" as const;

export const seaDropAbi = parseAbi([
  "struct PublicDrop { uint80 mintPrice; uint48 startTime; uint48 endTime; uint16 maxTotalMintableByWallet; uint16 feeBps; bool restrictFeeRecipients; }",
  "function getPublicDrop(address nftContract) view returns (PublicDrop)",
  "function getAllowedFeeRecipients(address nftContract) view returns (address[])",
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable",
]);

export const seaDropTokenAbi = parseAbi([
  "function getMintStats(address minter) view returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply)",
  "function mintSeaDrop(address minter, uint256 quantity)",
]);

export const zora1155Abi = parseAbi([
  "struct TokenData { string uri; uint256 maxSupply; uint256 totalMinted; }",
  "function mintFee() view returns (uint256)",
  "function getTokenInfo(uint256 tokenId) view returns (TokenData)",
  "function mintWithRewards(address minter, uint256 tokenId, uint256 quantity, bytes minterArguments, address mintReferral) payable",
  "function mint(address minter, uint256 tokenId, uint256 quantity, address[] rewardsRecipients, bytes minterArguments) payable",
  "function mint(address minter, uint256 tokenId, uint256 quantity, bytes minterArguments) payable",
]);

export const zoraStrategyAbi = parseAbi([
  "struct SalesConfig { uint64 saleStart; uint64 saleEnd; uint64 maxTokensPerAddress; uint96 pricePerToken; address fundsRecipient; }",
  "function sale(address tokenContract, uint256 tokenId) view returns (SalesConfig)",
  "function getMintedPerWallet(address tokenContract, uint256 tokenId, address wallet) view returns (uint256)",
]);

export const erc721aMintAbi = parseAbi([
  "function mint(uint256 quantity) payable",
  "function publicMint(uint256 quantity) payable",
]);

/** Zero-arg uint getters commonly used for the public price. First one that answers wins. */
export const PRICE_GETTERS = [
  "price", "mintPrice", "cost", "publicPrice", "publicSalePrice", "publicMintPrice", "salePrice", "mintCost", "tokenPrice",
  "PRICE", "MINT_PRICE",
] as const;
export const MAX_PER_WALLET_GETTERS = [
  "maxPerWallet", "maxMintPerWallet", "MAX_PER_WALLET", "maxPerAddress", "walletLimit", "maxMintAmountPerWallet",
] as const;
export const SALE_ACTIVE_GETTERS = [
  "saleActive", "publicSaleActive", "isPublicSaleActive", "saleIsActive", "isSaleActive", "mintActive",
] as const;
export const MAX_SUPPLY_GETTERS = ["maxSupply", "MAX_SUPPLY", "collectionSize"] as const;

export const uintGetterAbi = (name: string) =>
  [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;
export const boolGetterAbi = (name: string) =>
  [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }] as const;
export const addrUintGetterAbi = (name: string) =>
  [{ type: "function", name, stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;

/** Revert errors we know how to name. Error(string) / Panic(uint256) are decoded by viem natively. */
export const knownErrorsAbi = parseAbi([
  "error Error(string message)",
  "error Panic(uint256 code)",
  // SeaDrop
  "error NotActive(uint256 currentTimestamp, uint256 startTimestamp, uint256 endTimestamp)",
  "error MintQuantityCannotBeZero()",
  "error MintQuantityExceedsMaxMintedPerWallet(uint256 total, uint256 allowed)",
  "error MintQuantityExceedsMaxSupply(uint256 total, uint256 maxSupply)",
  "error MintQuantityExceedsMaxTokenSupplyForStage(uint256 total, uint256 maxTokenSupplyForStage)",
  "error FeeRecipientCannotBeZeroAddress()",
  "error FeeRecipientNotAllowed()",
  "error IncorrectPayment(uint256 got, uint256 want)",
  "error PayerNotAllowed()",
  "error OnlyINonFungibleSeaDrop(address sender)",
  // Zora 1155
  "error SaleEnded()",
  "error SaleHasNotStarted()",
  "error WrongValueSent()",
  "error UserExceedsMintLimit(address user, uint256 limit, uint256 requestedAmount)",
  "error CannotMintMoreTokens(uint256 tokenId, uint256 quantity, uint256 totalMinted, uint256 maxSupply)",
  "error Mint_InsolventSaleTransfer()",
  "error Mint_ValueTransferFail()",
  "error ERC1155_MINT_TO_ZERO_ADDRESS()",
  // ERC721A / common hand-rolled drops
  "error MintZeroQuantity()",
  "error MintToZeroAddress()",
  "error SaleNotActive()",
  "error PublicSaleNotActive()",
  "error ExceedsMaxPerWallet()",
  "error MaxPerWalletExceeded()",
  "error InsufficientPayment()",
  "error IncorrectValue()",
  "error InvalidQuantity()",
  "error ExceedsMaxSupply()",
  "error SoldOut()",
  "error EnforcedPause()",
]);
