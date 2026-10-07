import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { rpcConfig } from "./chain/rpc";
import { WalletWaitNotice } from "./components/WalletWaitNotice";

/** Every request to the RPC endpoint has a time limit; see chain/rpc. */
const RPC_CONFIG = rpcConfig();
import type { WalletError } from "@solana/wallet-adapter-base";
import { useCallback, useRef, useState } from "react";
import { ConnectModalProvider } from "./components/connect/ConnectModal";
import { BrowserRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { config } from "./config";
import { Header } from "./components/Header";
import { Footer } from "./components/Footer";
import { PageChange } from "./components/PageChange";
import { Toast, type ToastMessage } from "./components/Toast";
import { RegistryPage } from "./pages/Registry";
import { LandingPage } from "./pages/Landing";
import { DocsPage } from "./pages/Docs";
import { FaucetPage } from "./pages/Faucet";
import { AssetPage } from "./pages/Asset";
import { BridgePage } from "./pages/Bridge";
import { HoldingsPage } from "./pages/Holdings";
import { ConsolePage } from "./pages/Console";
import { LaunchConsolePage } from "./pages/LaunchConsole";
import { IssuePage } from "./pages/Issue";
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

function AppShell() {
  // Each page arrives with a short rise. The docs keep one key, so turning a page there swaps only
  // the article (Docs.tsx) and the sidebar stays put.
  const { pathname } = useLocation();
  const page = pathname.startsWith("/docs") ? "/docs" : pathname;
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-surface focus:px-4 focus:py-2">
        Skip to content
      </a>
      <Header />
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        <div key={page} className="page-enter">
          <Outlet />
        </div>
      </main>
      <Footer />
      <WalletWaitNotice />
    </div>
  );
}

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
      <ConnectionProvider endpoint={config.rpcUrl} config={RPC_CONFIG}>
        {/* An empty list means "every wallet that implements the Wallet Standard", which is
            how Phantom, Solflare and Backpack register themselves today. */}
        <WalletProvider wallets={[]} autoConnect onError={onWalletError}>
          <ConnectModalProvider errorRef={inDialog}>
            <BrowserRouter>
              <PageChange />
              <Routes>
                {/* The landing page brings its own header and footer; every app page shares these. */}
                <Route path="/" element={<LandingPage />} />
                <Route element={<AppShell />}>
                  <Route path="/registry" element={<RegistryPage />} />
                  <Route path="/asset/:mint" element={<AssetPage />} />
                  <Route path="/asset/:mint/bridge" element={<BridgePage />} />
                  <Route path="/holdings" element={<HoldingsPage />} />
                  <Route path="/console" element={<ConsolePage />} />
                  <Route path="/console/:mint" element={<LaunchConsolePage />} />
                  <Route path="/launch" element={<IssuePage />} />
                  <Route path="/launch/:mint" element={<IssuePage />} />
                  <Route path="/faucet" element={<FaucetPage />} />
                  <Route path="/docs" element={<DocsPage />} />
                  <Route path="/docs/:slug" element={<DocsPage />} />
                  <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Routes>
              <Toast message={toast} onDismiss={() => setToast(null)} />
            </BrowserRouter>
          </ConnectModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </QueryClientProvider>
  );
}
