import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

/**
 * Production builds get a Content-Security-Policy. It is left out of dev because Vite's hot
 * reload injects inline scripts that a strict policy would block.
 *
 * `connect-src` names every server the page talks to and nothing else, so a compromised dependency
 * cannot quietly send data anywhere: the RPC endpoint (and its websocket), the listing endpoints,
 * Solana's public devnet endpoint (the fallback for listing and for devnet SOL), and the two public
 * price sources (chain/prices). Anything added to the app that talks to a new server must be added
 * here too, or the browser will refuse it in production only.
 */
function contentSecurityPolicy(env: Record<string, string>): Plugin {
  const rpc = new URL(env.VITE_RPC_URL || "http://127.0.0.1:8899");
  const ws = `${rpc.protocol === "https:" ? "wss:" : "ws:"}//${rpc.hostname}${rpc.port ? `:${Number(rpc.port) + 1}` : ""}`;
  const origins = [
    rpc.origin,
    ws,
    ...(env.VITE_INDEX_RPC_URL ?? "").split(",").map((u) => u.trim()).filter(Boolean).map((u) => new URL(u).origin),
    env.VITE_CLUSTER === "devnet" ? "https://api.devnet.solana.com" : null,
    "https://lite-api.jup.ag",
    "https://api.coinbase.com",
  ].filter(Boolean);
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    // React style attributes and the wallet modal's stylesheet.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    `connect-src 'self' ${[...new Set(origins)].join(" ")}`,
    // frame-ancestors only works as an HTTP header (the host sets it); in a <meta> tag browsers
    // ignore it and log an error, so it isn't here.
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
  // The RPC servers are known before any script runs, so the browser can open those connections
  // (DNS, TLS) while the app is still loading instead of on its first request.
  const preconnect = [...new Set(origins.filter((o) => o!.startsWith("https://")))]
    .map((o) => `\n    <link rel="preconnect" href="${o}" crossorigin />`)
    .join("");
  return {
    name: "aegis-csp",
    apply: "build",
    transformIndexHtml: (html) =>
      html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />${preconnect}`),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [
      react(),
      tailwindcss(),
      // web3.js and Anchor expect Node's Buffer in the browser. Tests run in Node, which has the
      // real one; polyfilling there would mix two Buffer types between our code and libraries.
      !process.env.VITEST && nodePolyfills({ include: ["buffer"], globals: { Buffer: true, global: false, process: false } }),
      contentSecurityPolicy(env),
    ],
    server: { port: 5173, strictPort: true },
  };
});
