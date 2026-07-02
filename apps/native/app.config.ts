import type { ConfigContext, ExpoConfig } from "expo/config";

// App identity is variant-driven so the production app and the internal
// dev/preview builds are separate App Store records — they coexist on one
// device and dev builds never touch the production listing. APP_VARIANT is
// set per build profile in eas.json; local runs default to the dev identity.
const isProduction = process.env.APP_VARIANT === "production";

const name = isProduction ? "Field Tools" : "Field Tools (Dev)";
const identifier = isProduction ? "tools.field.native" : "tools.field.native.dev";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name,
  slug: config.slug ?? "field-tools-native",
  ios: { ...config.ios, bundleIdentifier: identifier },
  android: { ...config.android, package: identifier },
});
