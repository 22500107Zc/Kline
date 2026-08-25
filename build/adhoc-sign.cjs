'use strict';

/**
 * Ad-hoc sign the macOS app so Apple Silicon will run it.
 *
 * This is not about Gatekeeper warnings. On arm64 macOS the kernel refuses to
 * execute a binary carrying no signature at all — the app does not start, and
 * the dialog says "Kline is damaged and can't be opened. You should move it to
 * the Trash." Right-click -> Open does not clear that, because it is not a
 * Gatekeeper prompt: it is the loader rejecting an unsigned arm64 executable.
 *
 * electron-builder signs only when it finds a real Developer ID certificate in
 * the keychain. With none present it logs the miss and returns without signing
 * (`macPackager.js`, the `identity == null` branch), so every build without an
 * Apple Developer account ships unsigned and dead on arrival on Apple Silicon.
 *
 * An ad-hoc signature — `codesign --sign -` — is free, needs no account, and
 * is exactly what the loader requires. It does not make the app *trusted*:
 * macOS still warns that it is from an unidentified developer, and the user
 * still clears that once with right-click -> Open. It only makes the app
 * *runnable*, which is the part that was missing.
 *
 * Intel builds tolerate being unsigned, so this changes nothing for them.
 */

const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = join(context.appOutDir, appName);
  if (!existsSync(appPath)) {
    throw new Error(`ad-hoc signing: ${appPath} is not there to sign`);
  }

  // --deep so the helper apps and framework inside the bundle are signed too;
  // an unsigned helper is just as fatal as an unsigned main executable.
  execFileSync('codesign', [
    '--force', '--deep', '--sign', '-', '--timestamp=none', appPath,
  ], { stdio: 'inherit' });

  // Signing that silently produced nothing is the failure this whole file
  // exists to prevent, so it is checked rather than assumed.
  execFileSync('codesign', ['--verify', '--deep', appPath], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed  ${appName} (${context.arch === 1 ? 'x64' : 'arm64'})`);
};
