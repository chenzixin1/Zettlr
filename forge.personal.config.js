// Personal builds keep a separate app identity and never use upstream signing.
process.env.ZETTLR_DISABLE_UPDATE_CHECK = '1'

const path = require('node:path')
const { version } = require('./package.json')
const productName = 'Zettlr Personal'

module.exports = (config) => {
  config.packagerConfig = {
    ...config.packagerConfig,
    name: productName,
    executableName: productName,
    appBundleId: 'com.chenzixin.zettlr.personal',
    appVersion: version,
    // Do not register this test build as a document or URL handler.
    extendInfo: { CFBundleDocumentTypes: [], CFBundleURLTypes: [] },
    osxSign: {
      identity: '-',
      identityValidation: false,
      gatekeeperAssess: false,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      // Current osx-sign applies runtime and entitlements per file. A personal
      // ad-hoc signature has no Team ID for hardened library validation.
      optionsForFile: () => ({
        hardenedRuntime: false,
        entitlements: path.join(__dirname, 'scripts/assets/entitlements.plist'),
        timestamp: 'none'
      })
    },
    osxNotarize: false
  }

  return config
}
