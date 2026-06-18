/**
 * main.ts — the bootstrap (arch-001).
 *
 * The former imperative UI/runtime layer now lives in Svelte components
 * (src/App.svelte + src/lib/*) driving the reactive store in lib/state.svelte.ts,
 * with the ported runtime logic in lib/controller.ts and the pure, unit-tested
 * decisions still in player-core.ts. This file just mounts the root component.
 */
import { mount } from "svelte";
import "./styles.css";
import App from "./App.svelte";

// App renders the `#app` container (+ the off-to-the-side `#cut-gen` generator)
// as its roots, reproducing the original DOM under <body>.
const app = mount(App, { target: document.body });

export default app;
