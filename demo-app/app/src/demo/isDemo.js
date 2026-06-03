// Single source of truth for whether the marketing-demo commerce layer is active.
//
// Turned on by the `demo` Vite mode (.env.demo → VITE_DEMO_MODE=true). Per-client
// PRODUCT builds run the default mode and leave this unset, so every guarded
// commerce/info-button surface tree-shakes out — the same shell-build codebase
// ships both the real product and this sales demo. Always gate demo-only UI with
// `IS_DEMO` (or render nothing) so it can never leak into a client deployment.
export const IS_DEMO = import.meta.env.VITE_DEMO_MODE === 'true';
