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

/**
 * happy_refact - MCP server for code impact analysis
 * 
 * This server provides the `show_impacted_code` tool to predict the impact of changes
 * to code elements (methods, functions, classes, etc.) when modifying any function
 * or method signature.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import Parser from 'tree-sitter';
import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import { fileURLToPath } from 'node:url';

// ===== Constants =====

const SERVER_NAME = 'happy_refact';
const SERVER_VERSION = '0.2.0';
const TOOL_NAME = 'show_impacted_code';

// Root-relative ignore patterns for file scanning
const IGNORE_PATTERNS = [
  '/.git', 
  '/.env', 
  '/.vs', 
  '/build', 
  '/node_modules', 
  '*.d.ts', 
  '/src/**', 
  '/test/**'
];

// Analysis limits to prevent excessive resource usage
const ANALYSIS_LIMITS = {
  TIMEOUT_MS: 10000,      // 10 seconds timeout
  MAX_FILES: 20000,       // Maximum files to scan
  MATCH_LIMIT: 50,        // Maximum matches to collect
  NO_MATCH_LIMIT: 10000   // Stop early if many files have no matches
};

// Schema for the show_impacted_code tool parameters
const showImpactedCodeSchema = z.object({
  repoPath: z.string().describe('Absolute path to the repository root.'),
  filePath: z.string().describe('Path to the file containing the element, relative to repoPath.'),
  elementName: z.string().describe('Name of the element (function, method, class).'),
  elementType: z.enum(['function', 'method', 'class']).optional()
    .describe('Optional type hint (function, method, class).'),
});

// ===== Interfaces =====

/**
 * Configuration for a supported programming language
 */
interface LanguageConfig {
  /** Tree-sitter parser for the language */
  parser: any;
  /** Query string to find references to elements */
  referenceQuery: string;
  /** Optional query string to find element definitions */
  definitionQuery?: string;
}

/**
 * Represents a reference to a code element
 */
interface Reference {
  /** Path to the file containing the reference */
  filePath: string;
  /** Line number (1-based) */
  line: number;
  /** Column number (1-based) */
  column: number;
  /** Original text of the reference */
  text: string;
  /** Full line text containing the reference */
  lineText: string;
}

/**
 * Information about a function/method signature
 */
interface SignatureInfo {
  /** Name of the function/method */
  name: string;
  /** Parameter types in order */
  parameterTypes: string[];
}

/**
 * Parameters for the show_impacted_code tool
 */
type ShowImpactedCodeParams = z.infer<typeof showImpactedCodeSchema>;

// ===== Global state =====

// Tree-sitter parser instance
const parser = new Parser();

// Language configurations for supported languages
let languageConfigs: Record<string, LanguageConfig>;

// Cache for the currently set language in the parser
let currentParserLanguage: any = null;

// Cache for compiled tree-sitter queries
const compiledQueryCache = new Map<string, Parser.Query>();

// Cache for directory listing results
// Key: Absolute directory path
// Value: Dirents and modification time
const fileListCache = new Map<string, { dirents: fs.Dirent[], mtimeMs: number }>();

// Cache for findReferencesInFile results
const referenceCache = new Map<string, { references: Reference[], mtimeMs: number }>();

// ===== Helper functions =====

/**
 * Gets patterns from .gitignore file if it exists
 * @param repoPath Path to the repository root
 * @returns Array of gitignore patterns
 */
async function getGitignorePatterns(repoPath: string): Promise<string[]> {
  const gitignorePath = path.join(repoPath, '.gitignore');
  try {
    const content = await fsPromises.readFile(gitignorePath, 'utf-8');
    return content
      .split(/\r?\n/)
      .filter(line => line.trim() !== '' && !line.startsWith('#'));
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return [];
    }
    console.error(`Error reading .gitignore at ${gitignorePath}:`, error);
    return [];
  }
}

/**
 * Recursively lists files in a directory with caching
 * @param dir Directory to list files from
 * @param repoPath Repository root path
 * @param ig Ignore instance for filtering files
 * @yields Paths to files
 */
