// Node-only testing helpers. Kept out of the main `@sentientui/react/testing`
// entry so that entry stays browser-bundle-safe (Cypress/webpack) — `msw/node`
// pulls Node built-ins that break a browser bundle.
export { setupSentientServer } from './server.js';
