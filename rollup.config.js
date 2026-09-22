
const pkg = require('./package.json');
const typescript = require('@rollup/plugin-typescript');

/*
 * Two entry points, one build.
 *
 * `index` is the library as it always was; `native` adds the React Native
 * adapter. They are built together rather than as two independent bundles so
 * that the code they share — the protocol drivers, the encrypters, the
 * connection — is emitted once into a common chunk. Two separate bundles would
 * each carry their own copy, and an app importing both would end up with two
 * module states for one stateful driver.
 */
const input = {
    index: 'src/index.ts',
    native: 'src/native/index.ts'
};

module.exports = {
    input,
    external: Object.keys(pkg.dependencies),
    output: [
        {
            dir: 'dist/cjs',
            format: 'cjs',
            entryFileNames: '[name].cjs',
            chunkFileNames: '[name]-[hash].cjs'
        },
        {
            dir: 'dist/esm',
            format: 'es',
            entryFileNames: '[name].mjs',
            chunkFileNames: '[name]-[hash].mjs'
        }
    ],
    plugins: [typescript()]
};
