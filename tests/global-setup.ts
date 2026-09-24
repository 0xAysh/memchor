import { execFileSync } from "node:child_process";

/** Seam (b) spawns the real `dist/cli.js`, so build it once before any test file runs. */
export default function setup(): void {
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });
}
