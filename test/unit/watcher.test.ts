import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWatcher, stopAllWatchers } from "../../src/watcher/file-watcher.ts";

const TEST_DIR = "/tmp/pk-test-watcher";

describe("file watcher exclusions", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		rmSync(TEST_DIR, { recursive: true, force: true });
		mkdirSync(join(TEST_DIR, "node_modules"), { recursive: true });
		writeFileSync(join(TEST_DIR, "src.ts"), "export const WatchSource = 1;");
		writeFileSync(join(TEST_DIR, "node_modules", "pkg.js"), "export const IgnoredVendor = 1;");
	});

	afterEach(() => {
		stopAllWatchers();
		vi.useRealTimers();
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("does not trigger updates for suggested-excluded files", async () => {
		const updates: string[] = [];
		startWatcher("kb", TEST_DIR, (kbId) => updates.push(kbId));

		writeFileSync(join(TEST_DIR, "node_modules", "pkg.js"), "export const IgnoredVendor = 2;");
		await vi.advanceTimersByTimeAsync(5_000);

		expect(updates).toEqual([]);

		writeFileSync(join(TEST_DIR, "src.ts"), "export const WatchSource = 2;");
		await vi.advanceTimersByTimeAsync(5_000);

		expect(updates).toEqual(["kb"]);
	});
});
