#!/usr/bin/env node

import { isSupportedNodeVersion } from "./node-version.js";

const activeNodeVersion = process.versions.node;

if (!isSupportedNodeVersion(activeNodeVersion)) {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: {
        code: "UNSUPPORTED_NODE_VERSION",
        message: `ijctl requires Node.js 20 or newer; active version is ${activeNodeVersion}.`,
        activeNodeVersion,
        requiredNodeVersion: "20+",
      },
    })}\n`,
  );
  process.exitCode = 1;
} else {
  await import("./cli-main.js");
}
