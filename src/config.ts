import { Buffer } from "node:buffer";
import { parseReviewTools } from "./review-tools.js";
import type { DecisionOptions } from "./types.js";

export const MIN_PASS_THRESHOLD = 0.5;
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 120_000;
export const MAX_HOST_TIMEOUT_MS = 20_000;
export const MAX_REVIEW_INSTRUCTIONS_BYTES = 8_192;
export const MAX_REVIEW_HISTORY_TURNS = 8;

export interface DecisionSettings extends DecisionOptions {
  enabled: boolean;
  verbose: boolean;
  reviewModel: string;
  advisorTimeoutMs: number;
  reviewTools: string;
  reviewInstructions: string;
  reviewHistoryTurns: number;
}

function validateEndpoint(value: string, allowTestLoopback = false): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Scoring endpoint must be an absolute HTTPS URL.");
  }
  const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "https:" && !(allowTestLoopback && loopback && endpoint.protocol === "http:")) {
    throw new Error("Scoring endpoint must use HTTPS; HTTP is permitted only for isolated loopback tests.");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
    throw new Error("Scoring endpoint must be the account HTTPS origin, without credentials, paths, query or fragment.");
  }
  return endpoint.origin;
}

function validateDeployment(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("Scoring deployment must be a name of 1–128 letters, digits, dots, underscores or hyphens.");
  }
}

function validateThreshold(value: number): void {
  if (!Number.isFinite(value) || value < MIN_PASS_THRESHOLD || value > 1) {
    throw new Error("Pass threshold must be a finite number between 0.5 and 1.");
  }
}

function validateTimeout(value: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > maximum) {
    throw new Error(`${label} must be an integer between ${MIN_TIMEOUT_MS} and ${maximum} milliseconds.`);
  }
}

function validateCredentialMode(value: unknown): asserts value is DecisionOptions["credentialMode"] {
  if (value !== "azure-cli" && value !== "default") {
    throw new Error("Azure credential mode must be azure-cli or default.");
  }
}

/** HTTP is accepted only with explicitly injected test credentials on literal loopback. */
export function validateDecisionOptions(options: DecisionOptions, allowTestLoopback = false): DecisionOptions {
  if (typeof options.endpoint !== "string" || !options.endpoint || typeof options.deployment !== "string" || !options.deployment) {
    throw new Error("Configure a scoring endpoint and deployment with /decision before enabling Azure decision scoring.");
  }
  const endpoint = validateEndpoint(options.endpoint, allowTestLoopback);
  validateDeployment(options.deployment);
  validateThreshold(options.passThreshold);
  validateTimeout(options.timeoutMs, MAX_TIMEOUT_MS, "Scoring timeout");
  validateCredentialMode(options.credentialMode);
  return { endpoint, deployment: options.deployment, passThreshold: options.passThreshold, timeoutMs: options.timeoutMs, credentialMode: options.credentialMode };
}

function stringSetting(raw: Record<string, unknown>, key: string, fallback: string): string {
  const value = raw[key] === undefined ? fallback : raw[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  return value.trim();
}

function numberSetting(raw: Record<string, unknown>, key: string, fallback: number): number {
  const value = raw[key] === undefined ? fallback : raw[key];
  if (typeof value !== "number") throw new Error(`${key} must be a number.`);
  return value;
}

function booleanSetting(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key] === undefined ? fallback : raw[key];
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean.`);
  return value;
}

/** Normalize persisted preferences without requiring an already configured Azure provider. */
export function normalizeDecisionSettings(raw: Record<string, unknown>): DecisionSettings {
  const enabled = booleanSetting(raw, "enabled", true);
  const verbose = booleanSetting(raw, "verbose", false);
  const endpointValue = stringSetting(raw, "endpoint", "");
  const deployment = stringSetting(raw, "deployment", "");
  const reviewModel = stringSetting(raw, "reviewModel", "");
  const credentialMode = raw.credentialMode === undefined ? "azure-cli" : raw.credentialMode;
  const passThreshold = numberSetting(raw, "passThreshold", 0.8);
  const timeoutMs = numberSetting(raw, "timeoutMs", 10_000);
  const advisorTimeoutMs = numberSetting(raw, "advisorTimeoutMs", 20_000);
  const reviewTools = parseReviewTools(stringSetting(raw, "reviewTools", "read,grep,find")).join(",");
  const reviewInstructions = raw.reviewInstructions === undefined ? "" : raw.reviewInstructions;
  if (typeof reviewInstructions !== "string") throw new Error("reviewInstructions must be a string.");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(reviewInstructions)) {
    throw new Error("Reviewer instructions must not contain control characters other than tab, newline or carriage return.");
  }
  if (Buffer.byteLength(reviewInstructions, "utf8") > MAX_REVIEW_INSTRUCTIONS_BYTES) {
    throw new Error(`Reviewer instructions must not exceed ${MAX_REVIEW_INSTRUCTIONS_BYTES} UTF-8 bytes.`);
  }
  const reviewHistoryTurns = numberSetting(raw, "reviewHistoryTurns", 3);
  if (!Number.isInteger(reviewHistoryTurns) || reviewHistoryTurns < 0 || reviewHistoryTurns > MAX_REVIEW_HISTORY_TURNS) {
    throw new Error(`Review history entries must be an integer from 0 to ${MAX_REVIEW_HISTORY_TURNS}.`);
  }
  const endpoint = endpointValue ? validateEndpoint(endpointValue) : "";
  if (deployment) validateDeployment(deployment);
  if (reviewModel && (!/^[^\s/@]+\/[^\s@]+$/.test(reviewModel) || /[\u0000-\u001f\u007f-\u009f]/.test(reviewModel))) {
    throw new Error("Reviewer model must be an explicit provider/model ID, or blank when unconfigured.");
  }
  validateCredentialMode(credentialMode);
  validateThreshold(passThreshold);
  validateTimeout(timeoutMs, MAX_HOST_TIMEOUT_MS, "Scoring timeout");
  validateTimeout(advisorTimeoutMs, MAX_HOST_TIMEOUT_MS, "Automatic reviewer timeout");
  return { enabled, verbose, endpoint, deployment, reviewModel, credentialMode, passThreshold, timeoutMs, advisorTimeoutMs, reviewTools, reviewInstructions, reviewHistoryTurns };
}

export function toDecisionOptions(settings: DecisionSettings): DecisionOptions {
  return validateDecisionOptions(normalizeDecisionSettings({ ...settings }));
}
