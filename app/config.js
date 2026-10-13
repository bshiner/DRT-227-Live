// DRT-227 Live configuration.
// Single place to swap in the deployed Cloudflare Worker URL.
// During local development the worker is served via `wrangler dev` on port 8787.
window.DRT227_CONFIG = {
  // CHANGE THIS to the deployed Worker URL for production, e.g.:
  // workerBaseUrl: "https://drt-227-live.<your-sub>.workers.dev"
  workerBaseUrl: "http://localhost:8787"
};
