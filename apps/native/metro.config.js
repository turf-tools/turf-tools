const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);

// @maplibre/maplibre-react-native is native-only and throws at import time on
// web (NativeModules.MLRNModule is undefined). Swap it for a no-op stand-in so
// the web preview can run; the map itself only renders on a device.
const MAPLIBRE_WEB_STUB = path.join(__dirname, "src/lib/maplibre-web-stub.js");

// jotai ships a Vite-flavoured ESM build (`import.meta.env.MODE`) alongside its
// CJS one. Metro's package-exports resolution picks the ESM build for web,
// which the dev server then serves as a classic script, so the browser throws
// "Cannot use 'import.meta' outside a module" before the app renders. Resolve
// jotai to its CJS entry on web; React Native already gets it through the
// "react-native" export condition.
const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === "web" && moduleName === "@maplibre/maplibre-react-native") {
    return { type: "sourceFile", filePath: MAPLIBRE_WEB_STUB };
  }
  if (platform === "web" && (moduleName === "jotai" || moduleName.startsWith("jotai/"))) {
    return { type: "sourceFile", filePath: require.resolve(moduleName) };
  }
  return (resolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: "./src/global.css" });
