/**
 * @nolag/signal
 * React Native entry point.
 *
 * Identical to the browser entry: this SDK is transport-agnostic and attaches
 * to an injected NoLag client, so it has no platform-specific code of its own.
 * The entry exists purely so Metro has a `react-native` condition to resolve.
 * Metro matches "react-native" then "import"/"require" and does not understand
 * the "browser" condition, so without this it resolves the Node build of this
 * package and, through it, the Node build of @nolag/js-sdk (which imports
 * `ws` and fails to bundle).
 */

export * from "./browser";
