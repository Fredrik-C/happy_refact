import { StdioClientTransport, McpClient } from '@modelcontextprotocol/sdk';
async function runTest() {
    const transport = new StdioClientTransport();
    const client = new McpClient(transport);
    try {
        await client.connect();
        console.log('MCP client connected.');
        // Example tool call (replace with actual tool name and arguments)
        const toolResult = await client.callTool({
            serverName: 'happy_refact', // Replace with actual server name if different
            toolName: 'show_impacted_code', // Replace with actual tool name
            arguments: {
                repoPath: '.', // Replace with actual repo path
                filePath: 'src/index.ts', // Replace with actual file path
                elementName: 'handleShowImpactedCode' // Replace with actual element name
            }
        });
        console.log('Tool call successful:', toolResult);
    }
    catch (error) {
        console.error('Error during MCP client test:', error);
    }
    finally {
        client.disconnect();
        console.log('MCP client disconnected.');
    }
}
runTest();