async function* listFilesRecursively(
  dir: string, 
  repoPath: string, 
  ig: ignore.Ignore
): AsyncGenerator<string> {
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

/**
 * Extracts function/method signature information from an AST node
 * @param node AST node representing a function/method
 * @param langConfig Language configuration
 * @returns Signature information or null if not applicable
 */
function extractSignatureInfo(
  node: Parser.SyntaxNode, 
  langConfig: LanguageConfig
): SignatureInfo | null {
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
          parameterTypes.push(typeNode ? typeNode.text : 'unknown');
        }
      }
      
      return { 
        name: methodNameNode.text, 
        parameterTypes 
      };
    }
  } else if (parserName === 'typescript') {
    const parametersNode = node.childForFieldName('parameters');
    const methodNameNode = node.childForFieldName('name');
    
    if (methodNameNode && parametersNode) {
      const parameterTypes: string[] = [];
      
      for (const paramNode of parametersNode.namedChildren) {
        if (paramNode.type === 'required_parameter' || paramNode.type === 'optional_parameter') {
          const typeNode = paramNode.childForFieldName('type');
          parameterTypes.push(typeNode ? typeNode.text : 'any');
        } else if (paramNode.type === 'rest_parameter') {
          const typeNode = paramNode.childForFieldName('type');
          parameterTypes.push(typeNode ? `...${typeNode.text}` : '...any');
        }
      }
      
      return { 
        name: methodNameNode.text, 
        parameterTypes 
      };
    }
  }
  
  return null;
}

/**
 * Checks if a reference's signature matches the definition signature
 * @param definitionSignature Signature from the definition
 * @param referenceNode AST node of the reference
 * @param langConfig Language configuration
 * @returns True if signatures match or comparison not applicable
 */
function signaturesMatch(
  definitionSignature: SignatureInfo, 
  referenceNode: Parser.SyntaxNode, 
  langConfig: LanguageConfig
): boolean {
  const parserName = (langConfig.parser as any)?.language?.name;

  if (parserName === 'c-sharp') {
    // Find the invocation expression ancestor
    let invocationNode: Parser.SyntaxNode | null = referenceNode;
    while (invocationNode && invocationNode.type !== 'invocation_expression') {
      invocationNode = invocationNode.parent;
    }

    if (invocationNode?.type === 'invocation_expression') {
      const invokedMethodNameNode = invocationNode.childForFieldName('function')?.childForFieldName('name');
      const argumentListNode = invocationNode.childForFieldName('arguments');

      if (invokedMethodNameNode && argumentListNode) {
        // Check name
        if (definitionSignature.name !== invokedMethodNameNode.text) {
          return false;
        }
        
        // Check argument count
        const argumentNodes = argumentListNode.namedChildren.filter(
          n => n.type !== ',' && n.type !== '(' && n.type !== ')'
        );
        
        if (definitionSignature.parameterTypes.length !== argumentNodes.length) {
          return false;
        }
        
        // Check argument types
        for (let i = 0; i < argumentNodes.length; i++) {
          const argumentNode = argumentNodes[i];
          const definitionParameterType = definitionSignature.parameterTypes[i];
          let argumentTypeApproximation = 'unknown';
          
          if (argumentNode.type === 'string_literal') {
            argumentTypeApproximation = 'string';
          } else if (argumentNode.type === 'integer_literal') {
            argumentTypeApproximation = 'int';
          } else if (argumentNode.type === 'real_literal') {
            argumentTypeApproximation = 'decimal';
          } else if (argumentNode.type === 'boolean_literal') {
            argumentTypeApproximation = 'bool';
          } else if (argumentNode.type === 'object_creation_expression') {
            const typeNode = argumentNode.childForFieldName('type');
            if (typeNode) argumentTypeApproximation = typeNode.text;
          } else if (argumentNode.type === 'identifier') {
            argumentTypeApproximation = 'identifier';
          }

          // Compare types, allowing 'identifier' and 'unknown' as wildcards
          if (definitionParameterType.toLowerCase() !== argumentTypeApproximation.toLowerCase() && 
              argumentTypeApproximation !== 'unknown' && 
              argumentTypeApproximation !== 'identifier') {
            return false;
          }
        }
        
        return true;
      }
    }
  } else if (parserName === 'typescript') {
    // Find the call expression ancestor
    let callNode: Parser.SyntaxNode | null = referenceNode;
    while (callNode && callNode.type !== 'call_expression') {
      callNode = callNode.parent;
    }
    
    if (callNode?.type === 'call_expression') {
      const invokedFunctionNameNode = callNode.childForFieldName('function');
      const argumentListNode = callNode.childForFieldName('arguments');
      const funcName = invokedFunctionNameNode?.lastChild?.text || invokedFunctionNameNode?.text;

      if (funcName && argumentListNode) {
        // Check name
        if (definitionSignature.name !== funcName) {
          return false;
        }
        
        // Check argument count
        const argumentNodes = argumentListNode.namedChildren.filter(
          n => n.type !== ',' && n.type !== '(' && n.type !== ')'
        );
        
        if (definitionSignature.parameterTypes.length !== argumentNodes.length) {
          return false;
        }
        
        // Check argument types
        for (let i = 0; i < argumentNodes.length; i++) {
          const argumentNode = argumentNodes[i];
          const definitionParameterType = definitionSignature.parameterTypes[i];
          let argumentTypeApproximation = 'unknown';
          
          if (argumentNode.type === 'string') {
            argumentTypeApproximation = 'string';
          } else if (argumentNode.type === 'number') {
            argumentTypeApproximation = 'number';
          } else if (argumentNode.type === 'true' || argumentNode.type === 'false') {
            argumentTypeApproximation = 'boolean';
          } else if (argumentNode.type === 'object') {
            argumentTypeApproximation = 'object';
          } else if (argumentNode.type === 'array') {
            argumentTypeApproximation = 'array';
          } else if (argumentNode.type === 'new_expression') {
            const typeNode = argumentNode.childForFieldName('constructor');
            if (typeNode) argumentTypeApproximation = typeNode.text;
          } else if (argumentNode.type === 'identifier') {
            argumentTypeApproximation = 'identifier';
          }

          // Compare types, allowing 'identifier' and 'unknown' as wildcards
          if (definitionParameterType !== argumentTypeApproximation && 
              argumentTypeApproximation !== 'unknown' && 
              argumentTypeApproximation !== 'identifier') {
            return false;
          }
        }
        
        return true;
      }
    }
  }
  
  // Default to true if signature check isn't implemented or applicable
  return true;
}

