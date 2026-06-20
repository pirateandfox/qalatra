// Metro config for consuming @qalatra/shared from the monorepo as TypeScript
// source. mobile/ is intentionally NOT an npm workspace (so the desktop release
// pipeline's `npm ci` never pulls Expo/RN); instead Metro watches the workspace
// root and aliases the package to its source dir, transpiling its TS via
// babel-preset-expo.
const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '..')

const config = getDefaultConfig(projectRoot)

// Let Metro read files outside mobile/ (i.e. packages/shared).
config.watchFolders = [workspaceRoot]

// Resolve mobile's own deps first, then fall back to the workspace root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]

// Map the package name to its directory; Metro reads its package.json `main`
// (src/index.ts) and transpiles the TS source.
config.resolver.extraNodeModules = {
  '@qalatra/shared': path.resolve(workspaceRoot, 'packages/shared'),
}

module.exports = config
