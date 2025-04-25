#!/usr/bin/env node
// MIT License
//
// Copyright (c) 2024 Fredrik Claesson
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpError, CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import Parser from 'tree-sitter';
import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import { fileURLToPath } from 'node:url';


const SERVER_NAME = 'happy_refact';
const SERVER_VERSION = '0.2.0';
const TOOL_NAME = 'show_impacted_code';
// Refined ignore patterns to be root-relative
const IGNORE_PATTERNS = ['/.git', '/.env', '/.vs', '/build', '/node_modules', '*.d.ts', '/src/**', '/test/**'];

// --- Caching ---
// Cache to store directory listing results
// Key: Absolute directory path
// Value: Dirents and modification time
const fileListCache = new Map<string, { dirents: fs.Dirent[], mtimeMs: number }>();
// --- End Caching ---

interface LanguageConfig {
    parser: any;
    referenceQuery: string;
    definitionQuery?: string;
}

interface Reference {
    filePath: string;
    line: number;
    column: number;
    text: string; // Keep original node text for potential signature matching
    lineText: string; // Add the full line text
}

const parser = new Parser();
let languageConfigs: Record<string, LanguageConfig>;
let currentParserLanguage: any = null; // Cache for the currently set language
const compiledQueryCache = new Map<string, Parser.Query>(); // Cache for compiled queries
// Added referenceCache in the previous step, ensuring it's here.
const referenceCache = new Map<string, { references: Reference[], mtimeMs: number }>(); // Cache for findReferencesInFile results




async function getGitignorePatterns(repoPath: string): Promise<string[]> {
    const gitignorePath = path.join(repoPath, '.gitignore');
    try {
        const content = await fsPromises.readFile(gitignorePath, 'utf-8');
        return content.split(/\r?\n/).filter(line => line.trim() !== '' && !line.startsWith('#'));
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            return [];
        }
        console.error(`Error reading .gitignore at ${gitignorePath}:`, error);
        return [];
    }
}

// --- Modified listFilesRecursively with Caching ---
async function* listFilesRecursively(dir: string, repoPath: string, ig: ignore.Ignore): AsyncGenerator<string> {
    let dirents: fs.Dirent[];
    try {
        const stats = await fsPromises.stat(dir);
        if (!stats.isDirectory()) {
            return; // Should not happen if called correctly, but good practice
        }

        const cachedEntry = fileListCache.get(dir);

        if (cachedEntry && cachedEntry.mtimeMs === stats.mtimeMs) {
            // Cache hit and directory hasn't changed
            dirents = cachedEntry.dirents;
            // console.error(`Cache hit for: ${dir}`); // Optional debug log
        } else {
            // Cache miss or directory changed
            // console.error(`Cache miss/stale for: ${dir}`); // Optional debug log
            dirents = await fsPromises.readdir(dir, { withFileTypes: true });
            fileListCache.set(dir, { dirents, mtimeMs: stats.mtimeMs });
        }
    } catch (error: any) {
        // Handle errors during stat or readdir (e.g., permission denied)
        if (error.code !== 'ENOENT') { // Ignore if directory simply doesn't exist
             console.error(`Error accessing directory ${dir}:`, error);
        }
        return; // Stop iteration for this path if error occurs
    }


    for (const dirent of dirents) {
        const fullPath = path.join(dir, dirent.name);
        // Calculate path relative to the repository root
        const relativePath = path.relative(repoPath, fullPath);

        if (ig.ignores(relativePath)) {
            // console.error(`Ignoring: ${relativePath}`); // Optional debug log
            continue;
        }

        if (dirent.isDirectory()) {
            // Pass repoPath down recursively
            yield* listFilesRecursively(fullPath, repoPath, ig);
        } else {
            yield fullPath;
        }
    }
}
// --- End Modified listFilesRecursively ---


interface SignatureInfo {
    name: string;
    parameterTypes: string[];
}

