/**
 * Tiny zero-dep .env loader.
 *
 * Reads ./prototype/.env (if it exists) at startup and sets process.env
 * variables. Skips lines that are blank, comments (#), or already set in the
 * environment (so real env vars always win over the file).
 *
 * Format: KEY=VALUE per line. Quotes around the value are optional and stripped.
 *
 * No dependency. Just call loadEnv() once near the top of the server.
 */

const fs = require("fs");
const path = require("path");

function loadEnv(filepath) {
  const target = filepath || path.join(__dirname, "..", ".env");
  if (!fs.existsSync(target)) return { loaded: 0, path: target, present: false };

  const raw = fs.readFileSync(target, "utf8");
  let loaded = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
      loaded++;
    }
  }
  return { loaded, path: target, present: true };
}

module.exports = { loadEnv };
