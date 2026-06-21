[![npm version](https://img.shields.io/npm/v/x402-base-verify.svg)](https://www.npmjs.com/package/x402-base-verify) [![npm downloads](https://img.shields.io/npm/dm/x402-base-verify.svg)](https://www.npmjs.com/package/x402-base-verify) [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

# x402-base-verify

On-chain USDC payment verification for Base mainnet. No API keys. No external services. Zero dependencies.

Built from the payment infrastructure powering [zambo.dev](https://zambo.dev) Day Pass — verifying live USDC transactions in production since 2026.

---

## What is x402?

[x402](https://x402.org) is a protocol built on HTTP status code 402 ("Payment Required") that enables micropayments at the HTTP layer. Instead of a Stripe checkout page or a PayPal flow, an API returns a 402 with payment instructions. The client (human or AI agent) sends crypto, then retries with the transaction hash in a header.

This library handles the verification half: given a tx hash, confirm that the right amount of USDC actually landed in the right wallet on Base.

---

## Install

```bash
npm install x402-base-verify
# or
pnpm add x402-base-verify
```

---

## Usage

### Verify a payment

```ts
import { verifyUsdcPayment } from "x402-base-verify";

const result = await verifyUsdcPayment({
  txHash:        "0xabc123...",
  toAddress:     "0xYourWalletAddress",
  minAmountUsdc: 1.49,
});

if (result.valid) {
  console.log(`Payment confirmed: ${result.amountUsdc} USDC via ${result.rpc}`);
  // grant access
} else {
  console.log(`Payment invalid: ${result.reason}`);
  // e.g. "insufficient_usdc: sent 1.000000, need 1.49"
  // e.g. "transaction_not_found_on_base"
  // e.g. "no_usdc_transfer_to_target_wallet_in_tx"
}
```

### Build a 402 response

```ts
import { buildPaymentRequired } from "x402-base-verify";

router.post("/api/premium-feature", async (req, res) => {
  const txHash = req.headers["x-payment-hash"] as string | undefined;

  if (!txHash) {
    const { status, body } = buildPaymentRequired({
      toAddress:  "0xYourWalletAddress",
      priceUsdc:  1.49,
      product:    "Premium Feature Access",
      tagline:    "$1.49 USDC. Instant. No account needed.",
    });
    res.status(status).json(body);
    return;
  }

  const payment = await verifyUsdcPayment({
    txHash,
    toAddress:     "0xYourWalletAddress",
    minAmountUsdc: 1.49,
  });

  if (!payment.valid) {
    res.status(402).json({ error: "invalid_payment", reason: payment.reason });
    return;
  }

  // payment verified — do the thing
  res.json({ success: true });
});
```

### Full x402 Express middleware

```ts
import { verifyUsdcPayment, buildPaymentRequired } from "x402-base-verify";
import type { Request, Response, NextFunction } from "express";

function x402Guard(toAddress: string, priceUsdc: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const txHash = req.headers["x-payment-hash"] as string | undefined;

    if (!txHash) {
      const { status, body } = buildPaymentRequired({ toAddress, priceUsdc });
      res.status(status).json(body);
      return;
    }

    const result = await verifyUsdcPayment({ txHash, toAddress, minAmountUsdc: priceUsdc });

    if (!result.valid) {
      res.status(402).json({ error: "payment_verification_failed", reason: result.reason });
      return;
    }

    next();
  };
}

// Use it:
router.post("/api/generate", x402Guard("0xYourWallet", 0.10), handleGenerate);
```

---

## API

### `verifyUsdcPayment(options)` → `Promise<VerifyResult>`

| Option | Type | Default | Description |
|---|---|---|---|
| `txHash` | `string` | required | Base mainnet transaction hash (0x...) |
| `toAddress` | `string` | required | Expected recipient wallet address |
| `minAmountUsdc` | `number` | `0` | Minimum USDC required (human-readable) |
| `rpcs` | `string[]` | 3 public RPCs | Base RPC endpoints to try in order |
| `timeoutMs` | `number` | `9000` | Per-RPC timeout in ms |
| `failOpen` | `boolean` | `false` | Return `valid: true` if all RPCs time out |

**VerifyResult:**
```ts
{
  valid: boolean;
  reason?: string;       // why it failed
  amountUsdc?: number;   // actual amount transferred
  rpc?: string;          // which RPC confirmed it
  failedOpen?: boolean;  // true if fail-open triggered
}
```

### `buildPaymentRequired(options)` → `{ status: 402, body: object }`

Builds a standard x402 payment-required response body with step-by-step instructions.

---

## How it works

1. Calls `eth_getTransactionReceipt` on Base via JSON-RPC (no API key needed — public nodes)
2. Scans the transaction logs for an ERC-20 Transfer event from the USDC contract
3. Checks that the `to` field matches your wallet and the amount meets the minimum
4. Falls back through multiple RPC endpoints automatically

The USDC contract on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

---

## Why no API key?

Base exposes public JSON-RPC endpoints. For verifying payments you don't need an Alchemy or Infura key — the public nodes are reliable enough for single-tx lookups. If you need higher throughput, pass your own RPCs in the `rpcs` option.

---

## License

MIT

Built by [Brennan Zambo](https://zambo.dev) · [@zambodotdev](https://x.com/zambodotdev)