function extractSignatureInfo(node: Parser.SyntaxNode, langConfig: LanguageConfig): SignatureInfo | null {
    if (!langConfig.definitionQuery) {
        return null;
    }

    const parserName = (langConfig.parser as any)?.language?.name;


    if (parserName === 'c-sharp') {
        const methodNameNode = node.childForFieldName('name');
        const parameterListNode = node.childForFieldName('parameter_list');
        if (methodNameNode && parameterListNode) {
            const parameterTypes: string[] = [];
            for (const paramNode of parameterListNode.namedChildren) {
                if (paramNode.type === 'parameter') {
                    const typeNode = paramNode.childForFieldName('type');
                    if (typeNode) {
                        parameterTypes.push(typeNode.text);
                    } else {
                        parameterTypes.push('unknown');
                    }
                }
            }
            return { name: methodNameNode.text, parameterTypes };
        }
    } else if (parserName === 'typescript') {
        const parametersNode = node.childForFieldName('parameters');
        const methodNameNode = node.childForFieldName('name');
        if (methodNameNode && parametersNode) {
            const parameterTypes: string[] = [];
            for (const paramNode of parametersNode.namedChildren) {
                if (paramNode.type === 'required_parameter' || paramNode.type === 'optional_parameter') {
                    const typeNode = paramNode.childForFieldName('type');
                    if (typeNode) {
                        parameterTypes.push(typeNode.text);
                    } else {
                        parameterTypes.push('any');
                    }
                } else if (paramNode.type === 'rest_parameter') {
                     const typeNode = paramNode.childForFieldName('type');
                     if (typeNode) {
                         parameterTypes.push(`...${typeNode.text}`); // Indicate rest parameter
                     } else {
                         parameterTypes.push('...any');
                     }
                 }
             }
              return { name: methodNameNode.text, parameterTypes };
         }
     }
     // TODO: Implement extraction for other languages
 
     return null;
 }


function signaturesMatch(definitionSignature: SignatureInfo, referenceNode: Parser.SyntaxNode, langConfig: LanguageConfig): boolean {

    const parserName = (langConfig.parser as any)?.language?.name;

    if (parserName === 'c-sharp') {
        if (referenceNode.type === 'invocation_expression') {
            const invokedMethodNameNode = referenceNode.childForFieldName('function')?.childForFieldName('name');
            const argumentListNode = referenceNode.childForFieldName('arguments');

            if (invokedMethodNameNode && argumentListNode) {
                if (definitionSignature.name !== invokedMethodNameNode.text) {
                    return false;
                }

                const argumentNodes = argumentListNode.namedChildren.filter(n => n.type !== ',' && n.type !== '(' && n.type !== ')');
                if (definitionSignature.parameterTypes.length !== argumentNodes.length) {
                    return false;
                }

                for (let i = 0; i < argumentNodes.length; i++) {
                    const argumentNode = argumentNodes[i];
                    const definitionParameterType = definitionSignature.parameterTypes[i];

                    let argumentTypeApproximation = 'unknown';
                    if (argumentNode.type === 'string_literal') {
                        argumentTypeApproximation = 'string';
                    } else if (argumentNode.type === 'number_literal') {
                        argumentTypeApproximation = 'int';
                    } else if (argumentNode.type === 'boolean_literal') {
                        argumentTypeApproximation = 'bool';
                    } else if (argumentNode.type === 'object_creation_expression') {
                         const typeNode = argumentNode.childForFieldName('type');
                         if (typeNode) {
                             argumentTypeApproximation = typeNode.text;
                         }
                    } else if (argumentNode.type === 'identifier') {
                        argumentTypeApproximation = 'identifier';
                    }
                    // TODO: Add more cases for other C# expression types

                    if (definitionParameterType.toLowerCase() !== argumentTypeApproximation.toLowerCase() && argumentTypeApproximation !== 'unknown' && argumentTypeApproximation !== 'identifier') {
                         // return false; // Uncomment for strict type checking based on approximation
                    }
                }

                return true;
            }
        }
    } else if (parserName === 'typescript') {
        if (referenceNode.type === 'call_expression') {
            const invokedFunctionNameNode = referenceNode.childForFieldName('function')?.childForFieldName('name');
             const argumentListNode = referenceNode.childForFieldName('arguments');

            if (invokedFunctionNameNode && argumentListNode) {
                if (definitionSignature.name !== invokedFunctionNameNode.text) {
                    return false;
                }

                const argumentNodes = argumentListNode.namedChildren.filter(n => n.type !== ',' && n.type !== '(' && n.type !== ')');
                 if (definitionSignature.parameterTypes.length !== argumentNodes.length) {
                    return false;
                }

                 for (let i = 0; i < argumentNodes.length; i++) {
                    const argumentNode = argumentNodes[i];
                    const definitionParameterType = definitionSignature.parameterTypes[i];

                    let argumentTypeApproximation = 'unknown';
                    if (argumentNode.type === 'string_literal') {
                        argumentTypeApproximation = 'string';
                    } else if (argumentNode.type === 'number') {
                        argumentTypeApproximation = 'number';
                    } else if (argumentNode.type === 'boolean') {
                        argumentTypeApproximation = 'boolean';
                    } else if (argumentNode.type === 'object') {
                         argumentTypeApproximation = 'object';
                    } else if (argumentNode.type === 'array') {
                         argumentTypeApproximation = 'array';
                    } else if (argumentNode.type === 'new_expression') {
                         const typeNode = argumentNode.childForFieldName('constructor');
                         if (typeNode) {
                             argumentTypeApproximation = typeNode.text;
                         }
                    } else if (argumentNode.type === 'identifier') {
                        argumentTypeApproximation = 'identifier';
                    }
                    // TODO: Add more cases for other TypeScript expression types

                    if (definitionParameterType !== argumentTypeApproximation && argumentTypeApproximation !== 'unknown' && argumentTypeApproximation !== 'identifier') {
                         // return false; // Uncomment for strict type checking based on approximation
                    }
                }

                return true;
            }
        }
    }

    return true;
}

