import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({
	fork: vi.fn(),
	spawn: vi.fn(),
}));

vi.mock("node:child_process", () => childProcessMock);

type FakeChild = ChildProcess & {
	connected: boolean;
	stderr: PassThrough;
	stdout?: PassThrough;
	stdin?: PassThrough;
	send?: ChildProcess["send"];
	killed: boolean;
	kill: ChildProcess["kill"];
};

type CapturedWorkerRequest = {
	id: number;
	type: string;
};

function createFakeChild(options: { ipc?: boolean; stdio?: boolean } = { ipc: true }): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.connected = true;
	child.stderr = new PassThrough();
	child.killed = false;
	if (options.ipc) {
		child.send = vi.fn((_message: unknown, callback?: (error: Error | null) => void) => {
			callback?.(null);
			return true;
		}) as ChildProcess["send"];
	}
	if (options.stdio) {
		child.stdin = new PassThrough();
		child.stdout = new PassThrough();
	}
	child.kill = vi.fn(() => {
		child.killed = true;
		return true;
	}) as ChildProcess["kill"];
	return child;
}

function collectStdioRequests(child: FakeChild): CapturedWorkerRequest[] {
	if (!child.stdin) throw new Error("Fake stdio child missing stdin");
	const requests: CapturedWorkerRequest[] = [];
	let buffer = "";
	child.stdin.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (line) requests.push(JSON.parse(line) as CapturedWorkerRequest);
			newlineIndex = buffer.indexOf("\n");
		}
	});
	return requests;
}

function writeStdioResponse(child: FakeChild, response: unknown): void {
	if (!child.stdout) throw new Error("Fake stdio child missing stdout");
	child.stdout.write(`${JSON.stringify(response)}\n`);
}

describe("model worker client", () => {
	beforeEach(() => {
		vi.resetModules();
		childProcessMock.fork.mockReset();
		childProcessMock.spawn.mockReset();
	});

	it("includes worker stderr when the model worker exits before responding", async () => {
		const child = createFakeChild();
		childProcessMock.fork.mockReturnValue(child);
		const { embedInModelWorker } = await import("../../src/model-worker-client.ts");

		const request = embedInModelWorker(["hello"], "passage");
		child.stderr.write("native runtime failed to load\n");
		child.emit("exit", 1, null);

		await expect(request).rejects.toThrow(
			"Model worker exited before responding (code 1, signal null). Worker stderr:\nnative runtime failed to load",
		);
	});

	it("aborting one pending request does not fail unrelated worker requests", async () => {
		const child = createFakeChild();
		childProcessMock.fork.mockReturnValue(child);
		const { embedInModelWorker } = await import("../../src/model-worker-client.ts");
		const firstController = new AbortController();

		const first = embedInModelWorker(["cancel me"], "passage", firstController.signal);
		const second = embedInModelWorker(["keep me"], "passage");
		if (!child.send) throw new Error("Fake IPC child missing send");
		const sendMock = vi.mocked(child.send);
		const secondMessage = sendMock.mock.calls[1]?.[0] as { id: number } | undefined;
		if (!secondMessage) throw new Error("Second request was not sent");

		firstController.abort();
		child.emit("message", { id: secondMessage.id, result: [[0.25, 0.75]] });

		await expect(first).rejects.toThrow("Cancelled");
		await expect(second).resolves.toEqual([new Float32Array([0.25, 0.75])]);
	});

	it("falls back to stdio transport when fork does not expose child.send", async () => {
		const forkChild = createFakeChild({ ipc: false });
		const stdioChild = createFakeChild({ ipc: false, stdio: true });
		const stdioRequests = collectStdioRequests(stdioChild);
		childProcessMock.fork.mockReturnValue(forkChild);
		childProcessMock.spawn.mockReturnValue(stdioChild);
		const { embedInModelWorker } = await import("../../src/model-worker-client.ts");

		const request = embedInModelWorker(["hello"], "passage");
		await vi.waitFor(() => expect(stdioRequests).toHaveLength(1));
		writeStdioResponse(stdioChild, { id: stdioRequests[0].id, result: [[0.1, 0.9]] });

		expect(forkChild.kill).toHaveBeenCalledWith("SIGKILL");
		expect(childProcessMock.spawn).toHaveBeenCalledOnce();
		await expect(request).resolves.toEqual([new Float32Array([0.1, 0.9])]);
	});

	it("routes out-of-order stdio responses to their original requests", async () => {
		childProcessMock.fork.mockReturnValue(createFakeChild({ ipc: false }));
		const stdioChild = createFakeChild({ ipc: false, stdio: true });
		const stdioRequests = collectStdioRequests(stdioChild);
		childProcessMock.spawn.mockReturnValue(stdioChild);
		const { embedInModelWorker } = await import("../../src/model-worker-client.ts");

		const first = embedInModelWorker(["first"], "passage");
		const second = embedInModelWorker(["second"], "passage");
		await vi.waitFor(() => expect(stdioRequests).toHaveLength(2));
		writeStdioResponse(stdioChild, { id: stdioRequests[1].id, result: [[0.2, 0.8]] });
		writeStdioResponse(stdioChild, { id: stdioRequests[0].id, result: [[0.3, 0.7]] });

		await expect(first).resolves.toEqual([new Float32Array([0.3, 0.7])]);
		await expect(second).resolves.toEqual([new Float32Array([0.2, 0.8])]);
	});

	it("rejects pending stdio requests when stdout is not valid worker protocol", async () => {
		childProcessMock.fork.mockReturnValue(createFakeChild({ ipc: false }));
		const stdioChild = createFakeChild({ ipc: false, stdio: true });
		const stdioRequests = collectStdioRequests(stdioChild);
		childProcessMock.spawn.mockReturnValue(stdioChild);
		const { embedInModelWorker } = await import("../../src/model-worker-client.ts");

		const request = embedInModelWorker(["hello"], "passage");
		await vi.waitFor(() => expect(stdioRequests).toHaveLength(1));
		if (!stdioChild.stdout) throw new Error("Fake stdio child missing stdout");
		stdioChild.stdout.write("not json\n");

		await expect(request).rejects.toThrow("Invalid model worker stdio response");
		expect(stdioChild.kill).toHaveBeenCalledWith("SIGKILL");
	});
});
