// Simulates the parts of the real Anthropic Messages API that matter for
// this investigation: it does NOT fake a plausible summary out of thin air
// for style, it faithfully reproduces the one behavior in question —
// max_tokens truncation — against the REAL prompt text the app actually
// builds and sends (parsed straight out of the real userText), so the
// app's real summarizeBatchRaw/summarizeChunkAdaptive/planSummaryBatches
// code runs completely unmodified against it.
//
// Model behavir being simulated: given a prompt asking for N thread
// summaries at "roughly 25-50% of source length," a real model's total
// output for the batch is modeled as ~40% of the combined source length
// (the middle of the requested range). If that output would exceed the
// request's max_tokens, the response is truncated exactly like a real
// completions API truncates — cut off mid-text — and stop_reason is
// reported as "max_tokens", never invented as an error.
export function installMockAnthropicFetch({ onCall, transientErrorEveryNth } = {}) {
  const realFetch = window.fetch.bind(window);
  window.__realFetch = realFetch;
  window.__mockCallCount = 0;
  window.__mockTransientErrorCount = 0;

  window.fetch = async function (url, options) {
    if (typeof url !== "string" || !url.includes("/v1/messages")) {
      return realFetch(url, options);
    }

    window.__mockCallCount++;

    // Optionally inject a transient 429/529 on every Nth call, to verify
    // callWithRetry's broadened retry (H4's other, secondary risk) actually
    // recovers instead of failing the batch outright.
    if (transientErrorEveryNth && window.__mockCallCount % transientErrorEveryNth === 0) {
      window.__mockTransientErrorCount++;
      const status = window.__mockTransientErrorCount % 2 === 0 ? 429 : 529;
      return {
        ok: false,
        status,
        text: async () => JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "simulated transient error" } }),
      };
    }

    const body = JSON.parse(options.body);
    const userText = body.messages[0].content;
    const maxTokens = body.max_tokens;
    const isSummaryCall = !body.mcp_servers || body.mcp_servers.length === 0;

    if (onCall) onCall({ userText, maxTokens, mcpServers: body.mcp_servers });

    if (!isSummaryCall) {
      // This investigation is scoped to summarization; every other call
      // type in this test is stubbed out at the app layer instead, so this
      // path should not be reachable — fail loudly if it is.
      throw new Error("mockAnthropicFetch: unexpected non-summary Messages API call");
    }

    const forceShort = /shortened due to length/.test(userText);
    const threadRe = /Thread \(threadId: ([^,]+), subject: "([\s\S]*?)"\):\n([\s\S]*?)(?=\n\n=====\n\n|\n\nReturn ONLY)/g;
    const threads = [];
    let m;
    while ((m = threadRe.exec(userText)) !== null) {
      threads.push({ threadId: m[1], subject: m[2], bodyText: m[3] });
    }

    const summaries = threads.map((t) => {
      const sourceLen = t.bodyText.length;
      const targetLen = forceShort ? Math.min(sourceLen * 0.4, 1500) : sourceLen * 0.4;
      const filler = `Simulated summary content for "${t.subject}". `;
      const text = filler.repeat(Math.max(1, Math.ceil(targetLen / filler.length))).slice(0, Math.max(20, Math.floor(targetLen)));
      return { threadId: t.threadId, summary: text };
    });

    const fullJson = JSON.stringify(summaries);
    const estTokens = Math.ceil(fullJson.length / 4);

    let responseText = fullJson;
    let stopReason = "end_turn";
    if (estTokens > maxTokens) {
      const cutChars = maxTokens * 4;
      responseText = fullJson.slice(0, cutChars);
      stopReason = "max_tokens";
    }

    const payload = { content: [{ type: "text", text: responseText }], stop_reason: stopReason };
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
}
