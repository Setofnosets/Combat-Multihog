import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        // Android/Termux cannot spawn the default `forks` worker pool; threads
        // works on both CI Linux and mobile. Keep the suite runnable everywhere.
        pool: 'threads',
        setupFiles: ['./tests/setup.js'],
        include: ['tests/**/*.test.js'],
    },
});
