/**
 * Single HTTP helper for the Anthropic Messages API.
 * Used by lib/llm.js (Coach) and lib/judge.js (Judge).
 *
 * Strategy (in order of preference):
 *   1. If `@anthropic-ai/sdk` is installed → use it.
 *   2. Else if Node fetch works (no proxy or transparent proxy) → use fetch.
 *   3. Else if HTTPS_PROXY is set + curl is available → shell out to curl
 *      (curl honors http_proxy / https_proxy env vars natively).
 *
 * Step 3 exists ONLY for the agent sandbox, where Node 18 fetch can't traverse
 * the sandbox proxy. On the user's Mac, step 1 (SDK) handles it cleanly.
 */

const { spawn } = require("child_process");

const URL = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

let sdkClient = null;
try {
  const Anthropic = require("@anthropic-ai/sdk");
  const Ctor = Anthropic.default || Anthropic;
  if (process.env.ANTHROPIC_API_KEY) {
    sdkClient = new Ctor({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
} catch (_) {}

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || null;

function backendInUse() {
  if (!process.env.ANTHROPIC_API_KEY) return "none";
  if (sdkClient) return "anthropic-sdk";
  if (proxyUrl) return "curl-via-proxy";
  return "fetch";
}

async function viaSDK({ system, messages, model, max_tokens, temperature }) {
  try {
    const res = await sdkClient.messages.create({
      model, max_tokens, temperature, system, messages,
    });
    const text =
      res && Array.isArray(res.content) && res.content[0] && res.content[0].text;
    if (!text || !text.trim()) return { error: "empty_response" };
    return { text: text.trim(), model: res.model || model };
  } catch (e) {
    return { error: "sdk_error", detail: e && e.message };
  }
}

async function viaFetch({ system, messages, model, max_tokens, temperature, timeout }) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(URL, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": VERSION,
      },
      body: JSON.stringify({ model, max_tokens, temperature, system, messages }),
    });
    clearTimeout(t);
    if (!r.ok) {
      let detail; try { detail = await r.text(); } catch {}
      return { error: `http_${r.status}`, detail };
    }
    const data = await r.json();
    const block = data && Array.isArray(data.content) && data.content[0];
    const text = block && block.type === "text" && block.text;
    if (!text || !text.trim()) return { error: "empty_response" };
    return { text: text.trim(), model: data.model || model };
  } catch (e) {
    clearTimeout(t);
    if (e && e.name === "AbortError") return { error: "timeout" };
    return { error: "network_error", detail: e && e.message };
  }
}

function viaCurl({ system, messages, model, max_tokens, temperature, timeout }) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model, max_tokens, temperature, system, messages });
    const args = [
      "-sS",
      "--max-time", String(Math.ceil(timeout / 1000)),
      "-X", "POST",
      "-H", "content-type: application/json",
      "-H", `x-api-key: ${process.env.ANTHROPIC_API_KEY}`,
      "-H", `anthropic-version: ${VERSION}`,
      "--data-binary", "@-",
      URL,
    ];
    // In the sandbox: HTTPS_PROXY (http proxy at :3128) strips the x-api-key
    // header, while ALL_PROXY (socks5h at :1080) tunnels TCP raw and works.
    // Strip the HTTP-proxy env vars; keep ALL_PROXY/all_proxy.
    const childEnv = { ...process.env };
    for (const k of ["HTTPS_PROXY","https_proxy","HTTP_PROXY","http_proxy"]) {
      delete childEnv[k];
    }
    const child = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
    let stdout = "";
    let stderr = "";
    let timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve({ error: "timeout" });
    }, timeout + 1000);

    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ error: "curl_spawn_error", detail: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return resolve({ error: `curl_exit_${code}`, detail: stderr.trim() || stdout.slice(0, 200) });
      }
      try {
        const data = JSON.parse(stdout);
        if (data.error) {
          return resolve({ error: `api_${data.error.type || "error"}`, detail: data.error.message });
        }
        const block = data && Array.isArray(data.content) && data.content[0];
        const text = block && block.type === "text" && block.text;
        if (!text || !text.trim()) return resolve({ error: "empty_response" });
        resolve({ text: text.trim(), model: data.model || model });
      } catch (e) {
        resolve({ error: "json_parse_error", detail: stdout.slice(0, 300) });
      }
    });
    child.stdin.write(body);
    child.stdin.end();
  });
}

/**
 * postAnthropic({ system, messages, model, max_tokens, temperature, timeoutMs })
 * → Promise<{ text, model } | { error, detail? }>
 */
async function postAnthropic({ system, messages, model, max_tokens, temperature, timeoutMs }) {
  if (!process.env.ANTHROPIC_API_KEY) return { error: "missing_api_key" };
  const timeout = Number.isFinite(timeoutMs) ? timeoutMs : 10000;

  if (sdkClient) {
    return viaSDK({ system, messages, model, max_tokens, temperature });
  }

  // No SDK. Try fetch first; if it fails AND we have a proxy, fall through to curl.
  const fetchRes = await viaFetch({ system, messages, model, max_tokens, temperature, timeout });
  if (!fetchRes.error || !proxyUrl) return fetchRes;

  // Fetch errored and we have a proxy — try curl as a sandbox-only fallback.
  return viaCurl({ system, messages, model, max_tokens, temperature, timeout });
}

module.exports = { postAnthropic, backendInUse };
