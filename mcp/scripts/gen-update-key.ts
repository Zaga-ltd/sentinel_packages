#!/usr/bin/env bun
// Makes the keypair that signs the update manifest.
//
//   bun packages/mcp/scripts/gen-update-key.ts
//
// Prints two values and writes nothing: the public key goes into
// src/update-key.ts (committed — every installed copy checks against it), the
// private key into SENTRINEL_UPDATE_SIGNING_KEY wherever the site is built
// (.env.deploy, never the repository). apps/web/build.ts signs mcp-version.json
// with it and refuses to call a manifest signed unless it verifies against the
// committed public key.
//
// Rotating means every installed copy stops auto-updating until it is
// reinstalled, because it only trusts the key it was built with. Keep the
// private key somewhere it will outlive a laptop.

import { generateKeyPairSync } from "node:crypto";

import { publicKeyOf } from "../src/signature";

const { privateKey } = generateKeyPairSync("ed25519");
const priv = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64");

console.log(`UPDATE_PUBLIC_KEY (src/update-key.ts):\n  ${publicKeyOf(priv)}\n`);
console.log(`SENTRINEL_UPDATE_SIGNING_KEY (secret — build environment only):\n  ${priv}`);
