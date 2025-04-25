# happy_refact MCP Server

This MCP server provides the `show_impacted_code` tool to predict the impact of changes to code elements (methods, functions, classes, etc.) when modifying any function or method signature. Instruct AI agent to invoke this tool to identify which files and elements will be impacted, helping you pull the relevant code into context for AI-driven modifications. The end-to-end tests are performed by an MCP Client that communicates with this server over stdio.

Example instruction: `BEFORE making any change to signature of a method/function ALWAYS use tool "show_impacted_code" to understand what other parts of the code that get impacted`

## Features

### Tools

- `show_impacted_code` - Identifies files potentially impacted by a change to a code element (method, function, class, etc.).
  - Takes the following parameters:
    - `repoPath` (required): The directory path of the repository.
    - `filePath` (required): The file path of the code element being modified, relative to the repository path.
    - `elementName` (required): The name of the code element (e.g., function name, method name, class name).
    - `elementType` (optional): The type of the code element (e.g., 'function', 'method', 'class').

## Installation/Use

To use this tool in IDEs like Claude, Cline, Cursor etc you add an MCP Server entry:

```json
"happy_refact": {
    "command": "cmd",
    "args": [
        "/c",
        "npx",
        "-y",
        "happy_refact"
    ]
}
```
Or 
```json
"happy_refact": {
    "command": "npx",
    "args": [ "-y happy_refact"]
}
```

## Development

Install dependencies, including Tree-sitter and language parsers:
```bash
npm install tree-sitter tree-sitter-javascript tree-sitter-typescript tree-sitter-python --save-dev --legacy-peer-deps
```
Then install other project dependencies:
```bash
npm install
```

Build the server:
```bash
npm run build
```

Start the server:
```bash
node build/index.js
```

For development with auto-rebuild:
```bash
npm run watch
```

### Running Tests

An end-to-end test client is provided to verify the `show_impacted_code` tool across sample projects. Ensure the server is built (see Build section) before running tests.

```bash
node build/test/run_mcp_test_client.js
```

This script runs the test client against the built MCP server (`build/index.js`) and reports PASS/FAIL for each test case across TypeScript, Python, and C# sample projects.

## License

This project is licensed under the MIT License. See the LICENSE notes in source
