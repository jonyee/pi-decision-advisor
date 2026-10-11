import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { Tokenizer } from "@huggingface/tokenizers";

// Qwen/Qwen3.5-9B, revision c202236235762e1c871ad0ccb60c8ee5ba337b9a.
// Unmodified tokenizer.json, gzip-compressed; Apache-2.0 (qwen35-tokenizer.LICENSE).
// Original SHA-256: 5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42.
let tokenizer: Tokenizer | undefined;
type PreTokenizerPiece = (text: string) => string[];
let splitter: PreTokenizerPiece;
let byteLevel: PreTokenizerPiece;
let addedTokens: string[];
const MAX_CACHED_PIECES = 16_384;
const MAX_CACHED_PIECE_LENGTH = 256;
const MAX_CACHED_STATE_LENGTH = 131_072;
const MAX_CACHED_STATES = 8;
const pieceCounts = new Map<string, number>();
const stateCounts = new Map<string, number>();

function initializeTokenizer(): Tokenizer {
  if (tokenizer) return tokenizer;
  const config = JSON.parse(gunzipSync(readFileSync(new URL("./qwen35-tokenizer.json.gz", import.meta.url))).toString("utf8"));
  tokenizer = new Tokenizer(config, {});
  // The pinned Sequence exposes its configured Split and ByteLevel callables.
  const sequence = tokenizer.pre_tokenizer as unknown as { tokenizers: [PreTokenizerPiece, PreTokenizerPiece] };
  [splitter, byteLevel] = sequence.tokenizers;
  addedTokens = config.added_tokens.map((token: { content: string }) => token.content);
  return tokenizer;
}

/** Counts exactly through the limit; a result above it proves overflow without counting the rest. */
export function countEvidenceTokens(state: string, stopAfter = Infinity): number {
  const cached = stateCounts.get(state);
  if (cached !== undefined) return cached;
  const currentTokenizer = initializeTokenizer();
  let count = 0;
  if (addedTokens.some(token => state.includes(token))) {
    // Preserve the tokenizer's special-token splitting and whitespace handling.
    count = currentTokenizer.tokenize(state, { add_special_tokens: false }).length;
  } else {
    // The pinned tokenizer normalizes NFC, then Split -> ByteLevel (no prefix or
    // regex), then BPE with fuse_unk=false. BPE never merges across these actual
    // Split pieces, so summing their cached model counts is the exact whole-text
    // count, without repeatedly byte-encoding/BPE-encoding the unchanged core.
    const normalized = currentTokenizer.normalizer ? currentTokenizer.normalizer(state) : state;
    for (const piece of splitter(normalized)) {
      const cachedPiece = pieceCounts.get(piece);
      const tokens: number = cachedPiece ?? currentTokenizer.model!.encode(byteLevel(piece)).length;
      if (cachedPiece === undefined && piece.length <= MAX_CACHED_PIECE_LENGTH) {
        if (pieceCounts.size === MAX_CACHED_PIECES) pieceCounts.delete(pieceCounts.keys().next().value!);
        pieceCounts.set(piece, tokens);
      }
      count += tokens;
      if (count > stopAfter) return count;
    }
  }
  if (state.length <= MAX_CACHED_STATE_LENGTH) {
    if (stateCounts.size === MAX_CACHED_STATES) stateCounts.delete(stateCounts.keys().next().value!);
    stateCounts.set(state, count);
  }
  return count;
}
