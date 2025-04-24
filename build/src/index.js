import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod'; // Import zod for schema definition
import Parser from 'tree-sitter';
import fsPromises from 'node:fs/promises'; // Keep async fs for main logic
import path from 'node:path';
import ignore from 'ignore';
import { fileURLToPath } from 'node:url';
// Language objects will be assigned in main() after Parser.init()
// Removed top-level language imports and declarations
// --- Constants ---
const SERVER_NAME = 'happy_refact';
const SERVER_VERSION = '0.2.0'; // Updated version for rewrite
const TOOL_NAME = 'show_impacted_code';
const IGNORE_PATTERNS = ['.git', '.env', '.vs']; // Always ignore these
// --- Tree-sitter Setup ---
const parser = new Parser();
// Language configs will be initialized in main() after Parser.init()
let languageConfigs;
// --- File System Utilities ---
async function getGitignorePatterns(repoPath) {
    const gitignorePath = path.join(repoPath, '.gitignore');
    try {
        const content = await fsPromises.readFile(gitignorePath, 'utf-8'); // Use async fsPromises
        return content.split(/\r?\n/).filter(line => line.trim() !== '' && !line.startsWith('#'));
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return []; // No .gitignore file found
        }
        console.error(`Error reading .gitignore at ${gitignorePath}:`, error);
        return [];
    }
}
async function* listFilesRecursively(dir, ig) {
    try {
        const dirents = await fsPromises.readdir(dir, { withFileTypes: true }); // Use async fsPromises
        for (const dirent of dirents) {
            const fullPath = path.join(dir, dirent.name);
            const relativePath = path.relative(path.dirname(dir), fullPath); // Use relative path for ignore check
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
        return null; // Cannot extract signature without a definition query
    }
    // Use instanceof or check a unique property if direct comparison fails across environments
    // For now, rely on the fact that the parser object itself is passed
    // A more robust solution might involve a language identifier property on LanguageConfig
    // Check if the parser is the C# parser
    // This comparison might need refinement depending on the exact object structure
    // provided by the dynamically required native bindings.
    // A safer approach might be to add a 'languageId' property to LanguageConfig.
    // For now, let's assume direct object comparison works or find a unique property.
    // The `language` property on the parser object might be a string identifier.
    // Let's try comparing the `language.name` property if available.
    const parserName = langConfig.parser?.language?.name;
    if (parserName === 'c-sharp') {
        const methodNameNode = node.childForFieldName('name');
        const parameterListNode = node.childForFieldName('parameter_list');
        if (methodNameNode && parameterListNode) {
            const parameterTypes = [];
            // Iterate through parameter nodes and extract their types
            for (const paramNode of parameterListNode.namedChildren) {
                if (paramNode.type === 'parameter') {
                    const typeNode = paramNode.childForFieldName('type');
                    if (typeNode) {
                        parameterTypes.push(typeNode.text);
                    }
                    else {
                        // Handle cases with implicit types or 'var'
                        parameterTypes.push('unknown');
                    }
                }
            }
            return { name: methodNameNode.text, parameterTypes };
        }
    }
    else if (parserName === 'typescript') {
        // Handle TypeScript function and method definitions
        const methodNameNode = node.childForFieldName('name');
        const parametersNode = node.childForFieldName('parameters'); // For function_declaration and method_definition
        if (methodNameNode && parametersNode) {
            const parameterTypes = [];
            // Iterate through parameter nodes (required_parameter, optional_parameter, rest_parameter)
            for (const paramNode of parametersNode.namedChildren) {
                if (paramNode.type === 'required_parameter' || paramNode.type === 'optional_parameter') {
                    const typeNode = paramNode.childForFieldName('type');
                    if (typeNode) {
                        parameterTypes.push(typeNode.text);
                    }
                    else {
                        // Handle cases with implicit 'any' or no type annotation
                        parameterTypes.push('any'); // Assuming 'any' if no type is specified in TS
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
    // Use instanceof or check a unique property if direct comparison fails across environments
    // For now, rely on the fact that the parser object itself is passed
    // A more robust solution might involve a language identifier property on LanguageConfig
    // Check if the parser is the C# parser
    // This comparison might need refinement depending on the exact object structure
    // provided by the dynamically required native bindings.
    // A safer approach might be to add a 'languageId' property to LanguageConfig.
    // For now, let's assume direct object comparison works or find a unique property.
    // The `language` property on the parser object might be a string identifier.
    // Let's try comparing the `language.name` property if available.
    const parserName = langConfig.parser?.language?.name;
    if (parserName === 'c-sharp') {
        // For C#, check if the reference node is an invocation_expression and compare name and argument types
        if (referenceNode.type === 'invocation_expression') {
            const invokedMethodNameNode = referenceNode.childForFieldName('function')?.childForFieldName('name');
            const argumentListNode = referenceNode.childForFieldName('arguments');
            if (invokedMethodNameNode && argumentListNode) {
                // Check if method names match
                if (definitionSignature.name !== invokedMethodNameNode.text) {
                    return false;
                }
                const argumentNodes = argumentListNode.namedChildren.filter(n => n.type !== ',' && n.type !== '(' && n.type !== ')');
                // Check if parameter count matches argument count
                if (definitionSignature.parameterTypes.length !== argumentNodes.length) {
                    return false;
                }
                // --- Detailed C# Argument Type Checking (Approximation) ---
                // This is a simplified check based on the argument node's type or text.
                // A full implementation would require resolving the actual types of expressions.
                for (let i = 0; i < argumentNodes.length; i++) {
                    const argumentNode = argumentNodes[i];
                    const definitionParameterType = definitionSignature.parameterTypes[i];
                    // Basic type comparison based on node type or text
                    let argumentTypeApproximation = 'unknown';
                    if (argumentNode.type === 'string_literal') {
                        argumentTypeApproximation = 'string';
                    }
                    else if (argumentNode.type === 'number_literal') {
                        // C# has different numeric types, this is a simplification
                        argumentTypeApproximation = 'int'; // or 'double', 'float', etc.
                    }
                    else if (argumentNode.type === 'boolean_literal') {
                        argumentTypeApproximation = 'bool';
                    }
                    else if (argumentNode.type === 'object_creation_expression') {
                        // Attempt to get the type name from object creation
                        const typeNode = argumentNode.childForFieldName('type');
                        if (typeNode) {
                            argumentTypeApproximation = typeNode.text;
                        }
                    }
                    else if (argumentNode.type === 'identifier') {
                        // Cannot determine type from identifier alone without symbol resolution
                        argumentTypeApproximation = 'identifier'; // Placeholder
                    }
                    // TODO: Add more cases for other C# expression types
                    // Simple string comparison of approximated types (case-insensitive for basic types)
                    if (definitionParameterType.toLowerCase() !== argumentTypeApproximation.toLowerCase() && argumentTypeApproximation !== 'unknown' && argumentTypeApproximation !== 'identifier') {
                        // This comparison is very basic and will fail for many cases.
                        // It's a starting point but highlights the need for proper type resolution.
                        console.warn(`Approximated type mismatch for C# argument ${i}: Expected ${definitionParameterType}, got approximation ${argumentTypeApproximation}`);
                        // return false; // Uncomment for strict type checking based on approximation
                    }
                }
                // --- End C# Argument Type Checking ---
                return true; // Match based on name, count, and basic approximated type check
            }
        }
    }
    else if (parserName === 'typescript') {
        // For TypeScript, check if the reference node is a call_expression and compare name and argument types
        if (referenceNode.type === 'call_expression') {
            const invokedFunctionNameNode = referenceNode.childForFieldName('function')?.childForFieldName('name');
            const argumentListNode = referenceNode.childForFieldName('arguments');
            if (invokedFunctionNameNode && argumentListNode) {
                // Check if function names match
                if (definitionSignature.name !== invokedFunctionNameNode.text) {
                    return false;
                }
                const argumentNodes = argumentListNode.namedChildren.filter(n => n.type !== ',' && n.type !== '(' && n.type !== ')');
                // Check if parameter count matches argument count
                if (definitionSignature.parameterTypes.length !== argumentNodes.length) {
                    return false;
                }
                // --- Detailed TypeScript Argument Type Checking (Approximation) ---
                // This is a simplified check based on the argument node's type or text.
                // A full implementation would require resolving the actual types of expressions.
                for (let i = 0; i < argumentNodes.length; i++) {
                    const argumentNode = argumentNodes[i];
                    const definitionParameterType = definitionSignature.parameterTypes[i];
                    // Basic type comparison based on node type or text
                    let argumentTypeApproximation = 'unknown';
                    if (argumentNode.type === 'string_literal') {
                        argumentTypeApproximation = 'string';
                    }
                    else if (argumentNode.type === 'number') { // TypeScript number literal type
                        argumentTypeApproximation = 'number';
                    }
                    else if (argumentNode.type === 'boolean') { // TypeScript boolean literal type
                        argumentTypeApproximation = 'boolean';
                    }
                    else if (argumentNode.type === 'object') { // Basic object literal
                        argumentTypeApproximation = 'object';
                    }
                    else if (argumentNode.type === 'array') { // Basic array literal
                        argumentTypeApproximation = 'array';
                    }
                    else if (argumentNode.type === 'new_expression') {
                        // Attempt to get the type name from new expression
                        const typeNode = argumentNode.childForFieldName('constructor');
                        if (typeNode) {
                            argumentTypeApproximation = typeNode.text;
                        }
                    }
                    else if (argumentNode.type === 'identifier') {
                        // Cannot determine type from identifier alone without symbol resolution
                        argumentTypeApproximation = 'identifier'; // Placeholder
                    }
                    // TODO: Add more cases for other TypeScript expression types
                    // Simple string comparison of approximated types (case-sensitive for TS types)
                    if (definitionParameterType !== argumentTypeApproximation && argumentTypeApproximation !== 'unknown' && argumentTypeApproximation !== 'identifier') {
                        // This comparison is very basic and will fail for many cases.
                        // It's a starting point but highlights the need for proper type resolution.
                        console.warn(`Approximated type mismatch for TS argument ${i}: Expected ${definitionParameterType}, got approximation ${argumentTypeApproximation}`);
                        // return false; // Uncomment for strict type checking based on approximation
                    }
                }
                // --- End TypeScript Argument Type Checking ---
                return true; // Basic match based on name, count, and basic approximated type check
            }
        }
    }
    // Fallback to name match if signature info is not available or language not supported for full matching
    // This part might need adjustment based on how findReferencesInFile is updated
    return true; // Assuming name match is already handled by the query for now
}
async function findReferencesInFile(filePath, elementName, langConfig, definitionSignature // Parameter for definition signature info
) {
    const references = [];
    try {
        const fileContent = await fsPromises.readFile(filePath, 'utf-8'); // Use async fsPromises
        console.error(`[Debug] findReferencesInFile: Setting language to: ${langConfig.parser}`);
        parser.setLanguage(langConfig.parser);
        const tree = parser.parse(fileContent);
        // Log the exact query string before creating the query object
        const queryString = langConfig.referenceQuery;
        console.error(`[Debug] findReferencesInFile: Creating query for ${filePath} with string: "${queryString}"`);
        console.error(`[Debug] findReferencesInFile: Parser object:`, langConfig.parser);
        console.error(`[Debug] findReferencesInFile: Tree root node:`, tree.rootNode);
        console.error(`[Debug] findReferencesInFile: Query string before creating query: "${queryString}"`);
        console.error(`[Debug] findReferencesInFile: Parser object before creating query:`, langConfig.parser);
        const query = new Parser.Query(langConfig.parser, queryString);
        const allCaptures = query.captures(tree.rootNode);
        // Filter captures by element name in JavaScript
        const matches = allCaptures.filter(capture => capture.name === 'ref' && capture.node.text === elementName);
        for (const { node } of matches) { // Destructure node directly from the filtered matches
            // Add signature matching check here for C#/TS
            if (definitionSignature === null || signaturesMatch(definitionSignature, node, langConfig)) {
                references.push({
                    filePath: filePath,
                    line: node.startPosition.row + 1,
                    column: node.startPosition.column + 1,
                    text: node.text, // Or potentially a larger snippet of the line
                });
            }
        }
    }
    catch (error) {
        // Log the specific error occurring within findReferencesInFile
        console.error(`!!! ERROR in findReferencesInFile for ${filePath} !!!`);
        console.error(`Element Name: ${elementName}`);
        console.error(`Query String Used: "${langConfig?.referenceQuery}"`); // Log query string again in case it helps context
        console.error(error); // Log the full error object
        // Optionally re-throw or handle differently if needed, but logging is key for now
    }
    return references;
}
async function findReferencesFallback(filePath, elementName) {
    const references = [];
    try {
        const fileContent = await fsPromises.readFile(filePath, 'utf-8'); // Use async fsPromises
        const lines = fileContent.split(/\r?\n/);
        const regex = new RegExp(`\\b${elementName}\\b`, 'i'); // Case-insensitive text search
        lines.forEach((lineContent, index) => {
            let match;
            while ((match = regex.exec(lineContent)) !== null) {
                references.push({
                    filePath: filePath,
                    line: index + 1,
                    column: match.index + 1,
                    text: lineContent.trim(), // Return the whole line for context
                });
            }
        });
    }
    catch (error) {
        console.error(`Error performing fallback search in file ${filePath}:`, error);
    }
    return references;
}
// --- MCP Tool Handler ---
// Internal function containing the core logic
// Now accepts languageConfigs as a parameter
async function _findImpactedCode(args, initializedLanguageConfigs) {
    const { repoPath, filePath: definitionFilePathRelative, elementName } = args;
    const definitionFilePathAbsolute = path.resolve(repoPath, definitionFilePathRelative);
    // 1. List Files respecting .gitignore
    const ig = ignore().add(IGNORE_PATTERNS);
    const gitignoreRules = await getGitignorePatterns(repoPath);
    ig.add(gitignoreRules);
    const allImpactedReferences = [];
    // 2. Find the definition node and extract signature info from the definition file
    let definitionSignature = null;
    const definitionFileExt = path.extname(definitionFilePathAbsolute).toLowerCase();
    // Use the passed-in language configs
    const definitionLangConfig = initializedLanguageConfigs[definitionFileExt];
    if (definitionLangConfig && definitionLangConfig.definitionQuery) {
        try {
            const definitionFileContent = await fsPromises.readFile(definitionFilePathAbsolute, 'utf-8'); // Use async fsPromises
            console.error(`[Debug] _findImpactedCode: Setting language for definition file to: ${definitionLangConfig.parser}`);
            parser.setLanguage(definitionLangConfig.parser);
            const definitionTree = parser.parse(definitionFileContent);
            // Simplify query to remove the potentially problematic #eq? predicate
            // const definitionQuery = new Parser.Query(definitionLangConfig.parser, definitionLangConfig.definitionQuery!); // Add non-null assertion
            // console.warn(`[Debug] Definition query creation temporarily skipped in _findImpactedCode for ${definitionFilePathAbsolute}`);
            // const allDefinitionCaptures: Parser.QueryCapture[] = []; // Provide empty array
            const definitionQuery = new Parser.Query(definitionLangConfig.parser, definitionLangConfig.definitionQuery);
            const allDefinitionCaptures = definitionQuery.captures(definitionTree.rootNode);
            // Filter captures by element name in JavaScript
            const definitionMatches = allDefinitionCaptures.filter(capture => capture.name === 'name' && capture.node.text === elementName);
            // Assuming the first match is the correct definition for simplicity
            if (definitionMatches.length > 0) {
                // Use the node from the first filtered match
                definitionSignature = extractSignatureInfo(definitionMatches[0].node, definitionLangConfig);
            }
        }
        catch (error) {
            console.error(`Error finding or parsing definition file ${definitionFilePathAbsolute}:`, error);
        }
    }
    // 3. Iterate and Find References
    for await (const file of listFilesRecursively(repoPath, ig)) {
        // Skip the definition file itself
        if (path.resolve(file) === definitionFilePathAbsolute) {
            continue;
        }
        const ext = path.extname(file).toLowerCase();
        // Use the passed-in language configs
        const langConfig = initializedLanguageConfigs[ext];
        let fileReferences = [];
        if (langConfig) {
            console.error(`[Debug] _findImpactedCode: Found language config for ${ext}. Parser: ${langConfig.parser}`);
            // Use Tree-sitter
            fileReferences = await findReferencesInFile(file, elementName, langConfig, definitionSignature);
        }
        else {
            console.error(`[Debug] _findImpactedCode: No language config found for ${ext}. Skipping Tree-sitter.`);
            // Fallback text search for unsupported files (or potentially add more configs)
            // Consider if fallback should be applied only to specific extensions or all others
            // fileReferences = await findReferencesFallback(file, elementName);
            // For now, only process configured languages
        }
        allImpactedReferences.push(...fileReferences);
    }
    // 4. Format Output
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
            output.push(`  - Line ${ref.line}, Col ${ref.column}: ${ref.text}`); // Simple format
        });
    }
    if (output.length === 0) {
        return [`No references found for "${elementName}" outside of its definition file.`];
    }
    return output;
}
// --- MCP Server Setup ---
// Removed redundant handleShowImpactedCode function
// Instantiate server with name and version
const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
});
// Define the tool using server.tool
// Define the Zod schema separately to infer the type
const showImpactedCodeSchema = z.object({
    repoPath: z.string().describe('Absolute path to the repository root.'),
    filePath: z.string().describe('Path to the file containing the element, relative to repoPath.'),
    elementName: z.string().describe('Name of the element (function, method, class).'),
    elementType: z.enum(['function', 'method', 'class']).optional().describe('Optional type hint (function, method, class).'),
});
// Remove explicit request handlers for ListTools and CallTool, as the server handles them.
// --- Server Start ---
async function main() {
    // console.error('[Debug] >>>>>>>>>> main() function started <<<<<<<<<<'); // Remove some noise
    // Wrap entire main body in try-catch
    try {
        // Determine project root relative to the built file
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const projectRoot = path.resolve(__dirname, '..');
        // console.error('[Debug] Initializing Tree-sitter Parser...'); // Remove some noise
        // Initialize Tree-sitter Parser (important for WASM)
        // Cast to 'any' to bypass TS error TS2339 (Property 'init' does not exist)
        // Remove locateFile option and rely on default WASM loading
        // --- Temporarily comment out Parser.init() to test error source ---
        // console.error('[Debug] Initializing language configs...'); // Remove some noise
        console.error('[Debug] Initializing language configs with dynamically required parsers...');
        // Initialize languageConfigs with dynamically imported language objects
        languageConfigs = {
            '.ts': {
                parser: (await import('tree-sitter-typescript')).default.typescript,
                referenceQuery: `(call_expression function: (identifier) @ref)`,
                definitionQuery: `[(function_declaration name: (identifier) @name) (method_definition name: (property_identifier) @name)]`
            },
            '.js': {
                parser: (await import('tree-sitter-javascript')).default, // Default export
                referenceQuery: `(identifier) @ref`,
                definitionQuery: `[(function_declaration name: (identifier) @name) (method_definition name: (property_identifier) @name)]`
            },
            '.py': {
                parser: (await import('tree-sitter-python')).default, // Default export
                referenceQuery: `(identifier) @ref`,
                definitionQuery: `[(function_definition name: (identifier) @name) (class_definition name: (identifier) @name)]`
            },
            '.cs': {
                parser: (await import('tree-sitter-c-sharp')).default, // Default export
                referenceQuery: `[(identifier) @ref (invocation_expression name: (identifier) @ref)]`,
                definitionQuery: `[(method_declaration name: (identifier) @name) (constructor_declaration name: (identifier) @name) (class_declaration name: (identifier) @name)]`
            },
        };
        console.error('[Debug] Language configs initialized:', languageConfigs);
        console.error('[Debug] Language configs initialized.');
        // console.error('[Debug] Defining MCP tool...'); // Remove some noise
        // Define the tool AFTER languageConfigs is initialized
        server.tool(TOOL_NAME, 
        // Pass the schema SHAPE, not the ZodObject instance
        showImpactedCodeSchema.shape, 
        // Define the handler function (async) with the correct signature
        // It accesses languageConfigs via closure from the main() scope
        async (params /*, extra: RequestHandlerExtra */) => {
            // console.error(`[Debug] Tool handler invoked for ${TOOL_NAME} with params:`, params); // Remove some noise
            // The SDK handles input validation based on the Zod schema
            // The handler receives the validated parameters directly.
            // Call the internal logic function with validated arguments and the initialized configs
            const result = await _findImpactedCode(params, languageConfigs);
            // The handler should return an object with a 'content' property
            // containing an array of content parts (e.g., text).
            return {
                content: [{ type: 'text', text: result.join('\n') }] // Join the string array into a single text block
            };
        });
        // console.error('[Debug] MCP tool defined.'); // Remove some noise
        // console.error('[Debug] Connecting server transport...'); // Remove some noise
        // Connect the server to the transport
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error(`${SERVER_NAME} v${SERVER_VERSION} started successfully on stdio.`); // Log final success to stderr
    }
    catch (error) {
        // Catch any error during the entire main setup
        console.error('!!! CRITICAL ERROR IN MAIN SETUP !!!:', error);
        process.exit(1); // Exit forcefully if setup fails
    }
}
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Optionally exit or log more details
});
if (typeof require !== 'undefined' && require.main === module) {
    main();
}
// Export for testing purposes (optional, depending on test strategy)
// export { handleShowImpactedCode, listFilesRecursively };
// Export for testing purposes
export default _findImpactedCode; // Export the internal function as default for testing
