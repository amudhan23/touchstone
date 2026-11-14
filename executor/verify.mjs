#!/usr/bin/env node
// Verify a live vault from your terminal. Read-only: signs nothing, spends nothing,
// needs no keys. Runs the SAME four checks as the vault page (frontend/verify.js),
// plus two only a terminal can do comfortably: every vault-signed Sepolia swap
// carries its decision's commitment, and the contract can pay every holder.
//
//   node verify.mjs [--vault vault.alpha-vaults-23.testnet] [--rpc https://test.rpc.fastnear.com]
//
// Exit code 0 only if every check passes.
import { readFileSync } from "node:fs";
import { LiveVault } from "../frontend/near-rpc.mjs";
import * as V from "../frontend/verify.js";
import * as proofs from "../frontend/pkg/vault_proofs.js";
import { netFor } from "./net.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const vaultId = arg("vault", "vault.alpha-vaults-23.testnet");
const NET = netFor(vaultId);
const rpc = arg("rpc", NET.nearRpc);
const sepolia = arg("evm-rpc", NET.evm.rpc);

const C = process.stdout.isTTY ? { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" } : { g: "", r: "", y: "", d: "", b: "", x: "" };
const mark = { ok: `${C.g}✓${C.x}`, bad: `${C.r}✗${C.x}`, wait: `${C.y}…${C.x}` };
const results = [];
function report(name, res) {
  results.push(res.state);
  console.log(`${mark[res.state] ?? "?"} ${C.b}${name}${C.x}\n  ${res.detail}`);
}

// Public RPCs sit behind load balancers; a lagging backend answers null for a tx it hasn't seen.
// So: try the configured RPC, then a fallback, and only give up after several rounds.
const evmRpcs = [...new Set([sepolia, NET.evm.chainId === 11155111 ? "https://sepolia.drpc.org" : "https://mainnet.base.org"])];
async function evmOnce(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15000) });
  return (await r.json()).result;
}
async function evm(method, params) {
  for (let round = 0; round < 10; round++) {
    for (const url of evmRpcs) {
      const res = await evmOnce(url, method, params).catch(() => null);
      if (res) return res;
    }
    await new Promise((r) => setTimeout(r, 400 + 300 * round));
  }
  return null;
}

/** Check 5: each recorded Sepolia execution succeeded and its calldata ends in the decision's commitment.
 * Swaps before v4 were sent by the executor's own wallet (that design was replaced after review 1);
 * they are reported as such, not hidden. */
async function checkSwapsCarryCommitments(vault) {
  const recorded = vault.commitments.filter((c) => /0x[0-9a-f]{64}$/i.test(c.execution_ref ?? ""));
  if (!recorded.length) return { state: "wait", detail: "no swaps recorded on this vault yet" };
  let vaultSigned = 0, legacy = 0, reverted = 0;
  for (const c of recorded) {
    const hash = c.execution_ref.slice(-66);
    const tx = await evm("eth_getTransactionByHash", [hash]);
    const rc = tx && await evm("eth_getTransactionReceipt", [hash]);
    if (!tx || !rc) return { state: "wait", detail: `Sepolia tx ${hash.slice(0, 12)}… not reachable right now` };
    if (!tx.input.toLowerCase().includes(c.commitment.toLowerCase())) return { state: "bad", detail: `#${c.id}: swap calldata does not carry commitment ${c.commitment.slice(0, 12)}…` };
    if (rc.status !== "0x1") { if (c.execution_ref.startsWith("reverted:")) { reverted++; continue; } return { state: "bad", detail: `#${c.id}: recorded as filled but Sepolia tx ${hash} reverted` }; }
    if (tx.from.toLowerCase() === vault.evm_address.toLowerCase()) vaultSigned++; else legacy++;
  }
  return { state: "ok", detail: `${recorded.length} recorded swaps all carry their decision's commitment in calldata: ${vaultSigned} signed by the vault's own wallet ${vault.evm_address.slice(0, 10)}…${legacy ? `, ${legacy} from before v4 signed by the executor's wallet (the design review 1 replaced)` : ""}${reverted ? `, ${reverted} recorded honestly as reverted` : ""}` };
}

/** Check 6: free balance (after storage stake) covers the NEAR pool every holder can withdraw now. */
async function checkSolvency(lv) {
  const s = await lv.view("get_summary");
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: vaultId } }) });
  const a = (await r.json()).result;
  const locked = BigInt(a.storage_usage) * 10n ** 19n;
  const free = BigInt(a.amount) - locked;
  const pool = BigInt(s.pool_yocto);
  const n = (y) => (Number(y / 10n ** 20n) / 1e4).toFixed(4);
  if (free < pool) return { state: "bad", detail: `free balance ${n(free)} NEAR < pool ${n(pool)} NEAR owed to holders` };
  return { state: "ok", detail: `free balance ${n(free)} NEAR ≥ pool ${n(pool)} NEAR (code + state stake ${n(locked)} NEAR); mode ${s.mode}, deposits ${s.deposits_open ? "open" : "closed while value is cross-chain"}` };
}

async function accessKeys() {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key_list", finality: "final", account_id: vaultId } }) });
  return (await r.json()).result.keys.length;
}

async function main() {
  await proofs.default({ module_or_path: readFileSync(new URL("../frontend/pkg/vault_proofs_bg.wasm", import.meta.url)) });
  const lv = new LiveVault(vaultId, rpc);
  const vault = await lv.load();
  console.log(`${C.b}Verifying ${vaultId}${C.x} ${C.d}(read-only; no keys)${C.x}`);
  console.log(`${C.d}approved strategy ${vault.approved_wasm_hash ?? ""} · ${vault.commitments.length} commitments · ${vault.risk_proofs.length} risk proofs${C.x}\n`);
  report("1. Which code ran (Intel TDX attestations)", await V.checkCodeAttestedDeep(vault));
  report("2. Every decision committed before it executed", await V.checkTradesCommitted(vault));
  report("3. Risk limits held (Bulletproofs, verified here)", await V.checkRiskProven(vault));
  report("4. Real market prices went in", await V.checkPricesVerified(vault));
  report(`5. Swaps on ${NET.evm.name} match their commitments`, await checkSwapsCarryCommitments(vault));
  report("6. The vault can pay every holder", await checkSolvency(lv));
  // Not counted as a check: the rehearsal vault keeps its key on purpose. Shown so nobody has to take "locked" on faith.
  const keys = await accessKeys();
  console.log(keys === 0
    ? `${C.g}🔒${C.x} ${C.b}No access keys on the vault account${C.x}\n  nobody can redeploy it; code changes only via propose_code → 48h → apply_code`
    : `${C.d}ℹ ${keys} access key(s) on the vault account: whoever holds one can replace the code (the main vault has none)${C.x}`);
  const bad = results.filter((r) => r === "bad").length, wait = results.filter((r) => r === "wait").length;
  console.log(`\n${bad ? `${C.r}${bad} check(s) FAILED${C.x}` : `${C.g}${results.length - wait}/${results.length} passed${C.x}`}${wait ? ` · ${wait} not applicable / unreachable` : ""}`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e.message); process.exit(2); });
