import type { ConfigContext, ExpoConfig } from "expo/config";

// App identity is variant-driven so the production app and the internal
// dev/preview builds are separate App Store records — they coexist on one
// device and dev builds never touch the production listing. APP_VARIANT is
// set per build profile in eas.json; local runs default to the dev identity.
const isProduction = process.env.APP_VARIANT === "production";

const name = isProduction ? "Turf Tools" : "Turf Tools (Dev)";
const identifier = isProduction ? "tools.turf.native" : "tools.turf.native.dev";

// Android gets its own identifier: applicationId segments must be valid Java
// identifiers, and "native" is a Java keyword (EAS manifest validation
// rejects it). Android package and iOS bundle id never need to match.
const androidIdentifier = isProduction ? "tools.turf.app" : "tools.turf.app.dev";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name,
  slug: config.slug ?? "turf-tools-native",
  ios: { ...config.ios, bundleIdentifier: identifier },
  android: { ...config.android, package: androidIdentifier },
});