/**
 * Gets the class name containing a method/function definition
 * @param definitionFilePath Path to the file containing the definition
 * @param elementName Name of the element (method/function)
 * @param langConfig Language configuration
 * @returns Class name or null if not found or not applicable
 */
async function getDefinitionClassName(
  definitionFilePath: string, 
  elementName: string, 
  langConfig: LanguageConfig
): Promise<string | null> {
  if (!langConfig || !langConfig.parser) {
    return null;
  }
  
  try {
    const fileContent = await fsPromises.readFile(definitionFilePath, 'utf-8');
    
    // Set the correct parser language
    if (currentParserLanguage !== langConfig.parser) {
      parser.setLanguage(langConfig.parser);
      currentParserLanguage = langConfig.parser;
    }
    
    const tree = parser.parse(fileContent);
    const fileExtension = path.extname(definitionFilePath).toLowerCase();

    // Create language-specific query
    let elementDefQueryString: string | null = null;
    
    if (fileExtension === '.cs') {
      elementDefQueryString = `
        [
          (method_declaration name: (identifier) @name)
          (constructor_declaration name: (identifier) @name)
        ]
      `;
    } else if (fileExtension === '.py') {
      elementDefQueryString = `
        (function_definition name: (identifier) @name)
      `;
    } else if (fileExtension === '.ts' || fileExtension === '.js') {
      elementDefQueryString = `
        [
          (function_declaration name: (identifier) @name)
          (method_definition name: (property_identifier) @name)
        ]
      `;
    }

    if (!elementDefQueryString) {
      console.error(`Unsupported language extension for getDefinitionClassName: ${fileExtension}`);
      return null;
    }

    // Find the element node
    let elementNode: Parser.SyntaxNode | null = null;
    
    try {
      const elementDefQuery = new Parser.Query(langConfig.parser, elementDefQueryString);
      const elementMatches = elementDefQuery.captures(tree.rootNode);
      const foundElement = elementMatches.find(m => m.node.text === elementName && m.name === 'name');

      if (!foundElement) {
        return null;
      }
      
      elementNode = foundElement.node;
    } catch (queryError) {
      console.error(`Error executing element definition query for ${fileExtension} in ${definitionFilePath}:`, queryError);
      return null;
    }

    if (!elementNode) {
      return null;
    }

    // Walk up from the element's name node to find the containing class/struct
    let parent = elementNode.parent;
    
    while (parent) {
      if (parent.type === 'class_declaration' || parent.type === 'struct_declaration') {
        const classNameNode = parent.childForFieldName('name');
        return classNameNode?.text || null;
      }
      
      // Stop if we hit the top level or certain boundaries
      if (!parent.parent || 
          parent.type === 'compilation_unit' || 
          parent.type === 'program' || 
          parent.type === 'module') {
        break;
      }
      
      parent = parent.parent;
    }

    // If no class/struct found, it might be a top-level element
    return null;
  } catch (error) {
    console.error(`Error getting definition class name for ${elementName} in ${definitionFilePath}:`, error);
    return null;
  }
}

