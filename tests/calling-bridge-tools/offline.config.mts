import base from "../../vitest.config.ts";
export default { ...base, test: { ...base.test, setupFiles: [
  ...(Array.isArray(base.test?.setupFiles) ? base.test.setupFiles : [base.test!.setupFiles!]),
  "tests/calling-bridge-tools/offline-assets.setup.ts",
] } };
