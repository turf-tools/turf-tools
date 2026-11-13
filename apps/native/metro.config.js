const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);

// jotai ships a Vite-flavoured ESM build (`import.meta.env.MODE`) alongside its
// CJS one. Metro's package-exports resolution picks the ESM build for web,
// which the dev server then serves as a classic script, so the browser throws
// "Cannot use 'import.meta' outside a module" before the app renders. Resolve
// jotai to its CJS entry on web; React Native already gets it through the
// "react-native" export condition.
const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === "web" && (moduleName === "jotai" || moduleName.startsWith("jotai/"))) {
    return { type: "sourceFile", filePath: require.resolve(moduleName) };
  }
  return (resolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: "./src/global.css" });
