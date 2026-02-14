import nextConfig from "eslint-config-next";

const eslintConfig = [
  ...nextConfig,
  {
    ignores: ["src-tauri/", ".next/", "out/"],
  },
];

export default eslintConfig;
