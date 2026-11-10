import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App";
import { MOCK_TOKEN } from "../src/mock/backend";
import { TOKEN_STORAGE_KEY } from "../src/lib/api";
import { installMockBackend } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dashboard against the mock backend", () => {
  it("token → unlock → 10-wallet Base NFT job → 10 confirmed", async () => {
    installMockBackend();
    const user = userEvent.setup({ delay: null });
    render(<App wsUrl="ws://test/ws" />);

    await user.type(screen.getByLabelText("Session token"), MOCK_TOKEN);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe(MOCK_TOKEN);

    await user.type(await screen.findByLabelText("Vault passphrase"), "pw");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    const table = await screen.findByRole("table", { name: "Wallets" });
    expect(within(table).getAllByRole("row")).toHaveLength(17); // header + 16 wallets

    await user.type(screen.getByLabelText("Collection contract"), "0x" + "cd".repeat(20));
    await user.click(screen.getByRole("button", { name: "First 10" }));
    await user.click(screen.getByRole("button", { name: /review mint/i }));
    await user.click(screen.getByRole("button", { name: /confirm & launch 10 wallets/i }));

    await waitFor(() => expect(screen.getByTestId("timeline-summary")).toHaveTextContent("10/10 confirmed"), { timeout: 4000 });
    const tl = screen.getByRole("table", { name: "Per-wallet timeline" });
    expect(tl.querySelectorAll('tr[data-status="confirmed"]')).toHaveLength(10);
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Jobs" })).getByText("done")).toBeInTheDocument());
  });

  it("returns to the token gate when the token is rejected", async () => {
    installMockBackend();
    sessionStorage.setItem(TOKEN_STORAGE_KEY, "bogus");
    render(<App wsUrl="ws://test/ws" />);
    expect(await screen.findByText(/token rejected/i)).toBeInTheDocument();
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("cancels a waiting job", async () => {
    const backend = installMockBackend({ unlocked: true, speed: 1 });
    sessionStorage.setItem(TOKEN_STORAGE_KEY, MOCK_TOKEN);
    const user = userEvent.setup({ delay: null });
    render(<App wsUrl="ws://test/ws" />);
    await screen.findByRole("table", { name: "Wallets" });
    await user.type(screen.getByLabelText("Collection contract"), "0x" + "cd".repeat(20));
    await user.click(screen.getByLabelText("EVM 01"));
    await user.click(screen.getByLabelText("Block"));
    await user.type(screen.getByLabelText("Block number"), "123");
    await user.click(screen.getByRole("button", { name: /review mint/i }));
    await user.click(screen.getByRole("button", { name: /confirm & launch 1 wallet/i }));
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await user.click(cancel);
    await waitFor(() => expect(screen.getAllByText("cancelled").length).toBeGreaterThan(0));
    backend.dispose();
  });
});
