/**
 * x402-base-verify
 * On-chain USDC payment verification for Base mainnet.
 *
 * Verifies that a given transaction hash contains a valid USDC transfer
 * to a specified wallet on Base (chain ID 8453) — with no external dependencies,
 * no API keys, and automatic RPC fallback.
 *
 * Implements the payment-verification half of the x402 micropayment protocol:
 * https://x402.org
 *
 * @example
 * import { verifyUsdcPayment } from "x402-base-verify";
 *
 * const result = await verifyUsdcPayment({
 *   txHash: "0x...",
 *   toAddress: "0xYourWallet",
 *   minAmountUsdc: 1.49,
 * });
 *
 * if (result.valid) {
 *   // grant access
 * }
 */

// ── USDC on Base mainnet ────────────────────────────────────────────────────────
// Contract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
// Transfer event: Transfer(address indexed from, address indexed to, uint256 value)
// ERC-20 Transfer topic: keccak256("Transfer(address,address,uint256)")

const USDC_CONTRACT_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER_TOPIC     = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const USDC_DECIMALS      = 6;

// Public Base RPC endpoints — no API key required.
// Tried in order; first success wins.
const DEFAULT_RPCS = [
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
  "https://base-rpc.publicnode.com",
];

// ── Types ──────────────────────────────────────────────────────────────────────

export interface VerifyOptions {
  /** The Base mainnet transaction hash to verify (starts with 0x) */
  txHash: string;

  /** The recipient wallet address that must receive the payment */
  toAddress: string;

  /**
   * Minimum USDC amount required (human-readable, e.g. 1.49).
   * Default: 0 (any positive transfer is valid)
   */
  minAmountUsdc?: number;

  /**
   * RPC endpoints to try in order.
   * Defaults to public Base RPC nodes — no API key needed.
   */
  rpcs?: string[];

  /**
   * Timeout per RPC attempt in milliseconds. Default: 9000
   */
  timeoutMs?: number;

  /**
   * If true and ALL RPCs time out, returns { valid: true } as a fail-open.
   * Use for high-availability where you'd rather accept a potentially
   * unverified payment than block a legitimate user.
   * Default: false
   */
  failOpen?: boolean;
}

export interface VerifyResult {
  /** Whether the payment is confirmed valid */
  valid: boolean;

  /** Human-readable reason when valid is false */
  reason?: string;

  /** Actual USDC amount transferred (human-readable), if found */
  amountUsdc?: number;

  /** Which RPC endpoint confirmed the transaction */
  rpc?: string;

  /** Whether result was fail-open due to all RPCs timing out */
  failedOpen?: boolean;
}

interface EthLog {
  address: string;
  topics: string[];
  data: string;
}

interface EthReceipt {
  logs?: EthLog[];
  status?: string;
}

// ── Core verifier ──────────────────────────────────────────────────────────────

export async function verifyUsdcPayment(options: VerifyOptions): Promise<VerifyResult> {
  const {
    txHash,
    toAddress,
    minAmountUsdc = 0,
    rpcs = DEFAULT_RPCS,
    timeoutMs = 9_000,
    failOpen = false,
  } = options;

  if (!txHash?.startsWith("0x")) {
    return { valid: false, reason: "invalid_tx_hash: must start with 0x" };
  }
  if (!toAddress?.startsWith("0x")) {
    return { valid: false, reason: "invalid_to_address: must start with 0x" };
  }

  const walletSuffix = toAddress.slice(2).toLowerCase().padStart(64, "0");
  const minRaw = BigInt(Math.round(minAmountUsdc * 10 ** USDC_DECIMALS));
  let allTimedOut = true;

  for (const rpc of rpcs) {
    try {
      const resp = await fetch(rpc, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          jsonrpc: "2.0",
          id:      1,
          method:  "eth_getTransactionReceipt",
          params:  [txHash],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      allTimedOut = false;

      const json = await resp.json() as { result?: EthReceipt | null; error?: unknown };

      if (json.error || !json.result) {
        return { valid: false, reason: "transaction_not_found_on_base" };
      }

      const receipt = json.result;

      // Check tx didn't revert
      if (receipt.status === "0x0") {
        return { valid: false, reason: "transaction_reverted" };
      }

      for (const log of receipt.logs ?? []) {
        const isUsdc   = log.address?.toLowerCase() === USDC_CONTRACT_BASE;
        const isXfer   = log.topics?.[0] === TRANSFER_TOPIC;
        const isToWallet = log.topics?.[2]?.toLowerCase().endsWith(walletSuffix.slice(-40));

        if (isUsdc && isXfer && isToWallet) {
          const rawAmount = BigInt(log.data ?? "0x0");
          const amountUsdc = Number(rawAmount) / 10 ** USDC_DECIMALS;

          if (rawAmount >= minRaw) {
            return { valid: true, amountUsdc, rpc };
          }

          return {
            valid: false,
            reason: `insufficient_usdc: sent ${amountUsdc.toFixed(USDC_DECIMALS)}, need ${minAmountUsdc}`,
            amountUsdc,
          };
        }
      }

      return { valid: false, reason: "no_usdc_transfer_to_target_wallet_in_tx" };
    } catch (err) {
      const isTimeout = err instanceof Error && (
        err.name === "TimeoutError" ||
        err.message.includes("timeout") ||
        err.message.includes("aborted")
      );
      if (!isTimeout) allTimedOut = false;
    }
  }

  if (failOpen && allTimedOut) {
    return { valid: true, failedOpen: true, reason: "all_rpcs_timed_out_fail_open" };
  }

  return { valid: false, reason: "all_rpcs_failed_or_timed_out" };
}

// ── Convenience: build an x402 payment-required response ─────────────────────

export interface PaymentRequiredOptions {
  /** Wallet to receive payment */
  toAddress: string;
  /** Price in USDC */
  priceUsdc: number;
  /** Human-readable product name */
  product?: string;
  /** Human-readable tagline */
  tagline?: string;
}

export function buildPaymentRequired(options: PaymentRequiredOptions): {
  status: 402;
  body: Record<string, unknown>;
} {
  const { toAddress, priceUsdc, product, tagline } = options;
  return {
    status: 402,
    body: {
      error:         "payment_required",
      product:       product ?? "API Access",
      tagline:       tagline ?? `Send ${priceUsdc} USDC on Base to unlock.`,
      price_usdc:    priceUsdc,
      network:       "Base mainnet",
      chain_id:      8453,
      pay_to:        toAddress,
      usdc_contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      instructions: [
        `Step 1: Send exactly ${priceUsdc} USDC on Base mainnet (chain ID 8453) to ${toAddress}`,
        "Step 2: Copy the transaction hash from your wallet or basescan.org",
        "Step 3: Retry this request with the header: X-Payment-Hash: <tx_hash>",
      ],
      verify_endpoint: "POST this endpoint with header X-Payment-Hash: <tx_hash>",
      protocol:        "x402 — https://x402.org",
    },
  };
}
