// Shared plumbing for the live-API test scripts. Extracts the EXACT,
// unmodified plain-JS logic out of ../inbox-digest.jsx (parser, grouping,
// summarization, retry) at run time via a source slice — never a
// hand-copied duplicate — so these tests always exercise the real,
// currently-shipped code, not a snapshot that can drift from it.
//
// Never touches ANTHROPIC_API_KEY except to read it from process.env and
// attach it to real requests in-memory. Never logged, never written to
// disk, never included in any thrown error message.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CORE_EXPORTS = [
  "parseReportText",
  "groupIntoThreads",
  "stripReplyPrefix",
  "estimateThreadOutputTokens",
  "planSummaryBatches",
  "buildSummaryPrompt",
  "summarizeBatchRaw",
  "summarizeChunkAdaptive",
  "summarizeAllThreads",
  "callMessagesAPI",
  "callWithRetry",
  "MAX_TOKENS",
  "MODEL",
  "SUMMARY_BATCH_MAX_THREADS",
  "SUMMARY_BATCH_TARGET_OUTPUT_TOKENS",
  "JSON_OVERHEAD_TOKENS_PER_THREAD",
  "SUMMARY_CONCURRENCY_DEFAULT",
  "SUMMARY_CONCURRENCY_MIN",
  "LOW_TEXT_PLACEHOLDER",
];

/**
 * Slices the plain-JS section of inbox-digest.jsx (everything from the
 * window.storage helpers through the end of the Gmail-actions section --
 * i.e. every function used by the summarization pipeline, none of which
 * contain JSX) and evaluates it in this process's own global scope via
 * vm.Script/runInThisContext, so a bare `fetch(...)` call inside the
 * extracted code resolves to whatever this script has set
 * globalThis.fetch to (see installLoggingFetch below).
 */
export function loadCore() {
  const srcPath = path.join(__dirname, "..", "inbox-digest.jsx");
  const src = fs.readFileSync(srcPath, "utf8");

  // Starts at "// Config" (the constants block — MAX_TOKENS, MODEL, the
  // batching/retry tuning constants — that the summarization functions
  // close over) and runs through the end of the Gmail-actions section,
  // stopping before the JSX-containing component code.
  const startMarker = "// Config";
  const endMarker = "// Small presentational bits";
  const startIdx = src.indexOf(startMarker);
  const endIdx = src.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      "live-api-lib: extraction anchors not found in inbox-digest.jsx — the file structure changed, update the markers here."
    );
  }
  // Back up to the start of that comment block, forward to just before the
  // next section's comment block, so we get complete functions only.
  const blockStart = src.lastIndexOf("// ---", startIdx);
  const blockEnd = src.lastIndexOf("// ---", endIdx);
  const body = src.slice(blockStart, blockEnd);

  const wrapped = `(function (module) {\n${body}\nmodule.exports = { ${CORE_EXPORTS.join(", ")} };\n})`;
  const script = new vm.Script(wrapped, { filename: "inbox-digest-core.generated.js" });
  const fn = script.runInThisContext();
  const mod = { exports: {} };
  fn(mod);

  for (const name of CORE_EXPORTS) {
    if (!(name in mod.exports)) {
      throw new Error(`live-api-lib: expected export "${name}" was not found in the extracted slice.`);
    }
  }
  return mod.exports;
}

/**
 * Installs a global fetch wrapper that:
 *  - attaches the real x-api-key / anthropic-version headers (the shipped
 *    app never sets these itself, matching the Claude.ai artifact runtime
 *    where auth is injected transparently — here we do that injection).
 *  - logs status, stop_reason, and real token usage for EVERY Messages API
 *    call (success or failure), without altering the request or response
 *    the calling code sees.
 * Returns the log array (mutated in place as calls complete) and a
 * restore() function.
 */
export function installLoggingFetch(apiKey) {
  const realFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async function (url, options) {
    if (typeof url !== "string" || !url.includes("/v1/messages")) {
      return realFetch(url, options);
    }
    const headers = { ...(options.headers || {}), "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    const res = await realFetch(url, { ...options, headers });
    const clone = res.clone();
    clone
      .json()
      .then((data) => {
        let threadCount = null;
        let maxTokens = null;
        try {
          const reqBody = JSON.parse(options.body);
          maxTokens = reqBody.max_tokens;
          const content = reqBody.messages[0].content;
          threadCount = (content.match(/Thread \(threadId:/g) || []).length;
        } catch (e) {
          // best-effort only
        }
        calls.push({
          status: res.status,
          ok: res.ok,
          stopReason: data.stop_reason,
          usage: data.usage,
          threadCount,
          maxTokens,
          errorType: data.error ? data.error.type : null,
        });
      })
      .catch(() => {
        calls.push({ status: res.status, ok: res.ok, parseError: true });
      });
    return res;
  };

  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

export function loadReport(reportPath) {
  return fs.readFileSync(reportPath, "utf8");
}