async function findReferencesInFile(
    filePath: string,
    elementName: string,
    langConfig: LanguageConfig,
    definitionSignature: SignatureInfo | null
): Promise<Reference[]> {
    const references: Reference[] = [];
    let lines: string[] = [];
    let fileMtimeMs: number | undefined; // Declared here for wider scope

    // --- Result Caching Check ---
    try {
        const stats = await fsPromises.stat(filePath);
        fileMtimeMs = stats.mtimeMs; // Assign mtime here if stat succeeds
        const cachedEntry = referenceCache.get(filePath);

        if (cachedEntry && cachedEntry.mtimeMs === fileMtimeMs) {
            // Cache hit and file hasn't changed
            // console.error(`Reference cache hit for: ${filePath}`); // Optional debug log
            if (definitionSignature) {
                 // console.error(`Bypassing reference cache due to signature check for: ${filePath}`);
            } else {
                 return cachedEntry.references; // Return cached result directly if no signature
            }
        }
    } catch (statError: any) {
        // Ignore stat errors (e.g., file not found), proceed without mtime or cache hit
        if (statError.code !== 'ENOENT') {
            console.error(`Error stating file for cache check ${filePath}:`, statError);
        }
    }
    // --- End Result Caching Check ---

    try {
        // If fileMtimeMs wasn't set during cache check (e.g., stat error), try again or proceed without it
        if (fileMtimeMs === undefined) {
            try {
                 const stats = await fsPromises.stat(filePath);
                 fileMtimeMs = stats.mtimeMs;
            } catch { /* Ignore stat error here, proceed without mtime for caching */ }
        }

        const fileContent = await fsPromises.readFile(filePath, 'utf-8');
        lines = fileContent.split(/\r?\n/); // Split lines once

        // Optimization: Only set language if it changed
        if (currentParserLanguage !== langConfig.parser) {
            parser.setLanguage(langConfig.parser);
            currentParserLanguage = langConfig.parser; // Update cache
        }
        const tree = parser.parse(fileContent);

        const queryString = langConfig.referenceQuery;
        // Use language extension as cache key (assuming one ref query per lang)
        const queryCacheKey = path.extname(filePath).toLowerCase();

        let allCaptures = [];
        try {
            let query: Parser.Query;
            // Optimization: Use cached query if available
            if (compiledQueryCache.has(queryCacheKey)) {
                query = compiledQueryCache.get(queryCacheKey)!;
            } else {
                // Compile query if not cached
                query = new Parser.Query(langConfig.parser, queryString);
                compiledQueryCache.set(queryCacheKey, query); // Cache it
            }

            // Execute the query (cached or new)
            allCaptures = query.captures(tree.rootNode);

        } catch (error) { // Handles errors from new Parser.Query() or query.captures()
            console.error(`Query error (compilation or execution) for ${filePath}:`, error);
            // Fallback logic remains the same...
            const regex = new RegExp(`\\b${elementName}\\b`, 'i');
            lines.forEach((lineContent, index) => {
                let match;
                while ((match = regex.exec(lineContent)) !== null) {
                    references.push({
                        filePath: filePath,
                        line: index + 1,
                        column: match.index + 1,
                        text: elementName,
                        lineText: lineContent.trim(),
                    });
                }
            });
            // --- Cache Fallback Result ---
            // Cache fallback results only if no signature was involved and mtime is known.
            if (definitionSignature === null && fileMtimeMs !== undefined) {
                referenceCache.set(filePath, { references: [...references], mtimeMs: fileMtimeMs });
            }
            // --- End Cache Fallback Result ---
            return references;
        }


        const matches = allCaptures.filter(capture => capture.name === 'ref' && capture.node.text === elementName);

        for (const { node } of matches) {
            // Reverted: No complex contextNode logic, use the direct node
            const startPosition = node.startPosition;
            const lineIndex = startPosition.row;
            const lineText = lines[lineIndex]?.trim() || node.text; // Get line text, fallback to node text

            if (definitionSignature === null || signaturesMatch(definitionSignature, node, langConfig)) {
                 references.push({
                    filePath: filePath,
                    line: startPosition.row + 1,
                    column: startPosition.column + 1,
                    text: node.text,
                    lineText: lineText
                });
            }
        }
    } catch (error: any) {
        console.error(`Error in findReferencesInFile for ${filePath}:`, error);
        console.error(`Element Name: ${elementName}`);
        console.error(`Query String Used: "${langConfig?.referenceQuery}"`);
        console.error(error);
        // Fallback if primary processing fails after successful query execution/compilation attempt
         if (references.length === 0 && lines.length > 0) {
             const regex = new RegExp(`\\b${elementName}\\b`, 'i');
             lines.forEach((lineContent, index) => {
                 let match;
                 while ((match = regex.exec(lineContent)) !== null) {
                     references.push({
                         filePath: filePath,
                         line: index + 1,
                         column: match.index + 1,
                         text: elementName,
                         lineText: lineContent.trim(),
                     });
                 }
             });
         }
    }
    return references;
}

