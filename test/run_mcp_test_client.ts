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
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Implementation } from '@modelcontextprotocol/sdk/types.js';

interface ContentPart {
  type: string;
  text?: string;
}

interface McpResponse {
  content: ContentPart[];
}


async function runTests() {
  let client: any;
  console.log('Starting MCP Test Client...');

  try {
    const command = 'node';
    const args = [path.resolve(process.cwd(), 'build/src/index.js')]; // Corrected path
    console.log(`Attempting to start server with: ${command} ${args.join(' ')}`);

    const transport = new StdioClientTransport({ command, args });

    const clientInfo: Implementation = {
        name: 'happy-refact-test-client',
        version: '0.0.1',
    };

    client = new Client(clientInfo);
    console.log('MCP Client instantiated. Connecting...');
    await client.connect(transport);
    console.log('Client connected.');

    const repoPath = process.cwd();

    console.log('\n--- Testing TypeScript ---');
    const tsFilePath = path.join('test-projects', 'typescript-sample', 'src', 'greeter.ts');
    const tsElementName = 'greet';
    const tsArgs = { repoPath, filePath: tsFilePath, elementName: tsElementName, elementType: 'function' };
    console.log('Calling show_impacted_code with args:', tsArgs);
    const tsResponse = await client.callTool({ name: 'show_impacted_code', arguments: tsArgs });
    console.log('Response received:');
    console.dir(tsResponse, { depth: null });
    const typedTsResponse = tsResponse as McpResponse;
    const tsTextContent = typedTsResponse.content.find((c: ContentPart) => c.type === 'text')?.text || '';
    const expectedTsPath = path.join('test-projects', 'typescript-sample', 'src', 'index.ts');
    if (tsTextContent.includes(`Impacted file: ${expectedTsPath}`) && tsTextContent.includes('greet("World")')) {
      console.log('TypeScript Test: PASS');
    } else {
      console.error('TypeScript Test: FAIL - Expected reference not found.');
      console.error(`Actual text content: ${tsTextContent}`);
    }

    console.log('\n--- Testing Python ---');
    const pyFilePath = path.join('test-projects', 'python-sample', 'greeter.py');
    const pyElementName = 'greet';
    const pyArgs = { repoPath, filePath: pyFilePath, elementName: pyElementName, elementType: 'function' };
    console.log('Calling show_impacted_code with args:', pyArgs);
    const pyResponse = await client.callTool({ name: 'show_impacted_code', arguments: pyArgs });
    console.log('Response received:');
    console.dir(pyResponse, { depth: null });
    const typedPyResponse = pyResponse as McpResponse;
    const pyTextContent = typedPyResponse.content.find((c: ContentPart) => c.type === 'text')?.text || '';
    const expectedPyPath = path.join('test-projects', 'python-sample', 'main.py');
    if (pyTextContent.includes(`Impacted file: ${expectedPyPath}`) && pyTextContent.includes('greet("World")')) {
      console.log('Python Test: PASS');
    } else {
      console.error('Python Test: FAIL - Expected reference not found.');
      console.error(`Actual text content: ${pyTextContent}`);
    }

    console.log('\n--- Testing C# ---');
    const csFilePath = path.join('test-projects', 'csharp-sample', 'SubFolder', 'Greeter.cs');
    const csElementName = 'GreetPerson';
    const csArgs = { repoPath, filePath: csFilePath, elementName: csElementName, elementType: 'method' };
    console.log('Calling show_impacted_code with args:', csArgs);
    const csResponse = await client.callTool({ name: 'show_impacted_code', arguments: csArgs });
    console.log('Response received:');
    console.dir(csResponse, { depth: null });
    const typedCsResponse = csResponse as McpResponse;
    const csTextContent = typedCsResponse.content.find((c: ContentPart) => c.type === 'text')?.text || '';
    const expectedCsPath = path.join('test-projects', 'csharp-sample', 'Program.cs');
    if (csTextContent.includes(`Impacted file: ${expectedCsPath}`) && csTextContent.includes('GreetPerson("Bob")')) {
      console.log('C# Test: PASS');
    } else {
      console.error(`C# Test: FAIL - Expected reference not found in ${expectedCsPath}.`);
      console.error(`Actual text content: ${csTextContent}`);
    }

    // --- Testing Red Herrings ---

    console.log('\n--- Testing TypeScript Red Herring ---');
    const tsRhFilePath = path.join('test-projects', 'typescript-sample', 'src', 'redherring.ts');
    const tsRhElementName = 'greetPerson'; // Assuming this is the red herring function
    const tsRhArgs = { repoPath, filePath: tsRhFilePath, elementName: tsRhElementName, elementType: 'function' };
    console.log('Calling show_impacted_code with args:', tsRhArgs);
    const tsRhResponse = await client.callTool({ name: 'show_impacted_code', arguments: tsRhArgs });
    console.log('Response received:');
    console.dir(tsRhResponse, { depth: null });
    const typedTsRhResponse = tsRhResponse as McpResponse;
    const tsRhTextContent = typedTsRhResponse.content.find((c: ContentPart) => c.type === 'text')?.text || '';
    if (!tsRhTextContent.includes('Impacted file:')) {
      console.log('TypeScript Red Herring Test: PASS - No impacted files found as expected.');
    } else {
      console.error('TypeScript Red Herring Test: FAIL - Unexpected impacted files found.');
      console.error(`Actual text content: ${tsRhTextContent}`);
    }

    console.log('\n--- Testing Python Red Herring ---');
    const pyRhFilePath = path.join('test-projects', 'python-sample', 'redherring.py');
    const pyRhElementName = 'greet_person'; // Assuming this is the red herring function
    const pyRhArgs = { repoPath, filePath: pyRhFilePath, elementName: pyRhElementName, elementType: 'function' };
    console.log('Calling show_impacted_code with args:', pyRhArgs);
    const pyRhResponse = await client.callTool({ name: 'show_impacted_code', arguments: pyRhArgs });
    console.log('Response received:');
    console.dir(pyRhResponse, { depth: null });
    const typedPyRhResponse = pyRhResponse as McpResponse;
    const pyRhTextContent = typedPyRhResponse.content.find((c: ContentPart) => c.type === 'text')?.text || '';
    if (!pyRhTextContent.includes('Impacted file:')) {
      console.log('Python Red Herring Test: PASS - No impacted files found as expected.');
    } else {
      console.error('Python Red Herring Test: FAIL - Unexpected impacted files found.');
      console.error(`Actual text content: ${pyRhTextContent}`);
    }

    console.log('\n--- Testing C# Red Herring ---');
    const csRhFilePath = path.join('test-projects', 'csharp-sample', 'SubFolder', 'RedHerring.cs');
    // Reverting to test GreetPerson - the fix in src/index.ts should handle this correctly now
    const csRhElementName = 'GreetPerson';
    const csRhArgs = { repoPath, filePath: csRhFilePath, elementName: csRhElementName, elementType: 'method' };
    console.log('Calling show_impacted_code with args:', csRhArgs);
    const csRhResponse = await client.callTool({ name: 'show_impacted_code', arguments: csRhArgs });
    console.log('Response received:');
    console.dir(csRhResponse, { depth: null });
    const typedCsRhResponse = csRhResponse as McpResponse;
    const csRhTextContent = typedCsRhResponse.content.find((c: ContentPart) => c.type === 'text')?.text || '';
    // Expecting no impacted files for this unique, unused method
    if (!csRhTextContent.includes('Impacted file:')) {
        console.log('C# Red Herring Test: PASS - No impacted files found as expected.');
    } else {
        console.error('C# Red Herring Test: FAIL - Unexpected impacted files found.');
        console.error(`Actual text content: ${csRhTextContent}`);
    }

  } catch (error) {
    console.error('\nTest Run Failed');
    console.error(error);
  } finally {
    if (client) {
      console.log('\nClosing MCP Client');
      await client.close();
      console.log('Client closed.');
    }
  }
}

runTests().then(() => {
  console.log('\nTest script finished.');
}).catch(err => {
  console.error('Unhandled error during test execution:', err);
  process.exit(1);
});
