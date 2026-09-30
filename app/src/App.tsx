import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import type { WalletError } from "@solana/wallet-adapter-base";
import { useCallback, useRef, useState } from "react";
import { ConnectModalProvider } from "./components/connect/ConnectModal";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { config } from "./config";
import { Header } from "./components/Header";
import { Toast, type ToastMessage } from "./components/Toast";
import { RegistryPage } from "./pages/Registry";
import { AssetPage } from "./pages/Asset";
import { BridgePage } from "./pages/Bridge";
import { HoldingsPage } from "./pages/Holdings";
import { ConsolePage } from "./pages/Console";
import { LaunchConsolePage } from "./pages/LaunchConsole";
import { NotFoundPage } from "./pages/NotFound";
import { ProgramNotDeployedError } from "./chain/registry";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Never retry a "not deployed" answer; it will not change by asking again.
      retry: (count, error) => !(error instanceof ProgramNotDeployedError) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

export function App() {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  // Set by the connect dialog while it is open, so its errors show in place instead of as a toast.
  const inDialog = useRef<((message: string) => boolean) | null>(null);

  // Wallet errors (rejected connection, locked wallet) become a plain message, never a crash.
  const onWalletError = useCallback((error: WalletError) => {
    const rejected = /reject|cancel|denied/i.test(error.message);
    const text = rejected ? "Connection cancelled in your wallet." : `Your wallet reported a problem: ${error.message || error.name}`;
    if (inDialog.current?.(text)) return;
    setToast({
      tone: rejected ? "neutral" : "error",
      text: rejected ? "Connection cancelled in your wallet." : `Your wallet reported a problem: ${error.message || error.name}`,
    });
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider endpoint={config.rpcUrl} config={{ commitment: "confirmed" }}>
        {/* An empty list means "every wallet that implements the Wallet Standard", which is
            how Phantom, Solflare and Backpack register themselves today. */}
        <WalletProvider wallets={[]} autoConnect onError={onWalletError}>
          <ConnectModalProvider errorRef={inDialog}>
            <BrowserRouter>
              <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-surface focus:px-4 focus:py-2">
                Skip to content
              </a>
              <Header />
              <main id="main" tabIndex={-1} className="outline-none">
                <Routes>
                  <Route path="/" element={<RegistryPage />} />
                  <Route path="/asset/:mint" element={<AssetPage />} />
                  <Route path="/asset/:mint/bridge" element={<BridgePage />} />
                  <Route path="/holdings" element={<HoldingsPage />} />
                  <Route path="/console" element={<ConsolePage />} />
                  <Route path="/console/:mint" element={<LaunchConsolePage />} />
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </main>
              <Toast message={toast} onDismiss={() => setToast(null)} />
            </BrowserRouter>
          </ConnectModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </QueryClientProvider>
  );
}
