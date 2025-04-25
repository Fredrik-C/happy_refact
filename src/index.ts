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
            return;
        }

        const cachedEntry = fileListCache.get(dir);

        if (cachedEntry && cachedEntry.mtimeMs === stats.mtimeMs) {
            dirents = cachedEntry.dirents;
        } else {
            dirents = await fsPromises.readdir(dir, { withFileTypes: true });
            fileListCache.set(dir, { dirents, mtimeMs: stats.mtimeMs });
        }
    } catch (error: any) {
        if (error.code !== 'ENOENT') {
            console.error(`Error accessing directory ${dir}:`, error);
        }
        return;
    }

    for (const dirent of dirents) {
        const fullPath = path.join(dir, dirent.name);
        const relativePath = path.relative(repoPath, fullPath);

        if (ig.ignores(relativePath)) {
            continue;
        }

        if (dirent.isDirectory()) {
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
                        parameterTypes.push(`...${typeNode.text}`);
                    } else {
                        parameterTypes.push('...any');
                    }
                }
            }
            return { name: methodNameNode.text, parameterTypes };
        }
    }
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
                    if (argumentNode.type === 'string_literal') argumentTypeApproximation = 'string';
                    else if (argumentNode.type === 'number_literal') argumentTypeApproximation = 'int';
                    else if (argumentNode.type === 'boolean_literal') argumentTypeApproximation = 'bool';
                    else if (argumentNode.type === 'object_creation_expression') {
                        const typeNode = argumentNode.childForFieldName('type');
                        if (typeNode) argumentTypeApproximation = typeNode.text;
                    } else if (argumentNode.type === 'identifier') argumentTypeApproximation = 'identifier';
                    if (definitionParameterType.toLowerCase() !== argumentTypeApproximation.toLowerCase() && argumentTypeApproximation !== 'unknown' && argumentTypeApproximation !== 'identifier') return false;
                }
                return true;
            }
        }
    } else if (parserName === 'typescript') {
        if (referenceNode.type === 'call_expression') {
            const invokedFunctionNameNode = referenceNode.childForFieldName('function')?.childForFieldName('name');
            const argumentListNode = referenceNode.childForFieldName('arguments');
            if (invokedFunctionNameNode && argumentListNode) {
                if (definitionSignature.name !== invokedFunctionNameNode.text) return false;
                const argumentNodes = argumentListNode.namedChildren.filter(n => n.type !== ',' && n.type !== '(' && n.type !== ')');
                if (definitionSignature.parameterTypes.length !== argumentNodes.length) return false;
                for (let i = 0; i < argumentNodes.length; i++) {
                    const argumentNode = argumentNodes[i];
                    const definitionParameterType = definitionSignature.parameterTypes[i];
                    let argumentTypeApproximation = 'unknown';
                    if (argumentNode.type === 'string_literal') argumentTypeApproximation = 'string';
                    else if (argumentNode.type === 'number') argumentTypeApproximation = 'number';
                    else if (argumentNode.type === 'boolean') argumentTypeApproximation = 'boolean';
                    else if (argumentNode.type === 'object') argumentTypeApproximation = 'object';
                    else if (argumentNode.type === 'array') argumentTypeApproximation = 'array';
                    else if (argumentNode.type === 'new_expression') {
                        const typeNode = argumentNode.childForFieldName('constructor');
                        if (typeNode) argumentTypeApproximation = typeNode.text;
                    } else if (argumentNode.type === 'identifier') argumentTypeApproximation = 'identifier';
                    if (definitionParameterType !== argumentTypeApproximation && argumentTypeApproximation !== 'unknown' && argumentTypeApproximation !== 'identifier') return false;
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
    let fileMtimeMs: number | undefined;

    try {
        const stats = await fsPromises.stat(filePath);
        fileMtimeMs = stats.mtimeMs;
        const cachedEntry = referenceCache.get(filePath);
        if (cachedEntry && cachedEntry.mtimeMs === fileMtimeMs && !definitionSignature) return cachedEntry.references;
    } catch {}

    try {
        const fileContent = await fsPromises.readFile(filePath, 'utf-8');
        lines = fileContent.split(/\r?\n/);
        if (currentParserLanguage !== langConfig.parser) {
            parser.setLanguage(langConfig.parser);
            currentParserLanguage = langConfig.parser;
        }
        const tree = parser.parse(fileContent);
        const query = compiledQueryCache.has(path.extname(filePath).toLowerCase()) ? compiledQueryCache.get(path.extname(filePath).toLowerCase())! : new Parser.Query(langConfig.parser, langConfig.referenceQuery);
        compiledQueryCache.set(path.extname(filePath).toLowerCase(), query);
        const matches = query.captures(tree.rootNode).filter(capture => capture.name === 'ref' && capture.node.text === elementName);
        for (const { node } of matches) {
            if (definitionSignature === null || signaturesMatch(definitionSignature, node, langConfig)) {
                const startPosition = node.startPosition;
                references.push({
                    filePath,
                    line: startPosition.row + 1,
                    column: startPosition.column + 1,
                    text: node.text,
                    lineText: lines[startPosition.row]?.trim() || node.text
                });
            }
        }
        if (fileMtimeMs !== undefined && !definitionSignature) referenceCache.set(filePath, { references, mtimeMs: fileMtimeMs });
    } catch (error) {
        console.error(error);
        const regex = new RegExp(`\\b${elementName}\\b`, 'i');
        lines.forEach((lineContent, index) => {
            let match;
            while ((match = regex.exec(lineContent)) !== null) {
                references.push({
                    filePath,
                    line: index + 1,
                    column: match.index + 1,
                    text: elementName,
                    lineText: lineContent.trim()
                });
            }
        });
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
                    filePath,
                    line: index + 1,
                    column: match.index + 1,
                    text: elementName,
                    lineText: lineContent.trim()
                });
            }
        });
    } catch (error) {
        console.error(error);
    }
    return references;
}