async function findReferencesFallback(filePath: string, elementName: string): Promise<Reference[]> {
    const references: Reference[] = [];
    try {
        const fileContent = await fsPromises.readFile(filePath, 'utf-8');
        const lines = fileContent.split(/\r?\n/);
        const regex = new RegExp(`\\b${elementName}\\b`, 'i');

        lines.forEach((lineContent, index) => {
            let match;
            while ((match = regex.exec(lineContent)) !== null) {
                references.push({
                    filePath: filePath,
                    line: index + 1,
                    column: match.index + 1,
                    text: elementName, // Use element name as fallback text
                    lineText: lineContent.trim() // Add lineText here
                });
            }
        });
    } catch (error) {
        console.error(`Error performing fallback search in file ${filePath}:`, error);
    }
    return references;
}



async function _findImpactedCode(
    args: { repoPath: string; filePath: string; elementName: string; elementType?: string },
    initializedLanguageConfigs: Record<string, LanguageConfig>
): Promise<string[]> {
    const { repoPath, filePath: definitionFilePathRelative, elementName } = args;
    const definitionFilePathAbsolute = path.resolve(repoPath, definitionFilePathRelative);

    const ig = ignore().add(IGNORE_PATTERNS);
    const gitignoreRules = await getGitignorePatterns(repoPath);
    ig.add(gitignoreRules);

    const allImpactedReferences: Reference[] = [];

    let definitionSignature: SignatureInfo | null = null;
    const definitionFileExt = path.extname(definitionFilePathAbsolute).toLowerCase();
    const definitionLangConfig = initializedLanguageConfigs[definitionFileExt];

    if (definitionLangConfig && definitionLangConfig.definitionQuery) {
        try {
            const definitionFileContent = await fsPromises.readFile(definitionFilePathAbsolute, 'utf-8');
            parser.setLanguage(definitionLangConfig.parser);
            const definitionTree = parser.parse(definitionFileContent);
            const definitionQuery = new Parser.Query(definitionLangConfig.parser, definitionLangConfig.definitionQuery!);
            const allDefinitionCaptures = definitionQuery.captures(definitionTree.rootNode);


            const definitionMatches = allDefinitionCaptures.filter(capture => capture.name === 'name' && capture.node.text === elementName);

            if (definitionMatches.length > 0) {
                definitionSignature = extractSignatureInfo(definitionMatches[0].node, definitionLangConfig);
            }
        } catch (error) {
            console.error(`Error finding or parsing definition file ${definitionFilePathAbsolute}:`, error);
        }
    }


    for await (const file of listFilesRecursively(repoPath, repoPath, ig)) {
        if (path.resolve(file) === definitionFilePathAbsolute) {
            continue;
        }

        const ext = path.extname(file).toLowerCase();
        const langConfig = initializedLanguageConfigs[ext];

        let fileReferences: Reference[] = [];
        if (langConfig) {
             console.error(`Processing ${file} for ${elementName} using config for ${ext}`);
            fileReferences = await findReferencesInFile(file, elementName, langConfig, definitionSignature);
        } else {
             // console.error(`Skipping ${file} (no language config for ${ext})`);
        }
        allImpactedReferences.push(...fileReferences);
    }

    const output: string[] = [];
    const referencesByFile: Record<string, Reference[]> = {};

    for (const ref of allImpactedReferences) {
        const relativePath = path.relative(repoPath, ref.filePath);
        if (!referencesByFile[relativePath]) {
            referencesByFile[relativePath] = [];
        }
        referencesByFile[relativePath].push(ref);
    }


    for (const [file, refs] of Object.entries(referencesByFile)) {
        output.push(`Impacted file: ${file}`);
        refs.sort((a, b) => a.line - b.line);
        refs.forEach(ref => {
            // Ensure output uses lineText for the full line content
            output.push(`  - Line ${ref.line}: ${ref.lineText}`);
        });
    }

    if (output.length === 0) {
        return [`No references found for "${elementName}" outside of its definition file.`];
    }

    return output;
}



