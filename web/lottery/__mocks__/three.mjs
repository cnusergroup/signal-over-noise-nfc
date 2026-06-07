// Feature: after-party-lottery — test stub for the `three` bare specifier.
//
// In the browser, lottery.html's <importmap> maps `three` to a pinned unpkg
// build. In the Node/jsdom test environment that importmap does not exist and
// `three` is not installed as a dependency, so Vite cannot resolve the bare
// `three` specifier reached through main.mjs's dynamic `import('three')` inside
// bootstrap().
//
// The property tests that import main.mjs (e.g. the Property 14 letter-formation
// precondition gate) only ever drive `createLotteryApp(...).run()`, which never
// calls bootstrap() and therefore never touches `three`. This stub exists purely
// so the dynamic import resolves at transform time; it is never executed.
//
// It intentionally provides only the tiny surface bootstrap() would reference
// (a no-op `Group`) so that, were it ever loaded, it would fail loudly via WebGL
// rather than silently — keeping the stub from masking real usage in non-test
// code paths.

export class Group {}

export default { Group };