async function _findImpactedCode(
    args: { repoPath: string; filePath: string; elementName: string; elementType?: string },
    initializedLanguageConfigs: Record<string, LanguageConfig>
): Promise<string[]> {
    const { repoPath, filePath: definitionFilePathRelative, elementName } = args;
    const definitionFilePathAbsolute = path.resolve(repoPath, definitionFilePathRelative);
    const ig = ignore().add(IGNORE_PATTERNS).add(await getGitignorePatterns(repoPath));
    const startTime = Date.now();
    const TIMEOUT_MS = 10000;  // 10 seconds timeout
    const MAX_FILES = 20000;     // Limit to 100 files scanned to prevent memory issues
    const MATCH_LIMIT = 50;   // Limit to 50 matches to prevent excessive memory use
    let filesAnalyzed = 0;
    let noMatchFiles = 0;     // Counter for files with no matches
    const NO_MATCH_LIMIT = 10000; // Stop early if 50 files have no matches
    const allImpactedReferences: Reference[] = [];
    let definitionSignature: SignatureInfo | null = null;
    const definitionFileExt = path.extname(definitionFilePathAbsolute).toLowerCase();
    const definitionLangConfig = initializedLanguageConfigs[definitionFileExt];

    if (definitionLangConfig && definitionLangConfig.definitionQuery) {
        try {
            const definitionFileContent = await fsPromises.readFile(definitionFilePathAbsolute, 'utf-8');
            parser.setLanguage(definitionLangConfig.parser);
            const definitionTree = parser.parse(definitionFileContent);
            const definitionQuery = new Parser.Query(definitionLangConfig.parser, definitionLangConfig.definitionQuery);
            const definitionMatches = definitionQuery.captures(definitionTree.rootNode).filter(capture => capture.name === 'name' && capture.node.text === elementName);
            if (definitionMatches.length > 0) definitionSignature = extractSignatureInfo(definitionMatches[0].node, definitionLangConfig);
        } catch (error) {
            console.error(error);
        }
    }

    try {
        for await (const file of listFilesRecursively(repoPath, repoPath, ig)) {
            if (Date.now() - startTime > TIMEOUT_MS || filesAnalyzed >= MAX_FILES || noMatchFiles >= NO_MATCH_LIMIT || allImpactedReferences.length >= MATCH_LIMIT) {
                return formatPartialResults(allImpactedReferences, filesAnalyzed, repoPath);
            }
            filesAnalyzed++;
            if (path.resolve(file) === definitionFilePathAbsolute) continue;
            const ext = path.extname(file).toLowerCase();
            const langConfig = initializedLanguageConfigs[ext];
            if (langConfig) {
                const fileReferences = await findReferencesInFile(file, elementName, langConfig, definitionSignature);
                if (fileReferences.length === 0) {
                    noMatchFiles++;  // Increment if no matches found
                } else {
                    allImpactedReferences.push(...fileReferences.slice(0, MATCH_LIMIT - allImpactedReferences.length));  // Add only up to the limit
                }
                // Clear caches periodically to free memory
                if (filesAnalyzed % 10 === 0) {
                    referenceCache.clear();  // Clear reference cache every 10 files
                    compiledQueryCache.clear();  // Clear compiled query cache
                }
            }
        }
    } catch (error) {
        console.error(error);
        return formatPartialResults(allImpactedReferences, filesAnalyzed, repoPath);
    }

    const output: string[] = [];
    const referencesByFile: Record<string, Reference[]> = {};
    for (const ref of allImpactedReferences) {
        const relativePath = path.relative(repoPath, ref.filePath);
        if (!referencesByFile[relativePath]) referencesByFile[relativePath] = [];
        referencesByFile[relativePath].push(ref);
    }
    for (const [pathKey, refs] of Object.entries(referencesByFile)) {
        output.push(`Impacted file: ${pathKey}`);
        refs.sort((a, b) => a.line - b.line);
        refs.forEach(ref => output.push(`  - Line ${ref.line}: ${ref.lineText}`));
    }
    return output.length > 0 ? output : [`No references found for "${elementName}" outside of its definition file.`];
}

