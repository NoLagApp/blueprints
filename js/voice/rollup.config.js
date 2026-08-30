import { createRollupConfig } from "../rollup.shared.js";

export default createRollupConfig({ external: ["@nolag/js-sdk", "@nolag/agents"] });
