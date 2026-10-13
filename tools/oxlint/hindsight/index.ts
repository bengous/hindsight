import { eslintCompatPlugin } from "@oxlint/plugins";

import { constantCaseRule } from "./constant-case.ts";

const hindsightPlugin = eslintCompatPlugin({
  meta: { name: "hindsight" },
  rules: {
    "constant-case": constantCaseRule,
  },
});

export default hindsightPlugin;
