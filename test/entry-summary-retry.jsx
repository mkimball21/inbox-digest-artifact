import React from "react";
import { createRoot } from "react-dom/client";
import { installMockAnthropicFetch } from "./mockAnthropicFetch.js";
import InboxDigest from "./harness-summary-after.jsx";

// Inject a transient 429/529 on every 4th Messages API call, to verify the
// broadened callWithRetry (429/500/502/503/529 + network errors, with
// jitbased backoff) actually recovers rather than surfacing an error.
installMockAnthropicFetch({ transientErrorEveryNth: 4 });

const store = new Map();
window.storage = {
  async get(key) {
    if (!store.has(key)) throw new Error(`no value for key: ${key}`);
    return store.get(key);
  },
  async set(key, value) {
    store.set(key, value);
  },
};

createRoot(document.getElementById("root")).render(<InboxDigest />);
