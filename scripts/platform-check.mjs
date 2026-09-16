// Brand labels and archived trace paths are not runtime dependencies.
export function hasPlatformDependency(text){
 return /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"][^'"\r\n]*chorify[^'"\r\n]*['"]/i.test(text)||text.includes('/api/'+'mcp');
}
