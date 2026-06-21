// Metro config for consuming @qalatra/shared from the monorepo.
//
// The monorepo root is an npm workspace, so `@qalatra/shared` is already
// symlinked at <root>/node_modules/@qalatra/shared -> packages/shared. The
// canonical Expo-monorepo setup therefore resolves it for free:
//   - watchFolders includes the monorepo root, so Metro can read + hash the
//     shared package's TS source.
//   - nodeModulesPaths lists mobile/node_modules FIRST (so mobile's own React /
//     React Native win) then the root's (where the @qalatra/shared symlink
//     lives). mobile/ is otherwise self-contained and not itself a workspace.
const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const monorepoRoot = path.resolve(projectRoot, '..')

const config = getDefaultConfig(projectRoot)

config.watchFolders = [monorepoRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
]

module.exports = config
