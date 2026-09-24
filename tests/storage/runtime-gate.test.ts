import { describe, expect, test } from "vitest";
import { assertSupportedRuntime, probeRuntime, REQUIRED_SQLITE_VERSION } from "../../src/storage/database.js";
import { catchMemchorError } from "../helpers.js";

const FTS5 = ["ENABLE_FTS5", "THREADSAFE=1"];

describe("SQLite runtime gate", () => {
  test("requires the WAL-reset fix release, 3.51.3", () => {
    expect(REQUIRED_SQLITE_VERSION).toBe("3.51.3");
    expect(() => { assertSupportedRuntime({ sqliteVersion: "3.51.3", compileOptions: FTS5, fts5Works: true }); }).not.toThrow();
    expect(() => { assertSupportedRuntime({ sqliteVersion: "3.60.0", compileOptions: FTS5, fts5Works: true }); }).not.toThrow();
    for (const old of ["3.51.2", "3.50.7", "3.44.6", "3.7.0"]) {
      const error = catchMemchorError(() => { assertSupportedRuntime({ sqliteVersion: old, compileOptions: FTS5, fts5Works: true }); });
      expect(error.code).toBe("unsupported_runtime");
      expect(error.message).toContain(old);
      expect(error.message).toContain("3.51.3");
      expect(error.details).toMatchObject({ sqliteVersion: old, requiredSqliteVersion: "3.51.3" });
    }
  });

  test("requires FTS5 to be both compiled in and working", () => {
    expect(catchMemchorError(() => { assertSupportedRuntime({ sqliteVersion: "3.53.4", compileOptions: ["THREADSAFE=1"], fts5Works: false }); }).message).toMatch(/FTS5/);
    expect(catchMemchorError(() => { assertSupportedRuntime({ sqliteVersion: "3.53.4", compileOptions: FTS5, fts5Works: false }); }).code).toBe("unsupported_runtime");
  });

  test("the embedded SQLite passes", () => {
    const runtime = probeRuntime();
    expect(runtime.supported).toBe(true);
    expect(runtime.fts5).toBe(true);
  });
});
