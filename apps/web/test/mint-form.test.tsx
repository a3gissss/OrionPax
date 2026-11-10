import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MintForm } from "../src/components/MintForm";
import { mockWalletViews } from "../src/mock/backend";
import { initialFormState, toggleWallet, validateForm, buildRequest } from "../src/lib/form";
import { toBaseUnits, fromBaseUnits } from "../src/lib/units";

const wallets = mockWalletViews(); // 12 evm + 4 solana
const EVM_ADDR = "0x" + "ab".repeat(20);
const SOL_ADDR = "4Nd1mYzLfBGH1t1T2Hp5fWmP2RkZsXzb9Hc3fJk2Qp8v";

function setup() {
  const onSubmit = vi.fn(async () => {});
  const user = userEvent.setup({ delay: null });
  render(<MintForm wallets={wallets} onSubmit={onSubmit} />);
  const walletGroup = () => screen.getByRole("group", { name: /wallets/i });
  return { user, onSubmit, walletGroup };
}

describe("wallet selection", () => {
  it("blocks selecting more than 10 wallets", async () => {
    const { user, walletGroup } = setup();
    const boxes = within(walletGroup()).getAllByRole("checkbox");
    expect(boxes).toHaveLength(12);
    for (const b of boxes) await user.click(b);
    expect(within(walletGroup()).getAllByRole("checkbox", { checked: true })).toHaveLength(10);
    expect(boxes[10]).toBeDisabled();
    expect(boxes[11]).toBeDisabled();
    expect(screen.getByTestId("wallet-count")).toHaveTextContent("10/10");
  });

  it("toggleWallet and validateForm refuse an 11th wallet", () => {
    let sel: string[] = [];
    for (const w of wallets.filter((x) => x.family === "evm")) sel = toggleWallet(sel, w.id);
    expect(sel).toHaveLength(10);
    const s = { ...initialFormState(), walletIds: wallets.filter((x) => x.family === "evm").slice(0, 11).map((w) => w.id) };
    expect(validateForm(s, wallets).walletIds).toMatch(/at most 10/i);
  });

  it("filters wallets by chain family and drops mismatched selections on chain change", async () => {
    const { user, walletGroup } = setup();
    await user.click(within(walletGroup()).getByLabelText("EVM 01"));
    expect(screen.getByTestId("wallet-count")).toHaveTextContent("1/10");
    await user.selectOptions(screen.getByLabelText("Chain"), "solana");
    const labels = within(walletGroup()).getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"));
    expect(labels).toEqual(["SOL 01", "SOL 02", "SOL 03", "SOL 04"]);
    expect(screen.getByTestId("wallet-count")).toHaveTextContent("0/10");
    await user.selectOptions(screen.getByLabelText("Chain"), "robinhood");
    expect(within(walletGroup()).getAllByRole("checkbox")).toHaveLength(12);
  });

  it("rejects wallets of the wrong family in validation", () => {
    const s = { ...initialFormState(), chain: "solana" as const, walletIds: ["evm-1"] };
    expect(validateForm(s, wallets).walletIds).toMatch(/not solana/);
  });
});

describe("required fields per kind", () => {
  it("NFT requires a valid collection address and wallets", async () => {
    const { user, onSubmit } = setup();
    await user.click(screen.getByRole("button", { name: /review mint/i }));
    expect(screen.getByText("Select at least one wallet")).toBeInTheDocument();
    expect(screen.getByLabelText("Collection contract").closest(".field")).toHaveTextContent("Required");
    await user.type(screen.getByLabelText("Collection contract"), "0x123");
    expect(screen.getByLabelText("Collection contract").closest(".field")).toHaveTextContent(/Invalid EVM address/);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("token launch requires token, launchpad and spend", async () => {
    const { user } = setup();
    await user.click(screen.getByLabelText("Token launch"));
    expect(screen.queryByLabelText("Collection contract")).toBeNull();
    await user.click(screen.getByRole("button", { name: /review mint/i }));
    for (const label of ["Token contract", "Launchpad / curve", "Spend / wallet (ETH)"]) {
      expect(screen.getByLabelText(label).closest(".field")).toHaveTextContent("Required");
    }
  });

  it("1155 style requires a token id; custom style requires a signature", () => {
    const base = { ...initialFormState(), walletIds: ["evm-1"] };
    const s1155 = { ...base, nft: { ...base.nft, address: EVM_ADDR, style: "zora-1155" as const } };
    expect(validateForm(s1155, wallets)["nft.tokenId"]).toBeDefined();
    const sCustom = { ...base, nft: { ...base.nft, address: EVM_ADDR, style: "custom" as const } };
    expect(validateForm(sCustom, wallets)["nft.customSignature"]).toBeDefined();
  });

  it("time / block triggers require their values", () => {
    const base = { ...initialFormState(), walletIds: ["evm-1"], nft: { ...initialFormState().nft, address: EVM_ADDR } };
    expect(validateForm({ ...base, trigger: { ...base.trigger, type: "time" } }, wallets)["trigger.at"]).toBeDefined();
    expect(validateForm({ ...base, trigger: { ...base.trigger, type: "slot-or-block" } }, wallets)["trigger.block"]).toBeDefined();
    expect(validateForm(base, wallets)).toEqual({});
  });
});

describe("submit flow", () => {
  it("shows a pre-flight summary and submits a Base NFT job with 10 wallets", async () => {
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText("Collection contract"), EVM_ADDR);
    await user.click(screen.getByRole("button", { name: "First 10" }));
    await user.type(screen.getByLabelText("Priority fee (gwei)"), "0.05");
    await user.click(screen.getByRole("button", { name: /review mint/i }));
    const dialog = screen.getByRole("dialog", { name: /pre-flight/i });
    expect(dialog).toHaveTextContent("Base");
    expect(dialog).toHaveTextContent("0.05 gwei");
    await user.click(within(dialog).getByRole("button", { name: /confirm & launch 10 wallets/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const req = (onSubmit.mock.calls[0] as unknown as [ReturnType<typeof buildRequest>])[0];
    expect(req.target).toEqual({ kind: "nft", chain: "base", address: EVM_ADDR, quantity: 1 });
    expect(req.walletIds).toHaveLength(10);
    expect(req.fees).toEqual({ priorityFee: "50000000" });
    expect(req.trigger).toEqual({ type: "now" });
  });

  it("builds a Solana token launch request in base units with Jito tip", () => {
    const s = initialFormState();
    s.chain = "solana";
    s.kind = "token";
    s.token = { tokenAddress: SOL_ADDR, launchpadAddress: SOL_ADDR, spend: "0.25", slippageBps: "500" };
    s.walletIds = ["sol-1", "sol-2"];
    s.fees.jitoTip = "0.001";
    s.fees.priorityFee = "200000";
    expect(validateForm(s, wallets)).toEqual({});
    const req = buildRequest(s);
    expect(req.target).toMatchObject({ spendPerWallet: "250000000", slippageBps: 500 });
    expect(req.fees).toEqual({ priorityFee: "200000", jitoTip: "1000000" });
  });
});

describe("units", () => {
  it("converts without floating point", () => {
    expect(toBaseUnits("1.5", 9)).toBe("1500000000");
    expect(toBaseUnits("0.000000000000000001", 18)).toBe("1");
    expect(() => toBaseUnits("1.0000000001", 9)).toThrow();
    expect(fromBaseUnits("1500000000", 9)).toBe("1.5");
    expect(fromBaseUnits("0", 18)).toBe("0");
  });
});
