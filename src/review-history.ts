import type { ReviewResult } from "./types.ts";

export interface ReviewHistoryEntry {
  turn: number;
  userRequest: string;
  result: ReviewResult;
}

const MAX_HISTORY_TURNS = 8;
const MAX_HISTORY_BYTES = 16_384;

interface StoredReview {
  entry: ReviewHistoryEntry;
  bytes: number;
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_HISTORY_TURNS) {
    throw new RangeError("Review history limit must be an integer from 0 through 8.");
  }
}

function validateTurn(turn: number, label: string): void {
  if (!Number.isSafeInteger(turn) || turn <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
}

function copyEntry(entry: ReviewHistoryEntry): ReviewHistoryEntry {
  return {
    turn: entry.turn,
    userRequest: entry.userRequest,
    result: {
      model: entry.result.model,
      verdict: entry.result.verdict,
      findings: entry.result.findings.map(finding => ({
        ...(finding.id ? { id: finding.id } : {}),
        severity: finding.severity,
        evidence: finding.evidence,
        explanation: finding.explanation,
        recommendation: finding.recommendation,
      })),
    },
  };
}

/** In-memory completed review summaries, not persistent native advisor history. */
export class ReviewHistory {
  #entries: StoredReview[] = [];
  #serializedBytes = 2; // JSON array brackets, including an empty history.

  clear(): void {
    this.#entries = [];
    this.#serializedBytes = 2;
  }

  /** The caller supplies a validated completed result; failed reviews are not recorded. */
  record(entry: ReviewHistoryEntry, limit: number): void {
    validateLimit(limit);
    validateTurn(entry.turn, "Review history turn");
    if (limit === 0) {
      this.clear();
      return;
    }

    const copy = copyEntry(entry);
    const bytes = Buffer.byteLength(JSON.stringify(copy), "utf8");
    const duplicate = this.#entries.findIndex(stored => stored.entry.turn === copy.turn);
    // A replacement supersedes the old result even if the new result is too large.
    if (duplicate !== -1) this.#remove(duplicate);

    if (bytes + 2 <= MAX_HISTORY_BYTES) {
      const next = this.#entries.findIndex(stored => stored.entry.turn > copy.turn);
      const index = next === -1 ? this.#entries.length : next;
      this.#serializedBytes += bytes + (this.#entries.length > 0 ? 1 : 0);
      this.#entries.splice(index, 0, { entry: copy, bytes });
    }
    // Evict whole oldest summaries; neither requests nor findings are truncated.
    while (this.#entries.length > limit || this.#serializedBytes > MAX_HISTORY_BYTES) {
      this.#remove(0);
    }
  }

  /** Returns newest completed earlier turns in ascending order, with independent copies. */
  snapshot(beforeTurn: number, limit: number): ReviewHistoryEntry[] {
    validateLimit(limit);
    validateTurn(beforeTurn, "Review history boundary turn");
    // A disabled history does not retain summaries to expose when re-enabled.
    if (limit === 0) {
      this.clear();
      return [];
    }

    const snapshot: ReviewHistoryEntry[] = [];
    for (let index = this.#entries.length - 1; index >= 0 && snapshot.length < limit; index--) {
      const entry = this.#entries[index].entry;
      if (entry.turn < beforeTurn) snapshot.push(copyEntry(entry));
    }
    return snapshot.reverse();
  }

  #remove(index: number): void {
    const count = this.#entries.length;
    const [removed] = this.#entries.splice(index, 1);
    this.#serializedBytes -= removed.bytes + (count > 1 ? 1 : 0);
  }
}
