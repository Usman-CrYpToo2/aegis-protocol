/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLUSTER?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_INDEX_RPC_URL?: string;
  readonly VITE_QUOTE_LABELS?: string;
}
