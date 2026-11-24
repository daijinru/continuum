import ts from "typescript-eslint";
export default [
  { ignores: ["**/dist/**", "**/generated/**", "**/schema/**"] },
  ...ts.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
];
