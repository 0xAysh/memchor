import { writeConsent } from "../../dist/import/consent.js";

if (typeof process.send !== "function") throw new Error("consent writer requires an IPC channel");

const finish = (message) => process.send?.(message, () => process.disconnect());

process.send({ ready: true });
process.once("message", (message) => {
  try {
    const { home, repositoryKey } = message;
    writeConsent(home, "claude-code", "current_project", repositoryKey);
    finish({ ok: true });
  } catch (error) {
    finish({ ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  }
});
