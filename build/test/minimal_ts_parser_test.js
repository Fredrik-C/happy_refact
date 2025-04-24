import Parser from 'tree-sitter';
async function runMinimalTest() {
    console.log('Starting minimal Tree-sitter TypeScript parser test...');
    console.log('Requiring tree-sitter-typescript...');
    const tsLanguage = (await import('tree-sitter-typescript')).default.typescript;
    console.log('tree-sitter-typescript required successfully.');
    console.log('Loaded TypeScript language object:', tsLanguage);
    console.log('Creating Parser instance...');
    const parser = new Parser();
    console.log('Parser instance created.');
    console.log('Setting language to TypeScript...');
    parser.setLanguage(tsLanguage);
    console.log('Language set successfully.');
    const sourceCode = 'function greet(name: string) { console.log("Hello, " + name); }';
    console.log(`Parsing source code: "${sourceCode}"`);
    const tree = parser.parse(sourceCode);
    console.log('Source code parsed successfully.');
    console.log('Syntax tree:', tree.rootNode.toString());
    console.log('Minimal test finished successfully.');
}
runMinimalTest().catch(err => {
    console.error('Unhandled error during minimal test execution:', err);
    process.exit(1);
});
