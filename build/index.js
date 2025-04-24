#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode, } from "@modelcontextprotocol/sdk/types.js";
import * as fs from 'fs/promises';
import * as path from 'path';
import Parser from 'tree-sitter';
// Import language parsers here as needed, e.g.:
import TreeSitterJavaScript from 'tree-sitter-javascript';
import TreeSitterTypescript from 'tree-sitter-typescript';
import TreeSitterPython from 'tree-sitter-python';
import TreeSitterCSharp from 'tree-sitter-c-sharp'; // Import C# parser
import ignore from 'ignore';
// Define the input schema for the show_impacted_code tool
const showImpactedCodeInputSchema = {
    type: "object",
    properties: {
        repoPath: {
            type: "string",
            description: "The directory path of the repository.",
        },
        filePath: {
            type: "string",
            description: "The file path of the code element being modified, relative to the repository path.",
        },
        elementName: {
            type: "string",
            description: "The name of the code element (e.g., function name, method name, class name).",
        },
        elementType: {
            type: "string",
            description: "Optional: The type of the code element (e.g., 'function', 'method', 'class').",
            enum: ["function", "method", "class"], // Example types, can be expanded
            required: false,
        },
    },
    required: ["repoPath", "filePath", "elementName"],
};
// Create an MCP server with capabilities for tools
const server = new Server({
    name: "happy_refact",
    version: "0.1.0",
}, {
    capabilities: {
        tools: {},
    },
});
// Initialize Tree-sitter parser
const parser = new Parser();
// Load language parsers here, e.g.:
// Removed Parser.init()
// Explicitly cast imported language objects to Parser.Language
const javascriptLanguage = TreeSitterJavaScript;
const typescriptLanguage = TreeSitterTypescript.typescript; // Accessing 'typescript' property and casting
const pythonLanguage = TreeSitterPython;
// Reverted access to C# language object
const csharpLanguage = TreeSitterCSharp;
// Function to recursively get files in a directory, respecting .gitignore and always ignoring .git and .env
async function getFiles(dir, baseDir, ig) {
    // Add always ignored patterns at the beginning
    if (dir === baseDir) { // Only add these rules once at the root
        ig.add('.git');
        ig.add('.env');
        ig.add('.vs'); // Explicitly ignore .vs folder
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];
    // Check for .gitignore in the current directory
    const gitignorePath = path.join(dir, '.gitignore');
    try {
        const gitignoreContent = await fs.readFile(gitignorePath, 'utf8');
        // Add new rules to the existing ignorer instance
        ig.add(gitignoreContent);
    }
    catch (error) {
        // Ignore if .gitignore doesn't exist
        if (error.code !== 'ENOENT') {
            console.error(`Error reading .gitignore in ${dir}:`, error);
        }
    }
    for (const entry of entries) {
        const entryPath = path.resolve(dir, entry.name);
        const relativeEntryPath = path.relative(baseDir, entryPath);
        // Check if the entry is ignored
        if (ig.ignores(relativeEntryPath)) {
            continue;
        }
        if (entry.isDirectory()) {
            // Recursively get files from subdirectory, passing the same ignorer instance
            const subdirectoryFiles = await getFiles(entryPath, baseDir, ig);
            files.push(...subdirectoryFiles);
        }
        else {
            // Add the file if it's not ignored
            files.push(entryPath);
        }
    }
    return files;
}
// Function to get code definitions using Tree-sitter
async function getCodeDefinitions(filePath) {
    const fileContent = await fs.readFile(filePath, 'utf8');
    const definitions = [];
    let language;
    if (filePath.endsWith('.ts')) {
        language = typescriptLanguage;
    }
    else if (filePath.endsWith('.js')) {
        language = javascriptLanguage;
    }
    else if (filePath.endsWith('.py')) {
        language = pythonLanguage;
    }
    else if (filePath.endsWith('.cs')) { // Handle C# files
        language = csharpLanguage;
    }
    else {
        return []; // No supported language parser for this file type
    }
    if (!language) {
        console.error(`No language found for file: ${filePath}`); // Added logging
        return []; // Should not happen with current logic, but good practice
    }
    parser.setLanguage(language);
    console.error(`[Debug] [build] findReferences: language set for ${filePath}`);
    const tree = parser.parse(fileContent);
    let query;
    if (language === javascriptLanguage || language === typescriptLanguage) {
        query = new Parser.Query(language, `
        (function_declaration name: (identifier) @name)
        (method_definition name: (property_identifier) @name)
        (class_declaration name: (identifier) @name)
      `);
    }
    else if (language === pythonLanguage) {
        query = new Parser.Query(language, `
         (function_definition name: (identifier) @name)
         (class_definition name: (identifier) @name)
       `);
    }
    else if (language === csharpLanguage) {
        query = new Parser.Query(language, `
        (class_declaration name: (identifier) @name)
        (struct_declaration name: (identifier) @name)
        (interface_declaration name: (identifier) @name)
        (enum_declaration name: (identifier) @name)
        (method_declaration name: (identifier) @name)
        (property_declaration (identifier) @name)
      `);
    }
    else {
        console.error(`No query defined for language for file: ${filePath}`); // Added logging
        return []; // No query defined for this language
    }
    if (!query) {
        console.error(`No query object obtained for file: ${filePath}`); // Added logging
        return []; // No query object obtained
    }
    let matches;
    try {
        matches = query.matches(tree.rootNode);
    } catch (err) {
        console.error(`[Debug] [build] findReferences: Query error for ${filePath}:`, err);
        const regex = new RegExp(`\\b${escapedElementName}\\b`);
        fileContent.split(/\r?\n/).forEach((line, index) => {
            if (regex.test(line)) referencingElements.push(`Line ${index + 1}: ${line.trim()}`);
        });
        return [...new Set(referencingElements)];
    }
    for (const match of matches) {
        for (const capture of match.captures) {
            definitions.push(`  - ${capture.node.text}`);
        }
    }
    return definitions;
}
// Helper function to escape special characters for Tree-sitter queries
function escapeQueryString(str) {
    return str.replace(/[\\"]/g, '\\$&');
}
// Function to find references to a code element using Tree-sitter or simple text search for C# and Python
async function findReferences(filePath, elementName, elementType) {
    const fileContent = await fs.readFile(filePath, 'utf8');
    const referencingElements = [];
    // Fallback using line-based regex search for C#, Python, and TypeScript files due to Tree-sitter query issues
    if (filePath.endsWith('.cs') || filePath.endsWith('.py') || filePath.endsWith('.ts')) {
        const lines = fileContent.split(/\r?\n/);
        const regex = new RegExp(`\\b${elementName}\\b`, 'i');
        lines.forEach((lineContent, index) => {
            if (regex.test(lineContent)) {
                referencingElements.push(`Line ${index + 1}: ${lineContent.trim()}`);
            }
        });
        return referencingElements;
    }
    let language;
    if (filePath.endsWith('.ts')) {
        language = typescriptLanguage;
    }
    else if (filePath.endsWith('.js')) {
        language = javascriptLanguage;
    }
    else {
        return []; // No supported language parser for this file type
    }
    if (!language) {
        console.error(`No language found for file: ${filePath}`);
        return [];
    }
    parser.setLanguage(language);
    const tree = parser.parse(fileContent);
    const escapedElementName = escapeQueryString(elementName);
    console.error(`[Debug] [build] findReferences: escapedElementName=${escapedElementName}`);
    let query;
    // Define queries to find references based on language and element type
    if (language === javascriptLanguage || language === typescriptLanguage) {
        if (elementType === 'function' || elementType === 'method') {
            // Query for function/method calls and their parent function/method/class
            const queryString = `(call_expression function: (identifier) @call)
(new_expression constructor: (identifier) @call)
(function_declaration name: (identifier) @definition)
(method_definition name: (property_identifier) @definition)
(class_declaration name: (identifier) @definition)`;
            console.error(`[Debug] [build] findReferences: Query string for ${filePath}:\n${queryString}`);
            query = new Parser.Query(language, queryString);
        }
        else if (elementType === 'class') {
            // Query for class instantiation or type references and their parent function/method/class
            query = new Parser.Query(language, `
             (new_expression constructor: (identifier) @call)
             (type_identifier) @call ; For type annotations

             (function_declaration name: (identifier) @definition)
             (method_definition name: (property_identifier) @definition)
             (class_declaration name: (identifier) @definition)
           `);
        }
        else {
            // Generic identifier search and their parent function/method/class
            query = new Parser.Query(language, `
            (identifier) @call
            (property_identifier) @call

            (function_declaration name: (identifier) @definition)
            (method_definition name: (property_identifier) @definition)
            (class_declaration name: (identifier) @definition)
          `);
        }
    }
    else {
        console.error(`No query defined for language for file: ${filePath}`);
        return [];
    }
    if (!query) {
        console.error(`No query object obtained for file: ${filePath}`);
        return [];
    }
    const matches = query.matches(tree.rootNode);
    for (const match of matches) {
        let callNode;
        let definitionNode;
        for (const capture of match.captures) {
            if (capture.name === 'call') {
                callNode = capture.node;
            }
            else if (capture.name === 'definition') {
                definitionNode = capture.node;
            }
        }
        if (callNode) {
            // Find the nearest parent definition (function, method, class)
            let parent = callNode.parent;
            while (parent) {
                if (parent.type === 'function_declaration' || parent.type === 'method_definition' || parent.type === 'class_declaration' // TS/JS
                ) {
                    // Find the name node within the definition
                    const nameNode = parent.namedChildren.find(n => n.type === 'identifier' || n.type === 'property_identifier');
                    if (nameNode) {
                        referencingElements.push(nameNode.text);
                        break; // Found the parent definition, move to the next match
                    }
                }
                parent = parent.parent;
            }
            // If no parent definition found, maybe it's a top-level reference or within a block
            if (!parent) {
                referencingElements.push("Top-level or unknown scope");
            }
        }
    }
    // Return the list of names of elements that reference the target
    return [...new Set(referencingElements)]; // Return unique names
}
// Handler that lists available tools.
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "show_impacted_code",
                description: "Identifies files potentially impacted by a change to a code element (method, function, class, etc.) and lists the referencing elements.",
                inputSchema: showImpactedCodeInputSchema,
            },
        ],
    };
});
// Handler for the show_impacted_code tool.
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "show_impacted_code") {
        const { repoPath, filePath, elementName, elementType } = request.params.arguments;
        if (!repoPath || !filePath || !elementName) {
            throw new McpError(ErrorCode.InvalidParams, "The 'repoPath', 'filePath', and 'elementName' arguments are required.");
        }
        try {
            const ignorer = ignore();
            ignorer.add('.git');
            ignorer.add('.env');
            ignorer.add('.vs');
            ignorer.add('build');
            ignorer.add('node_modules');
            ignorer.add('*.d.ts');
            ignorer.add('src/**');
            ignorer.add('test/**');
            const allFiles = await getFiles(repoPath, repoPath, ignorer);
            const impactedFiles = [];
            for (const file of allFiles) {
                // Avoid checking the file itself for references to its own definition
                if (path.resolve(repoPath, filePath) === file) {
                    continue;
                }
                // Only check relevant code files
                if (file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.py') || file.endsWith('.cs')) {
                    const referencingElements = await findReferences(file, elementName, elementType);
                    if (referencingElements.length > 0) {
                        impactedFiles.push({ file: path.relative(repoPath, file), referencingElements });
                    }
                }
            }
            let result = "";
            if (impactedFiles.length > 0) {
                impactedFiles.forEach(impact => {
                    result += `Impacted file: ${impact.file}\n`;
                    impact.referencingElements.forEach(ref => {
                        result += `  - ${ref}\n`;
                    });
                });
            }
            else {
                result = `No files found to be impacted by changes to "${elementName}".`;
            }
            return {
                content: [
                    {
                        type: "text",
                        text: result,
                    },
                ],
            };
        }
        catch (error) {
            console.error("Error in show_impacted_code tool:", error);
            throw new McpError(ErrorCode.InternalError, `Failed to show impacted code: ${error.message}`);
        }
    }
    else {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Promise Rejection:', reason, promise);
});
// Start the server using stdio transport.
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("happy_refact MCP server running on stdio");
}
main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
});
