const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");

module.exports = [
    {
        ignores: ["out/**", "node_modules/**"],
    },
    {
        files: ["src/**/*.ts"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            parser: tsParser,
        },
        plugins: {
            "@typescript-eslint": tsPlugin,
        },
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
        },
    },
];