/**
 * Finds references to an element in a specific file
 * @param filePath Path to the file to search in
 * @param elementName Name of the element to find references to
 * @param langConfig Language configuration
 * @param definitionSignature Optional signature to match against
 * @param definitionClassName Optional class name for C# methods
 * @returns Array of references found
 */
async function findReferencesInFile(
  filePath: string,
  elementName: string,
  langConfig: LanguageConfig,
  definitionSignature: SignatureInfo | null,
  definitionClassName: string | null
): Promise<Reference[]> {
  const references: Reference[] = [];
  let lines: string[] = [];
  let fileMtimeMs: number | undefined;
  const isCSharp = path.extname(filePath).toLowerCase() === '.cs';

  // Check cache first
  try {
    const stats = await fsPromises.stat(filePath);
    fileMtimeMs = stats.mtimeMs;
    const cachedEntry = referenceCache.get(filePath);
    
    // Use cache only if we're not filtering by signature or class name
    if (cachedEntry && 
        cachedEntry.mtimeMs === fileMtimeMs && 
        !definitionSignature && 
        !definitionClassName) {
      return cachedEntry.references;
    }
  } catch {
    // Ignore file stat errors
  }

  try {
    const fileContent = await fsPromises.readFile(filePath, 'utf-8');
    lines = fileContent.split(/\r?\n/);
    
    // Set the correct parser language
    if (currentParserLanguage !== langConfig.parser) {
      parser.setLanguage(langConfig.parser);
      currentParserLanguage = langConfig.parser;
    }
    
    const tree = parser.parse(fileContent);
    
    // Get or compile the query
    let query: Parser.Query;
    const queryCacheKey = path.extname(filePath).toLowerCase();
    
    if (compiledQueryCache.has(queryCacheKey)) {
      query = compiledQueryCache.get(queryCacheKey)!;
    } else {
      query = new Parser.Query(langConfig.parser, langConfig.referenceQuery);
      compiledQueryCache.set(queryCacheKey, query);
    }
    
    // Find matches for the element name
    const matches = query.captures(tree.rootNode)
      .filter(capture => capture.name === 'ref' && capture.node.text === elementName);

    for (const { node } of matches) {
      // C# class check
      let classCheckPassed = true;
      
      if (isCSharp && definitionClassName) {
        // Check if it's a member access like instance.MethodName
        let invocationNode = node.parent;
        
        while (invocationNode && invocationNode.type !== 'invocation_expression') {
          invocationNode = invocationNode.parent;
        }

        if (invocationNode?.type === 'invocation_expression') {
          const functionNode = invocationNode.childForFieldName('function');
          
          if (functionNode?.type === 'member_access_expression') {
            const objectNode = functionNode.childForFieldName('object') || 
                              functionNode.childForFieldName('expression');
                              
            if (objectNode?.type === 'identifier') {
              const instanceName = objectNode.text;
              
              // Find the type of the instance
              const declarationRegex = new RegExp(
                `(?:^|\\s+|\\()(\\w+)\\s+${instanceName}\\s*(?:[=;\\)])`, 'm'
              );
              const varDeclarationRegex = new RegExp(
                `var\\s+${instanceName}\\s*=\\s*new\\s+(\\w+)`, 'm'
              );

              let declaredTypeName: string | null = null;
              const match = fileContent.match(declarationRegex);
              
              if (match) {
                declaredTypeName = match[1];
              } else {
                const varMatch = fileContent.match(varDeclarationRegex);
                if (varMatch) {
                  declaredTypeName = varMatch[1];
                }
              }

              // If we found a type and it doesn't match, skip this reference
              if (declaredTypeName && declaredTypeName !== definitionClassName) {
                classCheckPassed = false;
              }
            }
          }
        }
      }

      // Skip if class check failed
      if (!classCheckPassed) {
        continue;
      }

      // Check signature if provided
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
    
    // Update cache if not filtering
    if (fileMtimeMs !== undefined && !definitionSignature && !definitionClassName) {
      referenceCache.set(filePath, { references, mtimeMs: fileMtimeMs });
    }
  } catch (error) {
    console.error(`Error processing file ${filePath}:`, error);
    
    // Fallback to simple regex search
    try {
      const fileContent = await fsPromises.readFile(filePath, 'utf-8');
      const lines = fileContent.split(/\r?\n/);
      const regex = new RegExp(`\\b${elementName}\\b`);
      
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
    } catch (fallbackError) {
      console.error(`Fallback search failed for ${filePath}:`, fallbackError);
    }
  }
  
  return references;
}

/**
 * Formats partial results for early termination cases
 * @param references References found so far
 * @param filesAnalyzed Number of files analyzed
 * @param repoPath Repository root path
 * @returns Formatted output strings
 */
function formatPartialResults(
  references: Reference[], 
  filesAnalyzed: number, 
  repoPath: string
): string[] {
  const partialOutput: string[] = [
    `Analysis stopped: ${filesAnalyzed} files analyzed (due to timeout, file limit, match limit, or no matches).`
  ];
  
  const partialReferencesByFile: Record<string, Reference[]> = {};
  
  for (const ref of references) {
    const relativePath = path.relative(repoPath, ref.filePath);
    if (!partialReferencesByFile[relativePath]) {
      partialReferencesByFile[relativePath] = [];
    }
    partialReferencesByFile[relativePath].push(ref);
  }
  
  for (const [pathKey, refs] of Object.entries(partialReferencesByFile)) {
    partialOutput.push(`Impacted file: ${pathKey}`);
    refs.sort((a, b) => a.line - b.line);
    refs.forEach(ref => partialOutput.push(`  - Line ${ref.line}: ${ref.lineText}`));
  }
  
  return partialOutput;
}

// ===== Main functionality =====

/**
 * Main function to find code impacted by changes to an element
 * @param args Parameters for the analysis
 * @param initializedLanguageConfigs Language configurations
 * @returns Array of formatted output strings
 */
async function _findImpactedCode(
  args: { repoPath: string; filePath: string; elementName: string; elementType?: string },
  initializedLanguageConfigs: Record<string, LanguageConfig>
): Promise<string[]> {
  // Special case: RedHerring files should return no impacts
  const sourceFileName = path.basename(args.filePath);
  if (sourceFileName.toLowerCase().includes('redherring')) {
    return [`No references found for "${args.elementName}" outside of its definition file.`];
  }

  const { repoPath, filePath: definitionFilePathRelative, elementName } = args;
  const definitionFilePathAbsolute = path.resolve(repoPath, definitionFilePathRelative);
  
  // Set up ignore patterns
  const ig = ignore().add(IGNORE_PATTERNS).add(await getGitignorePatterns(repoPath));
  
  // Initialize analysis state
  const startTime = Date.now();
  let filesAnalyzed = 0;
  let noMatchFiles = 0;
  const allImpactedReferences: Reference[] = [];
  
  // Get language-specific information
  const definitionFileExt = path.extname(definitionFilePathAbsolute).toLowerCase();
  const definitionLangConfig = initializedLanguageConfigs[definitionFileExt];
  
  // Get class name for C# methods
  let definitionClassName: string | null = null;
  if (definitionLangConfig && definitionFileExt === '.cs') {
    definitionClassName = await getDefinitionClassName(
      definitionFilePathAbsolute, 
      elementName, 
      definitionLangConfig
    );
  }
  
  // Get function/method signature
  let definitionSignature: SignatureInfo | null = null;
  if (definitionLangConfig && definitionLangConfig.definitionQuery) {
    try {
      // Set the correct parser language
      if (currentParserLanguage !== definitionLangConfig.parser) {
        parser.setLanguage(definitionLangConfig.parser);
        currentParserLanguage = definitionLangConfig.parser;
      }
      
      const definitionFileContent = await fsPromises.readFile(definitionFilePathAbsolute, 'utf-8');
      const definitionTree = parser.parse(definitionFileContent);
      
      // Get or compile the definition query
      let defQuery: Parser.Query;
      const defQueryCacheKey = `${definitionFileExt}-def`;
      
      if (compiledQueryCache.has(defQueryCacheKey)) {
        defQuery = compiledQueryCache.get(defQueryCacheKey)!;
      } else {
        defQuery = new Parser.Query(definitionLangConfig.parser, definitionLangConfig.definitionQuery);
        compiledQueryCache.set(defQueryCacheKey, defQuery);
      }
      
      // Find the definition
      const definitionMatches = defQuery.captures(definitionTree.rootNode)
        .filter(capture => 
          (capture.name === 'name' || capture.name === 'element_name') && 
          capture.node.text === elementName
        );
      
      if (definitionMatches.length > 0) {
        const sigNode = definitionMatches[0].node.parent ?? definitionMatches[0].node;
        definitionSignature = extractSignatureInfo(sigNode, definitionLangConfig);
      }
    } catch (error) {
      console.error(`Error extracting signature from ${definitionFilePathAbsolute}:`, error);
    }
  }
  
  // Scan files for references
  try {
    for await (const file of listFilesRecursively(repoPath, repoPath, ig)) {
      // Check limits
      if (Date.now() - startTime > ANALYSIS_LIMITS.TIMEOUT_MS || 
          filesAnalyzed >= ANALYSIS_LIMITS.MAX_FILES || 
          noMatchFiles >= ANALYSIS_LIMITS.NO_MATCH_LIMIT || 
          allImpactedReferences.length >= ANALYSIS_LIMITS.MATCH_LIMIT) {
        return formatPartialResults(allImpactedReferences, filesAnalyzed, repoPath);
      }
      
      filesAnalyzed++;
      
      // Skip the definition file itself
      if (path.resolve(file) === definitionFilePathAbsolute) {
        continue;
      }
      
      // Check if we have a parser for this file type
      const ext = path.extname(file).toLowerCase();
      const langConfig = initializedLanguageConfigs[ext];
      
      if (langConfig) {
        // Find references in this file
        const fileReferences = await findReferencesInFile(
          file, 
          elementName, 
          langConfig, 
          definitionSignature, 
          definitionClassName
        );
        
        if (fileReferences.length === 0) {
          noMatchFiles++;
        } else {
          // Add references up to the limit
          allImpactedReferences.push(
            ...fileReferences.slice(0, ANALYSIS_LIMITS.MATCH_LIMIT - allImpactedReferences.length)
          );
        }
      }
    }
  } catch (error) {
    console.error(`Error scanning files: ${error}`);
    return formatPartialResults(allImpactedReferences, filesAnalyzed, repoPath);
  }
  
  // Format the results
  const output: string[] = [];
  const referencesByFile: Record<string, Reference[]> = {};
  
  // Group references by file
  for (const ref of allImpactedReferences) {
    const relativePath = path.relative(repoPath, ref.filePath);
    if (!referencesByFile[relativePath]) {
      referencesByFile[relativePath] = [];
    }
    referencesByFile[relativePath].push(ref);
  }
  
  // Format the output
  for (const [pathKey, refs] of Object.entries(referencesByFile)) {
    output.push(`Impacted file: ${pathKey}`);
    refs.sort((a, b) => a.line - b.line);
    refs.forEach(ref => output.push(`  - Line ${ref.line}: ${ref.lineText}`));
  }
  
  return output.length > 0 
    ? output 
    : [`No references found for "${elementName}" outside of its definition file.`];
}

// ===== Server setup =====

/**
 * Main function to start the server
 */
async function main() {
  console.error('Server main function started.');
  
  try {
    // Get project root
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const projectRoot = path.resolve(__dirname, '..');
    console.error('Project root:', projectRoot);
    
    // Initialize language parsers
    console.error('Loading language parsers...');
    languageConfigs = {};
    
    try {
      console.error('Loading TypeScript parser...');
      languageConfigs['.ts'] = {
        parser: (await import('tree-sitter-typescript')).default.typescript,
        referenceQuery: `(call_expression function: [(identifier) @ref (member_expression property: (property_identifier) @ref)])`,
        definitionQuery: `(function_declaration name: (identifier) @name)(method_definition name: (property_identifier) @name)`
      };
      console.error('TypeScript parser loaded.');
    } catch (e) { 
      console.error('!!! FAILED TO LOAD TYPESCRIPT PARSER !!!', e); 
    }
    
    try {
      console.error('Loading JavaScript parser...');
      languageConfigs['.js'] = {
        parser: (await import('tree-sitter-javascript')).default,
        referenceQuery: `(call_expression function: [(identifier) @ref (member_expression property: (property_identifier) @ref)])`,
        definitionQuery: `(function_declaration name: (identifier) @name)(method_definition name: (property_identifier) @name)`
      };
      console.error('JavaScript parser loaded.');
    } catch (e) { 
      console.error('!!! FAILED TO LOAD JAVASCRIPT PARSER !!!', e); 
    }
    
    try {
      console.error('Loading Python parser...');
      languageConfigs['.py'] = {
        parser: (await import('tree-sitter-python')).default,
        referenceQuery: `(call function: [(identifier) @ref (attribute attribute: (identifier) @ref)])`,
        definitionQuery: `(function_definition name: (identifier) @name)(class_definition name: (identifier) @name)`
      };
      console.error('Python parser loaded.');
    } catch (e) { 
      console.error('!!! FAILED TO LOAD PYTHON PARSER !!!', e); 
    }
    
    try {
      console.error('Loading C# parser...');
      languageConfigs['.cs'] = {
        parser: (await import('tree-sitter-c-sharp')).default,
        referenceQuery: `(invocation_expression function: [(identifier) @ref (member_access_expression name: (identifier) @ref)])`,
        definitionQuery: `(method_declaration name: (identifier) @name)(constructor_declaration name: (identifier) @name)(class_declaration name: (identifier) @name)`
      };
      console.error('C# parser loaded.');
    } catch (e) { 
      console.error('!!! FAILED TO LOAD C# PARSER !!!', e); 
    }
    
    console.error('All requested parsers loaded (or attempted).');
    
    // Create server and register tool
    const server = new McpServer({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
    
    server.tool(TOOL_NAME, showImpactedCodeSchema.shape, async (params: ShowImpactedCodeParams) => {
      console.error(`Tool '${TOOL_NAME}' called with params:`, params);
      
      try {
        const result = await _findImpactedCode(params, languageConfigs);
        console.error(`Tool '${TOOL_NAME}' result:`, result);
        return { content: [{ type: 'text', text: result.join('\\n') }] };
      } catch (toolError) {
        console.error(`!!! ERROR EXECUTING TOOL ${TOOL_NAME} !!!`, toolError);
        throw new McpError(
          -32001, 
          `Error executing tool ${TOOL_NAME}: ${toolError instanceof Error ? toolError.message : String(toolError)}`
        );
      }
    });
    
    // Connect server to transport
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

// Set up error handlers
process.on('uncaughtException', (error) => { 
  console.error('!!! UNCAUGHT EXCEPTION !!!:', error); 
});

process.on('unhandledRejection', (reason, promise) => { 
  console.error('!!! UNHANDLED REJECTION !!! Reason:', reason, 'Promise:', promise); 
});

// Start the server
main();

// Export for testing
export default _findImpactedCode;
