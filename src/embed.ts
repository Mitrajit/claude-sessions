// Local text embeddings for search by meaning. The model is installed by hand and never downloaded.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MODEL_ID = "Xenova/bge-small-en-v1.5";
export const MODEL_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"];
// bge models expect this prefix on queries (not on passages).
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

const modelRoot = () => process.env.CLAUDE_SESSIONS_MODEL_DIR ??
  path.join(process.env.CLAUDE_SESSIONS_HOME ?? path.join(os.homedir(), ".claude-sessions"), "models");
export const modelPath = () => path.join(modelRoot(), MODEL_ID);
export const modelPresent = () => MODEL_FILES.every((f) => fs.existsSync(path.join(modelPath(), f)));

let extractor: Promise<any> | null = null;

/** Normalized 384-dim vectors, so a dot product is cosine similarity. */
export async function embed(texts: string[], asQuery = false): Promise<Float32Array[]> {
  extractor ??= (async () => {
    const t = await import("@huggingface/transformers"); // heavy; only loaded when needed
    t.env.allowRemoteModels = false;
    t.env.localModelPath = modelRoot();
    return t.pipeline("feature-extraction", MODEL_ID, { dtype: "q8" });
  })();
  const out = await (await extractor)(asQuery ? texts.map((t) => QUERY_PREFIX + t) : texts, { pooling: "cls", normalize: true });
  const [n, d] = out.dims as number[];
  const data = out.data as Float32Array;
  return Array.from({ length: n }, (_, i) => data.slice(i * d, (i + 1) * d));
}
