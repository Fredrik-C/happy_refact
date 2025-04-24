import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
async function runTests() {
    let client;
    console.log('Starting MCP Test Client...');
    try {
        const command = 'node';
        const args = [path.resolve(process.cwd(), 'build/index.js')];
        console.log(`Attempting to start server with: ${command} ${args.join(' ')}`);
        // Instantiate transport with just command and args.
        // The type expected is StdioServerParameters, which defaults stderr to 'inherit'.
        const transport = new StdioClientTransport({ command, args });
        // Define client info
        const clientInfo = {
            name: 'happy-refact-test-client',
            version: '0.0.1',
        };
        // Instantiate the client using the constructor (no transport here)
        client = new Client(clientInfo);
        console.log('MCP Client instantiated. Connecting...');
        // Connect the client (initialization happens during connect)
        await client.connect(transport); // Pass transport here
        console.log('Client connected.');
        // Ensure client is initialized before proceeding (connect should handle this)
        // No need for the extra check here if connect() succeeds without error
        const repoPath = process.cwd();
        // Define expected paths once before the tests start
        const expectedTsPath = path.join('test-projects', 'typescript-sample', 'src', 'index.ts');
        const expectedPyPath = path.join('test-projects', 'python-sample', 'main.py');
        const expectedCsPath = path.join('test-projects', 'csharp-sample', 'Program.cs'); // Also define C# path here for consistency

        console.log('\n--- Testing TypeScript ---');
        const tsFilePath = path.join('test-projects', 'typescript-sample', 'src', 'greeter.ts');
        const tsElementName = 'greet';
        const tsArgs = { repoPath, filePath: tsFilePath, elementName: tsElementName, elementType: 'function' };
        console.log('Calling show_impacted_code with args:', tsArgs);
        // Pass tool name inside the object
        const tsResponse = await client.callTool({ name: 'show_impacted_code', arguments: tsArgs }); // No change needed here
        console.log('Response received:');
        console.dir(tsResponse, { depth: null });
        // Assert type before accessing content
        const typedTsResponse = tsResponse;
        const tsTextContent = typedTsResponse.content.find((c) => c.type === 'text')?.text || '';
        // Use the pre-defined expectedTsPath
        if (tsTextContent.includes(`Impacted file: ${expectedTsPath}`) && tsTextContent.includes('greet("World")')) {
            console.log('TypeScript Test: PASS');
        }
        else {
            console.error('TypeScript Test: FAIL - Expected reference not found.');
        }
        console.log('\n--- Testing Python ---');
        const pyFilePath = path.join('test-projects', 'python-sample', 'greeter.py');
        const pyElementName = 'greet';
        const pyArgs = { repoPath, filePath: pyFilePath, elementName: pyElementName, elementType: 'function' };
        console.log('Calling show_impacted_code with args:', pyArgs);
        // Pass tool name inside the object
        const pyResponse = await client.callTool({ name: 'show_impacted_code', arguments: pyArgs }); // No change needed here
        console.log('Response received:');
        console.dir(pyResponse, { depth: null });
        // Assert type before accessing content
        const typedPyResponse = pyResponse;
        const pyTextContent = typedPyResponse.content.find((c) => c.type === 'text')?.text || '';
        // Use the pre-defined expectedPyPath
        if (pyTextContent.includes(`Impacted file: ${expectedPyPath}`) && pyTextContent.includes('greet("World")')) {
            console.log('Python Test: PASS');
        }
        else {
            console.error('Python Test: FAIL - Expected reference not found.');
        }
        console.log('\n--- Testing C# ---');
        const csFilePath = path.join('test-projects', 'csharp-sample', 'Greeter.cs');
        const csElementName = 'GreetPerson';
        const csArgs = { repoPath, filePath: csFilePath, elementName: csElementName, elementType: 'method' };
        console.log('Calling show_impacted_code with args:', csArgs);
        // Pass tool name inside the object
        const csResponse = await client.callTool({ name: 'show_impacted_code', arguments: csArgs }); // No change needed here
        console.log('Response received:');
        console.dir(csResponse, { depth: null });
        // Assert type before accessing content
        const typedCsResponse = csResponse;
        const csTextContent = typedCsResponse.content.find((c) => c.type === 'text')?.text || '';
        // Use the pre-defined expectedCsPath
        if (csTextContent.includes(`Impacted file: ${expectedCsPath}`) && csTextContent.includes('greeterInstance.GreetPerson("Bob")')) {
            console.log('C# Test: PASS');
        }
        else {
            console.error(`C# Test: FAIL - Expected reference not found in ${expectedCsPath}.`);
            console.error(`Actual text content: ${csTextContent}`);
        }

        // --- Test Case 4: TypeScript Discount ---
        console.log('\n--- Testing TypeScript Discount ---');
        const tsFilePath2 = path.join('test-projects', 'typescript-sample', 'src', 'greeter.ts');
        const tsElementName2 = 'calculateDiscount';
        const tsArgs2 = { repoPath, filePath: tsFilePath2, elementName: tsElementName2, elementType: 'function' };
        console.log('Calling show_impacted_code with args:', tsArgs2);
        const tsResponse2 = await client.callTool({ name: 'show_impacted_code', arguments: tsArgs2 });
        console.log('Response received:');
        console.dir(tsResponse2, { depth: null });
        const tsTextContent2 = tsResponse2.content.find((c) => c.type === 'text')?.text || '';
        // Use the pre-defined expectedTsPath
        if (tsTextContent2.includes(`Impacted file: ${expectedTsPath}`) && tsTextContent2.includes('calculateDiscount(200, 15)')) {
            console.log('TypeScript Discount Test: PASS');
        } else {
            console.error('TypeScript Discount Test: FAIL - Expected reference not found.');
        }

        // --- Test Case 5: TypeScript SumNumbers ---
        console.log('\n--- Testing TypeScript SumNumbers ---');
        const tsElementName3 = 'sumNumbers';
        const tsArgs3 = { repoPath, filePath: tsFilePath2, elementName: tsElementName3, elementType: 'function' };
        console.log('Calling show_impacted_code with args:', tsArgs3);
        const tsResponse3 = await client.callTool({ name: 'show_impacted_code', arguments: tsArgs3 });
        console.log('Response received:');
        console.dir(tsResponse3, { depth: null });
        const tsTextContent3 = tsResponse3.content.find((c) => c.type === 'text')?.text || '';
        // Reuse expectedTsPath defined earlier if it's the same file
        if (tsTextContent3.includes(`Impacted file: ${expectedTsPath}`) && tsTextContent3.includes('sumNumbers(')) {
            console.log('TypeScript SumNumbers Test: PASS');
        } else {
            console.error('TypeScript SumNumbers Test: FAIL - Expected reference not found.');
        }

        // --- Test Case 6: C# Discount ---
        console.log('\n--- Testing C# Discount ---');
        const csElementName2 = 'CalculateDiscount';
        const csArgs2 = { repoPath, filePath: csFilePath, elementName: csElementName2, elementType: 'method' };
        console.log('Calling show_impacted_code with args:', csArgs2);
        const csResponse2 = await client.callTool({ name: 'show_impacted_code', arguments: csArgs2 });
        console.log('Response received:');
        console.dir(csResponse2, { depth: null });
        const csTextContent2 = csResponse2.content.find((c) => c.type === 'text')?.text || '';
        if (csTextContent2.includes(`Impacted file: ${expectedCsPath}`) && csTextContent2.includes('CalculateDiscount(')) {
            console.log('C# Discount Test: PASS');
        } else {
            console.error('C# Discount Test: FAIL - Expected reference not found.');
        }

        // --- Test Case 7: C# GenerateRange ---
        console.log('\n--- Testing C# GenerateRange ---');
        const csElementName3 = 'GenerateRange';
        const csArgs3 = { repoPath, filePath: csFilePath, elementName: csElementName3, elementType: 'method' };
        console.log('Calling show_impacted_code with args:', csArgs3);
        const csResponse3 = await client.callTool({ name: 'show_impacted_code', arguments: csArgs3 });
        console.log('Response received:');
        console.dir(csResponse3, { depth: null });
        const csTextContent3 = csResponse3.content.find((c) => c.type === 'text')?.text || '';
        if (csTextContent3.includes(`Impacted file: ${expectedCsPath}`) && csTextContent3.includes('GenerateRange(')) {
            console.log('C# GenerateRange Test: PASS');
        } else {
            console.error('C# GenerateRange Test: FAIL - Expected reference not found.');
        }

        // --- Test Case 8: Python Discount ---
        console.log('\n--- Testing Python Discount ---');
        const pyFilePath2 = path.join('test-projects', 'python-sample', 'greeter.py');
        const pyElementName2 = 'calculate_discount';
        const pyArgs2 = { repoPath, filePath: pyFilePath2, elementName: pyElementName2, elementType: 'function' };
        console.log('Calling show_impacted_code with args:', pyArgs2);
        const pyResponse2 = await client.callTool({ name: 'show_impacted_code', arguments: pyArgs2 });
        console.log('Response received:');
        console.dir(pyResponse2, { depth: null });
        const pyTextContent2 = pyResponse2.content.find((c) => c.type === 'text')?.text || '';
        // Reuse expectedPyPath defined earlier
        if (pyTextContent2.includes(`Impacted file: ${expectedPyPath}`) && pyTextContent2.includes('calculate_discount(')) {
            console.log('Python Discount Test: PASS');
        } else {
            console.error('Python Discount Test: FAIL - Expected reference not found.');
        }

        // --- Test Case 9: Python SumNumbers ---
        console.log('\n--- Testing Python SumNumbers ---');
        const pyElementName3 = 'sum_numbers';
        const pyArgs3 = { repoPath, filePath: pyFilePath2, elementName: pyElementName3, elementType: 'function' };
        console.log('Calling show_impacted_code with args:', pyArgs3);
        const pyResponse3 = await client.callTool({ name: 'show_impacted_code', arguments: pyArgs3 });
        console.log('Response received:');
        console.dir(pyResponse3, { depth: null });
        const pyTextContent3 = pyResponse3.content.find((c) => c.type === 'text')?.text || '';
        // Reuse expectedPyPath defined earlier
        if (pyTextContent3.includes(`Impacted file: ${expectedPyPath}`) && pyTextContent3.includes('sum_numbers(')) {
            console.log('Python SumNumbers Test: PASS');
        } else {
            console.error('Python SumNumbers Test: FAIL - Expected reference not found.');
        }
    }
    catch (error) {
        console.error('\n--- Test Run Failed ---');
        console.error(error);
    }
    finally {
        if (client) {
            console.log('\nClosing MCP Client...');
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
