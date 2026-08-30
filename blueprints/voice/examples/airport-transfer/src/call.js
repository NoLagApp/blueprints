/**
 * Places an outbound call, so the agent rings someone instead of waiting to be
 * rung. Everything after the answer is the same pipeline as an inbound call.
 *
 * Usage:
 *   npm run call -- +61400000000
 *
 * Twilio dials the number, and when it is answered it fetches the TwiML at
 * PUBLIC_HOST/voice, which hands the audio to the same Media Streams
 * WebSocket. So this needs the server running AND reachable from the public
 * internet; a tunnel to localhost is not optional here the way it is for the
 * browser simulator.
 *
 * Only call numbers you own or have consent to call. The agent announces that
 * it is an AI in its first sentence, which is a legal requirement in many
 * places and the right thing to do everywhere.
 */

import "dotenv/config";

const to = process.argv[2];
if (!to || !to.startsWith("+")) {
  console.error("Usage: npm run call -- +61400000000   (E.164 format, with country code)");
  process.exit(1);
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name} in .env (see .env.example)`);
    process.exit(1);
  }
  return value;
}

// The account SID always identifies WHICH account, even when an API key is
// doing the authenticating, because it is part of the URL.
const accountSid = required("TWILIO_ACCOUNT_SID");
const from = required("TWILIO_NUMBER");
const publicHost = required("PUBLIC_HOST");

// Prefer an API key (revocable, scoped) over the account-wide auth token.
// Twilio takes both as HTTP basic auth, just with a different username.
const apiKeySid = process.env.TWILIO_API_KEY_SID;
const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
const [authUser, authPass] =
  apiKeySid && apiKeySecret ? [apiKeySid, apiKeySecret] : [accountSid, required("TWILIO_AUTH_TOKEN")];

if (apiKeySid && !apiKeySid.startsWith("SK")) {
  console.error(`TWILIO_API_KEY_SID should start with "SK", got "${apiKeySid.slice(0, 4)}..."`);
  process.exit(1);
}
console.log(`Authenticating with ${apiKeySid && apiKeySecret ? `API key ${apiKeySid.slice(0, 6)}…` : "account auth token"}`);

if (publicHost.startsWith("http") || publicHost.endsWith("/")) {
  console.error(`PUBLIC_HOST must be a bare hostname, got "${publicHost}"`);
  process.exit(1);
}
if (publicHost.startsWith("localhost")) {
  console.error(
    `PUBLIC_HOST is "${publicHost}". Twilio has to reach this server from the ` +
      `internet, so set it to a public tunnel hostname before placing a call.`
  );
  process.exit(1);
}

// Twilio isolates some accounts by region (Australia is au1, Ireland ie1).
// Regional accounts must be driven through their own API host, and their
// credentials are not accepted anywhere else.
const region = process.env.TWILIO_REGION?.trim();
const apiBase = region ? `https://api.${region}.twilio.com` : "https://api.twilio.com";
if (region) console.log(`Using the ${region} region (${apiBase})`);

const url = `https://${publicHost}/voice?outbound=1`;
console.log(`Calling ${to} from ${from}`);
console.log(`Twilio will fetch: ${url}`);

const body = new URLSearchParams({ To: to, From: from, Url: url, Method: "POST" });
const res = await fetch(
  `${apiBase}/2010-04-01/Accounts/${accountSid}/Calls.json`,
  {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${authUser}:${authPass}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  }
);

const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`\nTwilio rejected the call: HTTP ${res.status}`);
  console.error(`  ${data.message ?? JSON.stringify(data).slice(0, 400)}`);
  if (data.code === 21219 || data.code === 21210) {
    console.error("  (trial accounts can only call numbers you have verified in the console)");
  }
  process.exit(1);
}

console.log(`\nCall placed. CallSid ${data.sid}, status ${data.status}`);
console.log(`Watch and steer it with:\n  npm run monitor ${data.sid.toLowerCase()}`);
