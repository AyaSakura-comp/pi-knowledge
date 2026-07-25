import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_RERANKER_MODEL,
	DEFAULT_RERANKER_REMOTE_HOST,
	rerankerCacheKey,
	resolveRerankerConfig,
} from "../../src/search/reranker-config.ts";

describe("reranker config", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
	});

	it("defaults to the existing local Hugging Face reranker", () => {
		const config = resolveRerankerConfig({});

		expect(config).toEqual({
			provider: "hf",
			model: DEFAULT_RERANKER_MODEL,
			revision: "main",
			dtype: undefined,
			remoteHost: undefined,
			remotePathTemplate: undefined,
		});
	});

	it("accepts bare Hugging Face model ids", () => {
		const config = resolveRerankerConfig({ PI_KNOWLEDGE_RERANKER: "Xenova/ms-marco-MiniLM-L-2-v2" });

		expect(config).toMatchObject({
			provider: "hf",
			model: "Xenova/ms-marco-MiniLM-L-2-v2",
			revision: "main",
		});
	});

	it("normalizes Hugging Face model URLs and revisions", () => {
		const config = resolveRerankerConfig({
			PI_KNOWLEDGE_RERANKER: "https://huggingface.co/Xenova/ms-marco-MiniLM-L-12-v2/tree/custom-rev",
			PI_KNOWLEDGE_RERANKER_DTYPE: "fp32",
		});

		expect(config).toMatchObject({
			provider: "hf",
			model: "Xenova/ms-marco-MiniLM-L-12-v2",
			revision: "custom-rev",
			dtype: "fp32",
			remoteHost: DEFAULT_RERANKER_REMOTE_HOST,
		});
	});

	it("lets explicit env values override URL-derived source options", () => {
		const config = resolveRerankerConfig({
			PI_KNOWLEDGE_RERANKER: "https://hf-mirror.example/acme/reranker/resolve/url-rev/config.json",
			PI_KNOWLEDGE_RERANKER_REVISION: "env-rev",
			PI_KNOWLEDGE_RERANKER_REMOTE_HOST: "https://models.example/",
			PI_KNOWLEDGE_RERANKER_REMOTE_PATH_TEMPLATE: "mirror/{model}/{revision}/",
		});

		expect(config).toMatchObject({
			provider: "hf",
			model: "acme/reranker",
			revision: "env-rev",
			remoteHost: "https://models.example/",
			remotePathTemplate: "mirror/{model}/{revision}/",
		});
	});

	it("parses API mode without enabling it in the local worker", () => {
		const config = resolveRerankerConfig({ PI_KNOWLEDGE_RERANKER: "api:jina-reranker-v2-base-multilingual" });

		expect(config).toEqual({ provider: "api", model: "jina-reranker-v2-base-multilingual" });
	});

	it("builds stable cache keys from every local model-loading field", () => {
		const first = resolveRerankerConfig({ PI_KNOWLEDGE_RERANKER: "Xenova/ms-marco-MiniLM-L-4-v2" });
		const second = resolveRerankerConfig({
			PI_KNOWLEDGE_RERANKER: "Xenova/ms-marco-MiniLM-L-4-v2",
			PI_KNOWLEDGE_RERANKER_REVISION: "other",
		});
		if (first.provider !== "hf" || second.provider !== "hf") throw new Error("Expected hf configs");

		expect(rerankerCacheKey(first)).not.toBe(rerankerCacheKey(second));
		expect(rerankerCacheKey(first)).toContain(DEFAULT_RERANKER_MODEL);
	});

	it("rejects invalid model ids", () => {
		expect(() => resolveRerankerConfig({ PI_KNOWLEDGE_RERANKER: "hf:not-a-repo" })).toThrow(
			"Invalid reranker model id",
		);
	});
});
