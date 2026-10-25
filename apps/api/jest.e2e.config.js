/** liquor_app 全量 HTTP e2e。默认 jest 只扫 test/, 不会把本配置卷进去。 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/e2e'],
  testMatch: ['**/*.e2e.ts'],
  setupFiles: ['<rootDir>/e2e/setup.js'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', isolatedModules: true }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 120000,
};
