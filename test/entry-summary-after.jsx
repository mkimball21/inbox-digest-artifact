import React from "react";
import { createRoot } from "react-dom/client";
import { installMockAnthropicFetch } from "./mockAnthropicFetch.js";
import InboxDigest from "./harness-summary-after.jsx";

installMockAnthropicFetch();

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
