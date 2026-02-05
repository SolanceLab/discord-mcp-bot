/**
 * Cloudflare Worker environment bindings
 */
export interface Env {
  /** API key for authenticating requests to this connector */
  API_KEY: string;
  /** Fly.io bot HTTP API URL */
  BOT_API_URL: string;
  /** Fly.io bot HTTP API secret */
  BOT_API_SECRET: string;
}
