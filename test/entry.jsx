import React from "react";
import { createRoot } from "react-dom/client";
import InboxDigest from "./harness.jsx";

// H8 test polyfill: throws on a missing key rather than returning
// null/undefined, matching the real window.storage semantics the handoff
// describes. Backed by an in-memory Map so we can also assert that a second
// load of the same date reads from here instead of re-fetching/re-summarizing.
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
window.__store = store;

createRoot(document.getElementById("root")).render(<InboxDigest />);
