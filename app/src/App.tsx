import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import type { WalletError } from "@solana/wallet-adapter-base";
import { useCallback, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { config } from "./config";
import { Header } from "./components/Header";
import { Toast, type ToastMessage } from "./components/Toast";
import { RegistryPage } from "./pages/Registry";
import { AssetPage } from "./pages/Asset";
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

  // Wallet errors (rejected connection, locked wallet) become a plain message, never a crash.
  const onWalletError = useCallback((error: WalletError) => {
    const rejected = /reject|cancel|denied/i.test(error.message);
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
          <WalletModalProvider>
            <BrowserRouter>
              <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-surface focus:px-4 focus:py-2">
                Skip to content
              </a>
              <Header />
              <main id="main" tabIndex={-1} className="outline-none">
                <Routes>
                  <Route path="/" element={<RegistryPage />} />
                  <Route path="/asset/:mint" element={<AssetPage />} />
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </main>
              <Toast message={toast} onDismiss={() => setToast(null)} />
            </BrowserRouter>
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </QueryClientProvider>
  );
}