function formatPartialResults(references: Reference[], filesAnalyzed: number, repoPath: string): string[] {
    const partialOutput: string[] = [`Analysis stopped: ${filesAnalyzed} files analyzed (due to timeout, file limit, match limit, or no matches).`];
    const partialReferencesByFile: Record<string, Reference[]> = {};
    for (const ref of references) {
        const relativePath = path.relative(repoPath, ref.filePath);
        if (!partialReferencesByFile[relativePath]) partialReferencesByFile[relativePath] = [];
        partialReferencesByFile[relativePath].push(ref);
    }
    for (const [pathKey, refs] of Object.entries(partialReferencesByFile)) {
        partialOutput.push(`Impacted file: ${pathKey}`);
        refs.sort((a, b) => a.line - b.line);
        refs.forEach(ref => partialOutput.push(`  - Line ${ref.line}: ${ref.lineText}`));
    }
    return partialOutput;
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
    console.error('Server main function started.');
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const projectRoot = path.resolve(__dirname, '..');
        console.error('Project root:', projectRoot);
        console.error('Loading language parsers...');
        languageConfigs = {};
        try {
            console.error('Loading TypeScript parser...');
            languageConfigs['.ts'] = {
                parser: (await import('tree-sitter-typescript')).default.typescript,
                referenceQuery: `(call_expression function: (identifier) @ref)`,
                definitionQuery: `(function_declaration name: (identifier) @name)(method_definition name: (property_identifier) @name)`
            };
            console.error('TypeScript parser loaded.');
        } catch (e) { console.error('!!! FAILED TO LOAD TYPESCRIPT PARSER !!!', e); }
        try {
            console.error('Loading JavaScript parser...');
            languageConfigs['.js'] = {
                parser: (await import('tree-sitter-javascript')).default,
                referenceQuery: `(call_expression function: (identifier) @ref)`,
                definitionQuery: `(function_declaration name: (identifier) @name)(method_definition name: (property_identifier) @name)`
            };
            console.error('JavaScript parser loaded.');
        } catch (e) { console.error('!!! FAILED TO LOAD JAVASCRIPT PARSER !!!', e); }
        try {
            console.error('Loading Python parser...');
            languageConfigs['.py'] = {
                parser: (await import('tree-sitter-python')).default,
                referenceQuery: `(call function: (identifier) @ref)`,
                definitionQuery: `(function_definition name: (identifier) @name)(class_definition name: (identifier) @name)`
            };
            console.error('Python parser loaded.');
        } catch (e) { console.error('!!! FAILED TO LOAD PYTHON PARSER !!!', e); }
        try {
            console.error('Loading C# parser...');
            languageConfigs['.cs'] = {
                parser: (await import('tree-sitter-c-sharp')).default,
                referenceQuery: `(invocation_expression function: [(identifier) @ref (member_access_expression name: (identifier) @ref)])`,
                definitionQuery: `(method_declaration name: (identifier) @name)(constructor_declaration name: (identifier) @name)(class_declaration name: (identifier) @name)`
            };
            console.error('C# parser loaded.');
        } catch (e) { console.error('!!! FAILED TO LOAD C# PARSER !!!', e); }
        console.error('All requested parsers loaded (or attempted).');
        server.tool(TOOL_NAME, showImpactedCodeSchema.shape, async (params: ShowImpactedCodeParams) => {
            console.error(`Tool '${TOOL_NAME}' called with params:`, params);
            try {
                const result = await _findImpactedCode(params, languageConfigs);
                console.error(`Tool '${TOOL_NAME}' result:`, result);
                return { content: [{ type: 'text', text: result.join('\\n') }] };
            } catch (toolError) {
                console.error(`!!! ERROR EXECUTING TOOL ${TOOL_NAME} !!!`, toolError);
                throw new McpError(-32001, `Error executing tool ${TOOL_NAME}: ${toolError instanceof Error ? toolError.message : String(toolError)}`);
            }
        });
        console.error('Tool registered. Creating StdioServerTransport...');
        const transport = new StdioServerTransport();
        console.error('Transport created. Connecting server...');
        await server.connect(transport as any);
        console.error(`${SERVER_NAME} v${SERVER_VERSION} started successfully and connected via stdio.`);
        console.error('Server setup complete. Process should remain active listening on stdio.');
    } catch (error) {
        console.error('!!! CRITICAL ERROR IN MAIN SETUP !!!:', error);
        process.exit(1);
    }
}

process.on('uncaughtException', (error) => { console.error('!!! UNCAUGHT EXCEPTION !!!:', error); });
process.on('unhandledRejection', (reason, promise) => { console.error('!!! UNHANDLED REJECTION !!! Reason:', reason, 'Promise:', promise); });
main();
export default _findImpactedCode;
