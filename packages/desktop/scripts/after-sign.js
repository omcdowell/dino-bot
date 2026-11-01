const path = require("node:path");

const { smokePackagedDesktopApp } = require("../e2e/packaged-app-smoke.js");

exports.default = async function afterSign(context) {
  if (process.env.PASEO_DESKTOP_SMOKE !== "1") {
    return;
  }

  if (context.electronPlatformName !== "darwin") {
    return;
  }

  process.env.PASEO_DESKTOP_EXECUTABLE_NAME = context.packager?.executableName ?? "Paseo";
  await smokePackagedDesktopApp({
    appPath: path.join(
      context.appOutDir,
      `${context.packager?.appInfo?.productFilename ?? "Paseo"}.app`,
    ),
  });
};
