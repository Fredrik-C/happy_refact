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
import { z } from 'zod';
import Parser from 'tree-sitter';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import { fileURLToPath } from 'node:url';
const SERVER_NAME = 'happy_refact';
const SERVER_VERSION = '0.2.0';
const TOOL_NAME = 'show_impacted_code';
const IGNORE_PATTERNS = ['.git', '.env', '.vs', 'build', 'node_modules', '*.d.ts', 'src/**', 'test/**'];
const parser = new Parser();
let languageConfigs;
async function getGitignorePatterns(repoPath) {
    const gitignorePath = path.join(repoPath, '.gitignore');
    try {
        const content = await fsPromises.readFile(gitignorePath, 'utf-8');
        return content.split(/\r?\n/).filter(line => line.trim() !== '' && !line.startsWith('#'));
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        console.error(`Error reading .gitignore at ${gitignorePath}:`, error);
        return [];
    }
}
async function* listFilesRecursively(dir, ig) {
    try {
        const dirents = await fsPromises.readdir(dir, { withFileTypes: true });
        for (const dirent of dirents) {
            const fullPath = path.join(dir, dirent.name);
            const relativePath = path.relative(path.dirname(dir), fullPath);
            if (ig.ignores(relativePath)) {
                continue;
            }
            if (dirent.isDirectory()) {
                yield* listFilesRecursively(fullPath, ig);
            }
            else {
                yield fullPath;
            }
        }
    }
    catch (error) {
        console.error(`Error reading directory ${dir}:`, error);
    }
}
function extractSignatureInfo(node, langConfig) {
    if (!langConfig.definitionQuery) {
        return null;
    }
    const parserName = langConfig.parser?.language?.name;
    if (parserName === 'c-sharp') {
        const methodNameNode = node.childForFieldName('name');
        const parameterListNode = node.childForFieldName('parameter_list');
        if (methodNameNode && parameterListNode) {
            const parameterTypes = [];
            for (const paramNode of parameterListNode.namedChildren) {
                if (paramNode.type === 'parameter') {
                    const typeNode = paramNode.childForFieldName('type');
                    if (typeNode) {
                        parameterTypes.push(typeNode.text);
                    }
                    else {
                        parameterTypes.push('unknown');
                    }
                }
            }
            return { name: methodNameNode.text, parameterTypes };
        }
    }
    else if (parserName === 'typescript') {
        const parametersNode = node.childForFieldName('parameters');
        const methodNameNode = node.childForFieldName('name');
        if (methodNameNode && parametersNode) {
            const parameterTypes = [];
            for (const paramNode of parametersNode.namedChildren) {
                if (paramNode.type === 'required_parameter' || paramNode.type === 'optional_parameter') {
                    const typeNode = paramNode.childForFieldName('type');
                    if (typeNode) {
                        parameterTypes.push(typeNode.text);
                    }
                    else {
                        parameterTypes.push('any');
                    }
                }
                else if (paramNode.type === 'rest_parameter') {
                    const typeNode = paramNode.childForFieldName('type');
                    if (typeNode) {
                        parameterTypes.push(`...${typeNode.text}`); // Indicate rest parameter
                    }
                    else {
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
function signaturesMatch(definitionSignature, referenceNode, langConfig) {
    const parserName = langConfig.parser?.language?.name;
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
                    }
                    else if (argumentNode.type === 'number_literal') {
                        argumentTypeApproximation = 'int';
                    }
                    else if (argumentNode.type === 'boolean_literal') {
                        argumentTypeApproximation = 'bool';
                    }
                    else if (argumentNode.type === 'object_creation_expression') {
                        const typeNode = argumentNode.childForFieldName('type');
                        if (typeNode) {
                            argumentTypeApproximation = typeNode.text;
                        }
                    }
                    else if (argumentNode.type === 'identifier') {
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
    }
    else if (parserName === 'typescript') {
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
                    }
                    else if (argumentNode.type === 'number') {
                        argumentTypeApproximation = 'number';
                    }
                    else if (argumentNode.type === 'boolean') {
                        argumentTypeApproximation = 'boolean';
                    }
                    else if (argumentNode.type === 'object') {
                        argumentTypeApproximation = 'object';
                    }
                    else if (argumentNode.type === 'array') {
                        argumentTypeApproximation = 'array';
                    }
                    else if (argumentNode.type === 'new_expression') {
                        const typeNode = argumentNode.childForFieldName('constructor');
                        if (typeNode) {
                            argumentTypeApproximation = typeNode.text;
                        }
                    }
                    else if (argumentNode.type === 'identifier') {
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
async function findReferencesInFile(filePath, elementName, langConfig, definitionSignature) {
    const references = [];
    try {
        const fileContent = await fsPromises.readFile(filePath, 'utf-8');
        parser.setLanguage(langConfig.parser);
        const tree = parser.parse(fileContent);
        const queryString = langConfig.referenceQuery;
        let allCaptures = [];
        try {
            const query = new Parser.Query(langConfig.parser, queryString);
            allCaptures = query.captures(tree.rootNode);
        }
        catch (error) {
            console.error(`Query error for ${filePath}:`, error);
            const regex = new RegExp(`\\b${elementName}\\b`, 'i');
            fileContent.split(/\r?\n/).forEach((lineContent, index) => {
                let match;
                while ((match = regex.exec(lineContent)) !== null) {
                    references.push({
                        filePath: filePath,
                        line: index + 1,
                        column: match.index + 1,
                        text: lineContent.trim(),
                    });
                }
            });
            return references;
        }
        const matches = allCaptures.filter(capture => capture.name === 'ref' && capture.node.text === elementName);
        for (const { node } of matches) {
            if (definitionSignature === null || signaturesMatch(definitionSignature, node, langConfig)) {
                references.push({
                    filePath: filePath,
                    line: node.startPosition.row + 1,
                    column: node.startPosition.column + 1,
                    text: node.text,
                });
            }
        }
    }
    catch (error) {
        console.error(`Error in findReferencesInFile for ${filePath}:`, error);
        console.error(`Element Name: ${elementName}`);
        console.error(`Query String Used: "${langConfig?.referenceQuery}"`);
        console.error(error);
    }
    return references;
}
async function findReferencesFallback(filePath, elementName) {
    const references = [];
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
                    text: lineContent.trim(),
                });
            }
        });
    }
    catch (error) {
        console.error(`Error performing fallback search in file ${filePath}:`, error);
    }
    return references;
}
async function _findImpactedCode(args, initializedLanguageConfigs) {
    const { repoPath, filePath: definitionFilePathRelative, elementName } = args;
    const definitionFilePathAbsolute = path.resolve(repoPath, definitionFilePathRelative);
    const ig = ignore().add(IGNORE_PATTERNS);
    const gitignoreRules = await getGitignorePatterns(repoPath);
    ig.add(gitignoreRules);
    const allImpactedReferences = [];
    let definitionSignature = null;
    const definitionFileExt = path.extname(definitionFilePathAbsolute).toLowerCase();
    const definitionLangConfig = initializedLanguageConfigs[definitionFileExt];
    if (definitionLangConfig && definitionLangConfig.definitionQuery) {
        try {
            const definitionFileContent = await fsPromises.readFile(definitionFilePathAbsolute, 'utf-8');
            parser.setLanguage(definitionLangConfig.parser);
            const definitionTree = parser.parse(definitionFileContent);
            const definitionQuery = new Parser.Query(definitionLangConfig.parser, definitionLangConfig.definitionQuery);
            const allDefinitionCaptures = definitionQuery.captures(definitionTree.rootNode);
            const definitionMatches = allDefinitionCaptures.filter(capture => capture.name === 'name' && capture.node.text === elementName);
            if (definitionMatches.length > 0) {
                definitionSignature = extractSignatureInfo(definitionMatches[0].node, definitionLangConfig);
            }
        }
        catch (error) {
            console.error(`Error finding or parsing definition file ${definitionFilePathAbsolute}:`, error);
        }
    }
    for await (const file of listFilesRecursively(repoPath, ig)) {
        if (path.resolve(file) === definitionFilePathAbsolute) {
            continue;
        }
        const ext = path.extname(file).toLowerCase();
        const langConfig = initializedLanguageConfigs[ext];
        let fileReferences = [];
        if (langConfig) {
            fileReferences = await findReferencesInFile(file, elementName, langConfig, definitionSignature);
        }
        else {
        }
        allImpactedReferences.push(...fileReferences);
    }
    const output = [];
    const referencesByFile = {};
    for (const ref of allImpactedReferences) {
        const relativePath = path.relative(repoPath, ref.filePath);
        if (!referencesByFile[relativePath]) {
            referencesByFile[relativePath] = [];
        }
        referencesByFile[relativePath].push(ref);
    }
    for (const [file, refs] of Object.entries(referencesByFile)) {
        output.push(`Impacted file: ${file}`);
        refs.forEach(ref => {
            output.push(`  - Line ${ref.line}, Col ${ref.column}: ${ref.text}`);
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
async function main() {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const projectRoot = path.resolve(__dirname, '..');
        languageConfigs = {
            '.ts': {
                parser: (await import('tree-sitter-typescript')).default.typescript,
                referenceQuery: `(call_expression function: (identifier) @ref)`,
                definitionQuery: `
(function_declaration name: (identifier) @name)
(method_definition name: (property_identifier) @name)
`
            },
            '.js': {
                parser: (await import('tree-sitter-javascript')).default,
                referenceQuery: `(identifier) @ref`,
                definitionQuery: `
(function_declaration name: (identifier) @name)
(method_definition name: (property_identifier) @name)
`
            },
            '.py': {
                parser: (await import('tree-sitter-python')).default,
                referenceQuery: `(identifier) @ref`,
                definitionQuery: `
(function_definition name: (identifier) @name)
(class_definition name: (identifier) @name)
`
            },
            '.cs': {
                parser: (await import('tree-sitter-c-sharp')).default,
                referenceQuery: `
(identifier) @ref
(invocation_expression name: (identifier) @ref)
`,
                definitionQuery: `
(method_declaration name: (identifier) @name)
(constructor_declaration name: (identifier) @name)
(class_declaration name: (identifier) @name)
`
            },
        };
        server.tool(TOOL_NAME, showImpactedCodeSchema.shape, async (params /*, extra: RequestHandlerExtra */) => {
            const result = await _findImpactedCode(params, languageConfigs);
            return {
                content: [{ type: 'text', text: result.join('\n') }]
            };
        });
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error(`${SERVER_NAME} v${SERVER_VERSION} started successfully on stdio.`);
    }
    catch (error) {
        console.error('!!! CRITICAL ERROR IN MAIN SETUP !!!:', error);
        process.exit(1);
    }
}
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
if (typeof require !== 'undefined' && require.main === module) {
    main();
}
export default _findImpactedCode;
