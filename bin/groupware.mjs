#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/cli");
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const child = spawn(process.execPath, [tsx, cli, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
child.on("exit", (code, signal) => process.exitCode = code ?? (signal ? 1 : 0));
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