const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
});

const showImpactedCodeSchema = z.object({
    repoPath: z.string().describe('Absolute path to the repository root.'),
    filePath: z.string().describe('Path to the file containing the element, relative to repoPath.'),
    elementName: z.string().describe('Name of the element (function, method, class).'),
    elementType: z.enum(['function', 'method', 'class']).optional().describe('Optional type hint (function, method, class).'),
});

type ShowImpactedCodeParams = z.infer<typeof showImpactedCodeSchema>;

async function main() {
    console.error('Server main function started.'); // Added log
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const projectRoot = path.resolve(__dirname, '..');
        console.error('Project root:', projectRoot); // Added log

        console.error('Loading language parsers...'); // Added log
        languageConfigs = {}; // Initialize

        try {
            console.error('Loading TypeScript parser...');
            languageConfigs['.ts'] = {
                parser: (await import('tree-sitter-typescript')).default.typescript,
                // Revert to the simpler call_expression query
                referenceQuery: `(call_expression function: (identifier) @ref)`,
                definitionQuery: `
(function_declaration name: (identifier) @name)
(method_definition name: (property_identifier) @name)
`
            };
            console.error('TypeScript parser loaded.');
        } catch (e) {
            console.error('!!! FAILED TO LOAD TYPESCRIPT PARSER !!!', e);
        }

        try {
            console.error('Loading JavaScript parser...');
            languageConfigs['.js'] = {
                parser: (await import('tree-sitter-javascript')).default,
                // More specific query for function calls
                referenceQuery: `(call_expression function: (identifier) @ref)`,
                definitionQuery: `
(function_declaration name: (identifier) @name)
(method_definition name: (property_identifier) @name)
`
            };
            console.error('JavaScript parser loaded.');
        } catch (e) {
            console.error('!!! FAILED TO LOAD JAVASCRIPT PARSER !!!', e);
        }

        try {
            console.error('Loading Python parser...');
            languageConfigs['.py'] = {
                parser: (await import('tree-sitter-python')).default,
                 // Use specific query for function calls
                referenceQuery: `(call function: (identifier) @ref)`,
                definitionQuery: `
(function_definition name: (identifier) @name)
(class_definition name: (identifier) @name)
`
            };
            console.error('Python parser loaded.');
        } catch (e) {
            console.error('!!! FAILED TO LOAD PYTHON PARSER !!!', e);
        }

        try {
            console.error('Loading C# parser...');
            languageConfigs['.cs'] = {
                parser: (await import('tree-sitter-c-sharp')).default,
                // Query for invocation expressions, capturing the identifier within member access or directly
                referenceQuery: `
(invocation_expression
  function: [
    (identifier) @ref
    (member_access_expression
      name: (identifier) @ref
    )
  ]
)
`,

                definitionQuery: `
(method_declaration name: (identifier) @name)
(constructor_declaration name: (identifier) @name)
(class_declaration name: (identifier) @name)
`
            };
            console.error('C# parser loaded.');
        } catch (e) {
            console.error('!!! FAILED TO LOAD C# PARSER !!!', e);
        }

        console.error('All requested parsers loaded (or attempted).'); // Added log

        server.tool(
            TOOL_NAME,
            showImpactedCodeSchema.shape,
            async (params: ShowImpactedCodeParams /*, extra: RequestHandlerExtra */) => {
                console.error(`Tool '${TOOL_NAME}' called with params:`, params); // Added log
                try {
                    const result = await _findImpactedCode(params, languageConfigs);
                    console.error(`Tool '${TOOL_NAME}' result:`, result); // Added log
                    return {
                        content: [{ type: 'text', text: result.join('\\n') }]
                    };
                } catch (toolError) {
                    console.error(`!!! ERROR EXECUTING TOOL ${TOOL_NAME} !!!`, toolError);
                    // Re-throw as McpError or handle appropriately
                    throw new McpError(-32001, `Error executing tool ${TOOL_NAME}: ${toolError instanceof Error ? toolError.message : String(toolError)}`);
                }
            }
        );

        console.error('Tool registered. Creating StdioServerTransport...');
        // Combine declaration and initialization to ensure TypeScript recognizes the variable
        const transport = new StdioServerTransport();
        console.error('Transport created. Connecting server...');
        
        await server.connect(transport as any); // Use a type assertion to bypass type checking
        // This log indicates the server is *ready* and listening via stdio
        console.error(`${SERVER_NAME} v${SERVER_VERSION} started successfully and connected via stdio.`);

        console.error('Server setup complete. Process should remain active listening on stdio.');

    } catch (error) {
        console.error('!!! CRITICAL ERROR IN MAIN SETUP !!!:', error);
        process.exit(1); // Ensure process exits on critical setup failure
    }
}

process.on('uncaughtException', (error) => {
  console.error('!!! UNCAUGHT EXCEPTION !!!:', error);
  // Decide if the server should exit on uncaught exceptions
  // process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('!!! UNHANDLED REJECTION !!! Reason:', reason, 'Promise:', promise);
});

// Remove the CommonJS check and call main directly
main();


export default _findImpactedCode;

