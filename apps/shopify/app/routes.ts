import { flatRoutes } from "@remix-run/fs-routes";

// Remix's fs-router treats every file directly under app/routes/ as a route
// by default — including *.test.ts. Broke the production build (2026-09-03
// CI): route tests colocated as webhooks.X.test.ts pulled '../shopify.server'
// into the client bundle via the route graph, and Vite's commonjs resolver
// refused ("Server-only module referenced by client"). Test files were never
// meant to be routes.
export default flatRoutes({ ignoredRouteFiles: ["**/*.test.ts"] });
