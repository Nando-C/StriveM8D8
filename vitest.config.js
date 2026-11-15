import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        include: ['test/**/*.test.js'],
        // Starts one in-memory MongoDB for the whole run; each test file uses its own database in it.
        globalSetup: './test/global-setup.js',
        testTimeout: 10000,
        // The first run downloads a MongoDB binary, which can take a while.
        hookTimeout: 120000,
        // The server logs every connection; only show output for failing tests.
        silent: 'passed-only',
    },
})
