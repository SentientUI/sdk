/**
 * This package's released build version, injected by tsup's `define` from
 * package.json (see tsup.config.ts) so the version inside a published bundle
 * can never drift from the version on npm. Mirrors the snippet's
 * `__SNIPPET_VERSION__`.
 *
 * Why the React SDK reports a version at all: unlike the snippet, it is a
 * build-time npm dependency, so it CANNOT self-update — a customer on an old
 * release stays there until they run an install. Telling them they're behind is
 * the only remedy available, and the dashboard can only tell them if the
 * running bundle says what it is.
 */
declare const __REACT_SDK_VERSION__: string;

export const version: string =
  typeof __REACT_SDK_VERSION__ !== 'undefined' ? __REACT_SDK_VERSION__ : '0.0.0-dev';

/**
 * The identity handed to core's session upsert, or undefined for a dev build.
 * The '0.0.0-dev' sentinel (unit tests, or any build without tsup's define)
 * passes the server's semver validation and would be persisted as the
 * project's SDK version, leaving the dashboard permanently claiming the
 * project is behind — the same trap the snippet documents as audit M12.
 */
export const SDK_IDENT: { name: string; version: string } | undefined =
  version !== '0.0.0-dev' ? { name: 'react', version } : undefined;
