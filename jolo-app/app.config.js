// The JOLO owner app. Reuses the JOLO app's setup (React Native Firebase, dev
// builds, per-environment Firebase files) with its own bundle IDs, so it
// installs next to the customer app.
//
// APP_VARIANT picks the environment: "development" (default) or "production".
// Each bundle ID must be registered as an app in the Firebase project, and its
// GoogleService-Info.plist / google-services.json saved under firebase/<env>/.
const VARIANTS = {
  development: {
    name: "JOLO Owner (Dev)",
    bundleId: "com.zayguz.jolo.owner.dev",
    scheme: "joloowner-dev",
    firebaseDir: "./firebase/dev",
  },
  production: {
    name: "JOLO Owner",
    bundleId: "com.zayguz.jolo.owner",
    scheme: "joloowner",
    firebaseDir: "./firebase/prod",
  },
};

const variantName = process.env.APP_VARIANT ?? "development";
const variant = VARIANTS[variantName];
if (!variant) {
  throw new Error(
    `Unknown APP_VARIANT "${variantName}". Use one of: ${Object.keys(VARIANTS).join(", ")}.`,
  );
}

const googleServicesPlist =
  process.env.GOOGLE_SERVICES_PLIST ?? `${variant.firebaseDir}/GoogleService-Info.plist`;
const googleServicesJson =
  process.env.GOOGLE_SERVICES_JSON ?? `${variant.firebaseDir}/google-services.json`;

module.exports = {
  expo: {
    name: variant.name,
    slug: "jolo-owner",
    owner: "zayguz",
    scheme: variant.scheme,
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "light",
    newArchEnabled: true,
    experiments: {
      typedRoutes: true,
    },
    splash: {
      image: "./assets/splash-icon.png",
      resizeMode: "contain",
      backgroundColor: "#fcf9f8",
    },
    ios: {
      supportsTablet: false,
      bundleIdentifier: variant.bundleId,
      googleServicesFile: googleServicesPlist,
    },
    android: {
      package: variant.bundleId,
      googleServicesFile: googleServicesJson,
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#2c1b17",
      },
      edgeToEdgeEnabled: true,
    },
    plugins: [
      "expo-router",
      "@react-native-firebase/app",
      // Also registers the URL schemes iOS phone sign-in needs for its reCAPTCHA
      // fallback (the encoded GOOGLE_APP_ID, plus REVERSED_CLIENT_ID if the
      // plist has one) when silent push verification isn't available.
      "@react-native-firebase/auth",
      [
        "expo-build-properties",
        {
          // The Firebase iOS SDK needs dynamic frameworks (same as the JOLO app).
          ios: { useFrameworks: "dynamic" },
        },
      ],
    ],
    extra: {
      appVariant: variantName,
    },
  },
};
